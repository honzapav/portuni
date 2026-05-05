// Tauri host for Portuni. Spawns the bundled Node sidecar (the desktop
// HTTP backend) on startup, parses the port it announces on stdout,
// stashes it in app state, and also emits a `backend-ready` event the
// React frontend may listen to. Frontend code is expected to call the
// `get_backend_port` command first and only fall back to the event if
// the port isn't set yet — events that fire before a listener is
// registered are otherwise lost.

use std::path::PathBuf;
use std::sync::Mutex;

use log::{error, info, warn};
use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct SidecarState(Mutex<Option<CommandChild>>);
struct BackendPort(Mutex<Option<u16>>);
struct AuthToken(String);

#[derive(Default, Serialize, Deserialize, Clone)]
struct DesktopConfig {
    /// Optional libSQL URL. When unset, defaults to a file: URL inside
    /// PORTUNI_DATA_DIR. Leave the file: variant for purely local use,
    /// set a libsql:// URL to point the desktop at a Turso database.
    #[serde(default)]
    turso_url: Option<String>,
    #[serde(default)]
    turso_auth_token: Option<String>,
}

fn config_path(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("config.json")
}

fn load_config(data_dir: &PathBuf) -> DesktopConfig {
    let path = config_path(data_dir);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn random_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

#[tauri::command]
fn get_backend_port(state: tauri::State<BackendPort>) -> Option<u16> {
    let port = *state.0.lock().unwrap();
    info!("get_backend_port -> {port:?}");
    port
}

#[tauri::command]
fn get_auth_token(state: tauri::State<AuthToken>) -> String {
    state.0.clone()
}

fn spawn_sidecar(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir).ok();
    let data_dir_str = data_dir.to_string_lossy().to_string();
    info!("spawn_sidecar: data_dir={data_dir_str}");

    let config = load_config(&data_dir);
    let turso_url = config.turso_url.unwrap_or_default();
    let turso_token = config.turso_auth_token.unwrap_or_default();
    info!(
        "config: turso_url={} turso_auth_token={}",
        if turso_url.is_empty() { "<unset>" } else { "<set>" },
        if turso_token.is_empty() { "<unset>" } else { "<set>" },
    );

    // Auth token: if the configured TURSO_URL is remote (libsql://), the
    // backend's auth gate refuses to boot without PORTUNI_AUTH_TOKEN. Even
    // for purely local mode it's a small extra defense against other
    // local processes hitting the loopback port — generate a fresh
    // 48-char random token per launch and pipe it to both the sidecar
    // (env) and the frontend (Tauri command).
    let auth_token = app.state::<AuthToken>().0.clone();

    // Tauri's webview ships requests from a non-loopback origin that the
    // backend's default allowlist doesn't know about. Pass the Tauri
    // origins explicitly so the middleware admits them.
    let allowed_origins = [
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ]
    .join(",");

    // The Bun-compiled sidecar's `require("@libsql/${target}")` is a
    // dynamic call, so Bun did not bundle the native binding into the
    // single-file output. At runtime Bun walks up from cwd looking for
    // `node_modules/@libsql/<target>/`. Without setting cwd here, a
    // .app launched from Finder runs with cwd=/ and the require fails
    // with `Cannot find module`. scripts/build-sidecar.mjs stages the
    // platform packages into src-tauri/sidecar-deps/ which Tauri ships
    // as `bundle.resources`; at runtime they land under
    // <Resources>/sidecar-deps/node_modules/@libsql/<target>/.
    let resource_dir = app.path().resource_dir()?;
    let sidecar_cwd = resource_dir.join("sidecar-deps");
    if !sidecar_cwd.exists() {
        warn!(
            "sidecar-deps dir missing at {:?} — sidecar may fail to load native bindings",
            sidecar_cwd,
        );
    }

    // tauri-plugin-shell 2.x's env_clear() does not reliably scrub the
    // parent env on macOS — additionally force-empty the variables we
    // don't want leaking from a developer's varlock-loaded shell.
    let (mut rx, child) = app
        .shell()
        .sidecar("portuni-sidecar")?
        .current_dir(sidecar_cwd)
        .env_clear()
        .env("PORTUNI_DATA_DIR", data_dir_str)
        .env("PORTUNI_PORT", "0")
        .env("PORTUNI_AUTH_TOKEN", auth_token)
        .env("TURSO_URL", turso_url)
        .env("TURSO_AUTH_TOKEN", turso_token)
        .env("PORTUNI_ALLOWED_ORIGINS", allowed_origins)
        .env("PORTUNI_LOG_REQUESTS", "1")
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .spawn()?;

    app.state::<SidecarState>().0.lock().unwrap().replace(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).into_owned();
                    let line = line.trim_end_matches(|c| c == '\n' || c == '\r');
                    if let Some(rest) = line.strip_prefix("PORTUNI_LISTENING_PORT=") {
                        if let Ok(port) = rest.trim().parse::<u16>() {
                            handle
                                .state::<BackendPort>()
                                .0
                                .lock()
                                .unwrap()
                                .replace(port);
                            let _ = handle.emit("backend-ready", port);
                            info!("sidecar backend ready on port {port}");
                        }
                    } else if let Some(rest) = line.strip_prefix("PORTUNI_BACKEND_ERROR=") {
                        // Sidecar surfaced a startup error in a structured form
                        // (e.g. database unreachable). Emit it to the frontend
                        // immediately so the UI can show a real reason instead
                        // of the generic 30s "did not start" timeout.
                        let msg = rest.trim().to_string();
                        error!("sidecar backend error: {msg}");
                        let _ = handle.emit("backend-error", msg);
                    } else {
                        info!("sidecar: {line}");
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line).into_owned();
                    let line = line.trim_end_matches(|c| c == '\n' || c == '\r');
                    warn!("sidecar:err: {line}");
                }
                CommandEvent::Terminated(payload) => {
                    error!("sidecar terminated: code={:?}", payload.code);
                    let _ = handle.emit(
                        "backend-error",
                        format!("sidecar terminated (exit code {:?})", payload.code),
                    );
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let auth_token = random_token();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Logger plugin is initialised before spawn_sidecar so every line we
        // emit during boot — including the auth-token confirmation and any
        // sidecar stdout/stderr — lands in the file at
        // ~/Library/Logs/<bundle_id>/sidecar.log. Without this, release
        // builds silently drop diagnostics and force us to guess what
        // went wrong from a 30s frontend timeout.
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets([
                    Target::new(TargetKind::Stderr),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("sidecar".to_string()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(SidecarState(Mutex::new(None)))
        .manage(BackendPort(Mutex::new(None)))
        .manage(AuthToken(auth_token))
        .invoke_handler(tauri::generate_handler![get_backend_port, get_auth_token])
        .setup(|app| {
            info!(
                "generated per-launch auth token (length={})",
                app.state::<AuthToken>().0.len()
            );
            if let Err(e) = spawn_sidecar(&app.handle().clone()) {
                error!("failed to spawn sidecar: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.app_handle().try_state::<SidecarState>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
