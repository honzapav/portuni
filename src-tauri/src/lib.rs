// Tauri host for Portuni. Spawns the bundled Node sidecar (the desktop
// HTTP backend) on startup, parses the port it announces on stdout,
// stashes it in app state, and also emits a `backend-ready` event the
// React frontend may listen to. Frontend code is expected to call the
// `get_backend_port` command first and only fall back to the event if
// the port isn't set yet — events that fire before a listener is
// registered are otherwise lost.

use std::collections::HashMap;
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

// Keychain coordinates for the Turso auth token. Service is bundle-id-shaped
// so the entry shows up under "ooo.workflow.portuni" in Keychain Access on
// macOS; account is the secret's role within that service.
const KEYCHAIN_SERVICE: &str = "ooo.workflow.portuni";
const KEYCHAIN_TURSO_ACCOUNT: &str = "turso_auth_token";

#[derive(Default, Serialize, Deserialize, Clone)]
struct DesktopConfig {
    /// Optional libSQL URL. When unset, defaults to a file: URL inside
    /// PORTUNI_DATA_DIR. Leave the file: variant for purely local use,
    /// set a libsql:// URL to point the desktop at a Turso database. The
    /// matching auth token lives in the OS keychain, not this file —
    /// see `set_turso_token` / `clear_turso_token` Tauri commands.
    #[serde(default)]
    turso_url: Option<String>,
    /// Filesystem root for local mirror folders + the per-device
    /// `<root>/.portuni/sync.db` registry. Mirror-aware backend code
    /// (file detail, status scan, store/pull) reads PORTUNI_WORKSPACE_ROOT
    /// before hitting that registry. Defaults to ~/Workspaces/portuni when
    /// unset; set to match an existing CLI workspace to share its mirrors.
    /// Tilde (~) is expanded by the sidecar at runtime.
    #[serde(default)]
    portuni_workspace_root: Option<String>,
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

fn keychain_get_turso_token() -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_TURSO_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
}

#[tauri::command]
fn set_turso_token(token: String) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_TURSO_ACCOUNT)
        .map_err(|e| e.to_string())?
        .set_password(&token)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_turso_token() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_TURSO_ACCOUNT)
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // "no entry" means already cleared — idempotent success.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// One-shot migration for installs that still carry `turso_auth_token` in
// plaintext config.json. If the field is present and Keychain has no entry
// yet, copy it across, then strip the field from config.json so the next
// boot is plain. If the field is present but Keychain already has a value,
// strip the field anyway — the keychain copy supersedes it and leaving the
// plaintext sitting around defeats the point of this whole refactor.
fn migrate_turso_token_to_keychain(data_dir: &PathBuf) {
    let path = config_path(data_dir);
    let Ok(raw) = std::fs::read_to_string(&path) else { return };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else { return };
    let Some(obj) = value.as_object_mut() else { return };
    if !obj.contains_key("turso_auth_token") {
        return;
    }
    let token = obj
        .get("turso_auth_token")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let mut migrated_into_keychain = false;
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        if keychain_get_turso_token().is_none() {
            match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_TURSO_ACCOUNT)
                .and_then(|e| e.set_password(&token))
            {
                Ok(()) => {
                    migrated_into_keychain = true;
                }
                Err(e) => {
                    warn!("failed to migrate turso_auth_token to Keychain: {e}");
                    return;
                }
            }
        }
    }

    obj.remove("turso_auth_token");
    match serde_json::to_string_pretty(&value) {
        Ok(rewritten) => {
            if let Err(e) = std::fs::write(&path, rewritten) {
                warn!("failed to rewrite config.json after Keychain migration: {e}");
                return;
            }
            if migrated_into_keychain {
                info!("migrated turso_auth_token from config.json to Keychain");
            } else {
                info!("removed stale turso_auth_token field from config.json");
            }
        }
        Err(e) => warn!("failed to serialize cleaned config.json: {e}"),
    }
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

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: String,
}

// Webview-side HTTP proxy. The webview no longer talks to the sidecar
// directly: it invokes this command, which lives in the same trust
// domain as the sidecar (the Tauri host that spawned it) and therefore
// is the right place to attach the per-launch bearer. Keeps the
// PORTUNI_AUTH_TOKEN out of webview JS entirely.
#[tauri::command]
async fn api_request(
    app: AppHandle,
    method: String,
    path: String,
    body: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<ApiResponse, String> {
    // Snapshot port + token from state, then drop the guard before
    // awaiting — holding a std::sync::Mutex across .await deadlocks
    // the executor on contention.
    let port = {
        let state = app.state::<BackendPort>();
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.ok_or_else(|| "backend not ready".to_string())?
    };
    let token = app.state::<AuthToken>().0.clone();

    let url = format!("http://127.0.0.1:{port}{path}");
    let method_parsed =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = reqwest::Client::new()
        .request(method_parsed, &url)
        .header("Authorization", format!("Bearer {token}"))
        // Backend's PORTUNI_ALLOWED_ORIGINS includes tauri://localhost
        // so the existing origin allowlist accepts proxied requests.
        .header("Origin", "tauri://localhost");
    if let Some(headers) = headers {
        for (k, v) in headers {
            // The host owns auth — drop any caller-provided
            // Authorization to prevent webview JS from spoofing one.
            if k.eq_ignore_ascii_case("authorization") {
                continue;
            }
            req = req.header(k, v);
        }
    }
    if let Some(body) = body {
        req = req.body(body);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(ApiResponse { status, body })
}

fn spawn_sidecar(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir).ok();
    let data_dir_str = data_dir.to_string_lossy().to_string();
    info!("spawn_sidecar: data_dir={data_dir_str}");

    // Move any legacy plaintext token into Keychain before we read either —
    // makes the upgrade path silent for users who set turso_auth_token under
    // the old scheme. Safe to call on every boot (no-op once migrated).
    migrate_turso_token_to_keychain(&data_dir);

    let config = load_config(&data_dir);
    let turso_url = config.turso_url.unwrap_or_default();
    let turso_token = keychain_get_turso_token().unwrap_or_default();
    // Resolve workspace root: explicit config wins, else fall back to
    // ~/Workspaces/portuni so first-run desktop installs have somewhere
    // to put mirrors. Tilde stays literal — sidecar expands it.
    let workspace_root = config
        .portuni_workspace_root
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "~/Workspaces/portuni".to_string());
    info!(
        "config: turso_url={} turso_auth_token={} workspace_root={}",
        if turso_url.is_empty() { "<unset>" } else { "<set>" },
        if turso_token.is_empty() { "<unset>" } else { "<set>" },
        workspace_root,
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
        .env("PORTUNI_WORKSPACE_ROOT", workspace_root)
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
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            api_request,
            set_turso_token,
            clear_turso_token,
        ])
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
