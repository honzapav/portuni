// Auto-update commands. The webview never touches tauri-plugin-updater
// directly (no updater permission in capabilities/default.json) — it only
// calls the four commands below, wired through generate_handler! in lib.rs.
//
// check_update caches the found Update in PendingUpdate so install_update
// doesn't re-fetch (and re-verify) latest.json; a later check_update (manual
// "Zkontrolovat nyní" or the 6h poll) replaces or clears the cached entry.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub(crate) struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
pub(crate) struct UpdateInfo {
    version: String,
    current_version: String,
    date: Option<String>,
}

#[derive(Clone, Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Check the configured endpoint for a newer release. Debug builds
/// (`cargo tauri dev`) never report an update — there is no signed
/// installer to install, and hitting the real endpoint from a dev build
/// would offer an update dev builds can't apply.
#[tauri::command]
pub(crate) async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }
    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = found.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        date: update.date.map(|d| d.to_string()),
    });
    *app.state::<PendingUpdate>()
        .0
        .lock()
        .map_err(|e| e.to_string())? = found;
    Ok(info)
}

/// Download and install the update found by the last `check_update`, emitting
/// `update-progress` events as bytes arrive. Errors (network, signature
/// mismatch) leave the currently-running app untouched — nothing is applied
/// until this returns Ok.
#[tauri::command]
pub(crate) async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let Some(update) = update else {
        return Err("no update to install — call check_update first".to_string());
    };
    let progress_handle = app.clone();
    update
        .download_and_install(
            move |downloaded, total| {
                let _ = progress_handle.emit(
                    "update-progress",
                    UpdateProgress {
                        downloaded: downloaded as u64,
                        total,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

/// Restart onto the version installed by `install_update`, through the same
/// sequential-close quit sequence Cmd+Q uses (#229) -- every window gets its
/// own dirty-editor/unsynced-files/running-terminals guard chance before
/// anything closes, instead of an unconditional kill_all_sidecars + restart.
/// `crate::advance_quit`'s Restart branch kills every sidecar (restart
/// doesn't go through `RunEvent::Exit`, unlike the plain-quit path) and
/// calls `AppHandle::restart`, which never returns (it re-execs the
/// process), once the queue empties.
#[tauri::command]
pub(crate) fn restart_app(app: AppHandle) {
    crate::begin_quit(&app, crate::QuitAction::Restart);
}

#[tauri::command]
pub(crate) fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}
