// Tauri host for Portuni. Spawns the bundled Node sidecar (the desktop
// HTTP backend) on startup, parses the port it announces on stdout,
// stashes it in app state, and also emits a `backend-ready` event the
// React frontend may listen to. Frontend code is expected to call the
// `get_backend_port` command first and only fall back to the event if
// the port isn't set yet — events that fire before a listener is
// registered are otherwise lost.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct SidecarState(Mutex<Option<CommandChild>>);
struct BackendPort(Mutex<Option<u16>>);

#[tauri::command]
fn get_backend_port(state: tauri::State<BackendPort>) -> Option<u16> {
    *state.0.lock().unwrap()
}

fn spawn_sidecar(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir).ok();
    let data_dir_str = data_dir.to_string_lossy().to_string();

    // tauri-plugin-shell 2.x's env_clear() does not reliably scrub the
    // parent env on macOS — so we additionally force-empty the variables
    // we don't want leaking from a developer's varlock-loaded shell.
    // Desktop mode runs auth-free on loopback by design.
    let (mut rx, child) = app
        .shell()
        .sidecar("portuni-sidecar")?
        .env_clear()
        .env("PORTUNI_DATA_DIR", data_dir_str)
        .env("PORTUNI_PORT", "0")
        .env("PORTUNI_AUTH_TOKEN", "")
        .env("TURSO_URL", "")
        .env("TURSO_AUTH_TOKEN", "")
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
                    if let Some(rest) = line.strip_prefix("PORTUNI_LISTENING_PORT=") {
                        if let Ok(port) = rest.trim().parse::<u16>() {
                            handle
                                .state::<BackendPort>()
                                .0
                                .lock()
                                .unwrap()
                                .replace(port);
                            let _ = handle.emit("backend-ready", port);
                            eprintln!("[sidecar] backend ready on port {port}");
                        }
                    } else {
                        eprintln!("[sidecar] {line}");
                    }
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[sidecar:err] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[sidecar] terminated: code={:?}", payload.code);
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .manage(BackendPort(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![get_backend_port])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            if let Err(e) = spawn_sidecar(&app.handle().clone()) {
                eprintln!("failed to spawn sidecar: {e}");
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
