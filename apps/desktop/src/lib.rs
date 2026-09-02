// Tauri host for Portuni. Spawns the bundled Node sidecar (the desktop
// HTTP backend) on startup, parses the port it announces on stdout,
// stashes it in app state, and also emits a `backend-ready` event the
// React frontend may listen to. Frontend code is expected to call the
// `get_backend_port` command first and only fall back to the event if
// the port isn't set yet — events that fire before a listener is
// registered are otherwise lost.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

mod auth;
mod mcp_install;
mod pty;
mod updater;
mod workspace;

use log::{error, info, warn};
use rand::distr::Alphanumeric;
use rand::{Rng, TryRngCore};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// Explicit-exit gate (Cmd+Q, menu Quit, app.exit). The first ExitRequested
// that still has a live main window is prevented and delegated to the
// webview guards (dirty editor, unsynced files); approve_exit sets this
// and re-triggers the exit, which then passes. Window-close-driven exits
// arrive after the window was destroyed and pass without consulting this
// — the onCloseRequested guard already ran in JS on that path.
static EXIT_APPROVED: AtomicBool = AtomicBool::new(false);

// If the webview never answers `app-exit-requested` (e.g. its React tree
// crashed on render before the approve_exit listener in App.tsx's effect
// ever mounted — see #176), the gate above would block Cmd+Q / Quit
// forever. schedule_exit_fallback arms a grace-period timer alongside
// every emit; if still unanswered when it fires, it force-approves and
// exits itself instead of waiting on a webview that can no longer answer.
const EXIT_FALLBACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

// Generation counter making the fallback timer cancellable (#221 fix): the
// webview DOES answer promptly on "Zpět do editoru" / "Zrušit" (both
// resolve confirmExit() with false), but nothing told Rust — so the timer
// armed by the emit fired 5s later regardless and force-exited anyway.
// schedule_exit_fallback captures the generation current at arm time;
// decline_exit bumps it, which invalidates that specific timer (and any
// older one still in flight) without touching EXIT_APPROVED, so the next
// Cmd+Q attempt is answered fresh.
static EXIT_FALLBACK_GENERATION: AtomicU64 = AtomicU64::new(0);

// Pure decision for a fallback timer waking up: should it force-exit now?
// No -- either something else already approved the exit (approve_exit's own
// immediate app.exit(0) already ran; firing again would be a harmless but
// pointless double-exit), or decline_exit (or a newer schedule_exit_fallback
// call) bumped the generation counter past the one this timer was armed
// with. Pure so both branches are unit-testable without a real AppHandle.
fn fallback_should_fire(armed_generation: u64, current_generation: u64, approved: bool) -> bool {
    !approved && armed_generation == current_generation
}

fn schedule_exit_fallback(app: &AppHandle) {
    let generation = EXIT_FALLBACK_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(EXIT_FALLBACK_TIMEOUT);
        let current = EXIT_FALLBACK_GENERATION.load(Ordering::SeqCst);
        let approved = EXIT_APPROVED.load(Ordering::SeqCst);
        if fallback_should_fire(generation, current, approved) {
            warn!(
                "webview did not answer app-exit-requested within {EXIT_FALLBACK_TIMEOUT:?} — forcing exit"
            );
            EXIT_APPROVED.store(true, Ordering::SeqCst);
            app_handle.exit(0);
        }
    });
}

// The webview's answer to `app-exit-requested` when the user declined
// (cancelled a guard dialog, or is not actually quitting -- e.g. the
// updater's "Restartovat" reusing the same guards). Cancels any pending
// fallback timer so it doesn't force-exit 5s later; EXIT_APPROVED stays
// false so the next Cmd+Q attempt asks the webview again. Harmless to call
// with no timer pending (a bare generation bump).
#[tauri::command]
fn decline_exit() {
    EXIT_FALLBACK_GENERATION.fetch_add(1, Ordering::SeqCst);
}

// Per-workspace running sidecar children, keyed by workspace id. Concurrent
// workspaces each get their own sidecar process on their own port.
struct SidecarState(Mutex<HashMap<String, CommandChild>>);
// Per-workspace bound backend port. Value 0 is the central sentinel — the
// sync agent for that workspace is deferred (not logged in / no server_url).
struct BackendPorts(Mutex<HashMap<String, u16>>);
// Per-workspace MCP bearer token, cached so api_request / pty_spawn read it
// without touching Keychain each time. regenerate_mcp_token rotates the
// active workspace's entry in place without restarting the Tauri host.
struct AuthTokens(Mutex<HashMap<String, String>>);
// Per-workspace, per-launch secret proving a request came through THIS
// Tauri host's api_request proxy rather than a spawned agent terminal
// holding the same bearer token (#213). Generated fresh at every
// spawn_sidecar_ws, handed to the sidecar only via its child-process env
// (PORTUNI_WEBVIEW_PROXY_SECRET) and attached as X-Portuni-Webview-Proxy on
// every locally-proxied api_request call. Never persisted, never exported
// into pty_spawn's shell env -- see api_request and spawn_sidecar_ws.
struct WebviewProxySecrets(Mutex<HashMap<String, String>>);
// Serializes every config.json read-modify-write (#224). Every mutating
// command does load -> modify -> workspace::save through one fixed
// config.json.tmp with no lock; two concurrent writers (phase 2 adds
// window open/close events to the set) can otherwise interleave and the
// loser's edit is silently lost (last rename wins). with_config_mut below
// is the standard way through this lock.
struct ConfigLock(Mutex<()>);
// Ordered focus history of ws:<id> windows (#225), oldest first, most
// recently focused last. Updated in-memory on WindowEvent::Focused(true);
// NOT persisted on every focus change -- only its last() entry is written
// to config.json's active_workspace, together with open_windows, whenever
// a window opens or closes (persist_open_windows). Also the source for
// "the most recently focused remaining window" when disabling/deleting the
// workspace currently recorded as active (reassign_active_workspace).
struct FocusHistory(Mutex<Vec<String>>);

// Keychain coordinates for secrets we persist across launches. Service is
// bundle-id-shaped so entries show up under "ooo.workflow.portuni" in
// Keychain Access on macOS; account is the secret's role within that
// service.
pub(crate) const KEYCHAIN_SERVICE: &str = "ooo.workflow.portuni";
const KEYCHAIN_TURSO_ACCOUNT: &str = "turso_auth_token";
pub(crate) const KEYCHAIN_MCP_ACCOUNT: &str = "mcp_auth_token";

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

// Workspace-scoped Keychain helpers. Every secret we persist across
// launches is namespaced per workspace (`<base>.<ws_id>`, see
// workspace::keychain_account) so switching the active workspace never
// leaks or clobbers another workspace's credentials.
pub(crate) fn keychain_get_ws(base: &str, ws_id: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &workspace::keychain_account(base, ws_id))
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|s| !s.is_empty())
}

pub(crate) fn keychain_set_ws(base: &str, ws_id: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &workspace::keychain_account(base, ws_id))
        .map_err(|e| e.to_string())?
        .set_password(value)
        .map_err(|e| e.to_string())
}

pub(crate) fn keychain_delete_ws(base: &str, ws_id: &str) {
    if let Ok(entry) =
        keyring::Entry::new(KEYCHAIN_SERVICE, &workspace::keychain_account(base, ws_id))
    {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log::warn!("keychain delete {base}.{ws_id} failed: {e}"),
        }
    }
}

/// Load the active workspace's id + config from the v2 config.json. Errors
/// when the config is still v1 (awaiting migration) or missing (fresh
/// install) — callers surface that as a command error to the UI rather
/// than guessing at a workspace that doesn't exist yet.
pub(crate) fn active_workspace(
    app: &AppHandle,
) -> Result<(String, workspace::WorkspaceConfig), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(file) => {
            let cfg = file
                .workspaces
                .get(&file.active_workspace)
                .cloned()
                .ok_or_else(|| "active workspace missing from config".to_string())?;
            Ok((file.active_workspace, cfg))
        }
        workspace::LoadedConfig::V1(_) => Err("config awaiting workspace migration".to_string()),
        workspace::LoadedConfig::Missing => Err("no config.json (fresh install)".to_string()),
    }
}

// Window identity (#222, phase 1 of the multi-window design). `app.windows`
// in tauri.conf.json is now `[]` -- every window is created at runtime with
// a label that says what it is: "bootstrap" before any workspace exists,
// "ws:<id>" once one does. ws_of answers "which workspace is THIS window
// for", the per-window counterpart to active_workspace's "the currently
// active one" -- #223 routes every workspace-bound command through it
// instead of active_workspace. Split into a thin AppHandle-resolving
// wrapper and a pure(-ish, filesystem-reading) core (ws_of_from_dir) so the
// label parsing and existence check are unit-testable with a temp data_dir
// instead of a real Tauri window.
pub(crate) fn ws_of(window: &tauri::Window) -> Result<String, String> {
    let data_dir = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    ws_of_from_dir(window.label(), &data_dir)
}

fn ws_of_from_dir(label: &str, data_dir: &Path) -> Result<String, String> {
    let id = label
        .strip_prefix("ws:")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| format!("window '{label}' is not a workspace window"))?;
    match workspace::load(data_dir)? {
        workspace::LoadedConfig::V2(file) if file.workspaces.contains_key(id) => {
            Ok(id.to_string())
        }
        workspace::LoadedConfig::V2(_) => Err(format!("unknown workspace '{id}'")),
        workspace::LoadedConfig::V1(_) => Err("config awaiting workspace migration".to_string()),
        workspace::LoadedConfig::Missing => Err("no config.json (fresh install)".to_string()),
    }
}

// Sibling of active_workspace for callers that already have a specific
// ws_id (from ws_of, #223) instead of wanting "whichever one is active".
pub(crate) fn workspace_config_for(
    app: &AppHandle,
    ws_id: &str,
) -> Result<workspace::WorkspaceConfig, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(file) => file
            .workspaces
            .get(ws_id)
            .cloned()
            .ok_or_else(|| format!("workspace '{ws_id}' missing from config")),
        workspace::LoadedConfig::V1(_) => Err("config awaiting workspace migration".to_string()),
        workspace::LoadedConfig::Missing => Err("no config.json (fresh install)".to_string()),
    }
}

// Config-lock helpers (#224). Split so the interesting part -- serializing
// load-modify-save against a real Mutex and a real data_dir -- is
// unit-testable with two threads and a temp dir, without needing a real
// Tauri AppHandle/managed state.
//
// with_config_write_lock: for callers that do their own load/construct/save
// (onboarding/migration, which may start from V1 or Missing and construct
// the initial V2 file themselves) but still need to serialize against every
// other writer.
fn with_config_write_lock<T>(
    app: &AppHandle,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<ConfigLock>();
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let result = f();
    // Broadcast after every successful config mutation (#226) so every
    // window's Sidebar/WorkspacesSection can refresh instead of relying on
    // the old document-local CustomEvent, which only the emitting window
    // ever heard.
    if result.is_ok() {
        let _ = app.emit("workspaces-changed", ());
    }
    result
}

// with_config_mut: the common case for callers that already require an
// existing V2 config -- load it, let `mutate` apply the change, save.
fn with_config_mut_at(
    lock: &Mutex<()>,
    data_dir: &Path,
    mutate: impl FnOnce(&mut workspace::WorkspacesFile) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = lock.lock().map_err(|e| e.to_string())?;
    let mut file = match workspace::load(data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        workspace::LoadedConfig::V1(_) => {
            return Err("config awaiting workspace migration".to_string())
        }
        workspace::LoadedConfig::Missing => {
            return Err("no config.json (fresh install)".to_string())
        }
    };
    mutate(&mut file)?;
    workspace::save(data_dir, &file)
}

pub(crate) fn with_config_mut(
    app: &AppHandle,
    mutate: impl FnOnce(&mut workspace::WorkspacesFile) -> Result<(), String>,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let result = with_config_mut_at(&app.state::<ConfigLock>().0, &data_dir, mutate);
    // See with_config_write_lock's comment (#226) -- same broadcast, this
    // is the common-case wrapper most mutating commands go through.
    if result.is_ok() {
        let _ = app.emit("workspaces-changed", ());
    }
    result
}

// Same title/size/min-size/etc. tauri.conf.json's single static window used
// to declare before app.windows became `[]` -- only the label varies now.
// Persists open_windows right after a successful "ws:<id>" open (#225,
// "rewritten on every window open/close"); "bootstrap" is not a workspace
// and is never recorded.
fn open_window(app: &AppHandle, label: &str) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title("Portuni")
        .inner_size(1600.0, 1000.0)
        .min_inner_size(1024.0, 700.0)
        .maximized(true)
        .resizable(true)
        .fullscreen(false)
        .build()?;
    if label.starts_with("ws:") {
        persist_open_windows(app);
    }
    Ok(())
}

// Pure selection of which ws:<id> windows to restore at startup (#225):
// - each id in open_windows that still names an existing, enabled
//   workspace gets a window;
// - an empty or fully invalid open_windows list falls back to a single
//   window for active_workspace, itself only if it is still valid;
// - anything else (no workspaces, active_workspace invalid too) returns
//   empty, which the caller treats as "open bootstrap instead".
fn startup_window_labels(file: &workspace::WorkspacesFile) -> Vec<String> {
    let restored: Vec<String> = file
        .open_windows
        .iter()
        .filter(|id| file.workspaces.get(id.as_str()).is_some_and(|c| c.enabled))
        .map(|id| format!("ws:{id}"))
        .collect();
    if !restored.is_empty() {
        return restored;
    }
    if file
        .workspaces
        .get(&file.active_workspace)
        .is_some_and(|c| c.enabled)
    {
        return vec![format!("ws:{}", file.active_workspace)];
    }
    Vec::new()
}

// AppHandle-resolving wrapper around startup_window_labels: any read
// failure (missing config, corrupt v2, v1 still awaiting migration) is
// treated as "no workspace yet" (empty list -> bootstrap), consistent with
// every other config-read failure in this file.
fn resolve_startup_window_labels(app: &AppHandle) -> Vec<String> {
    let Ok(data_dir) = app.path().app_data_dir() else {
        return Vec::new();
    };
    let Ok(workspace::LoadedConfig::V2(file)) = workspace::load(&data_dir) else {
        return Vec::new();
    };
    startup_window_labels(&file)
}

// Startup windows: one per id in open_windows that's still there and
// enabled; falls back to a single window for active_workspace, or
// "bootstrap" if neither resolves to anything (fresh install, or a v1
// config still awaiting migration). Called once from .setup().
fn create_startup_windows(app: &AppHandle) -> tauri::Result<()> {
    let labels = resolve_startup_window_labels(app);
    if labels.is_empty() {
        return open_window(app, "bootstrap");
    }
    for label in labels {
        open_window(app, &label)?;
    }
    Ok(())
}

// Bootstrap -> workspace handoff: once save_config / setup_central /
// migrate_to_workspaces has produced (or confirmed) a real workspace, open
// its ws:<id> window and close the bootstrap window that made the call --
// the fresh-install/migration React gates dropped their own
// window.location.reload() in favor of this (#222). Best-effort: a failure
// to open the new window is logged rather than left to strand the user with
// no window at all, and closing "bootstrap" is a no-op if it doesn't exist
// (e.g. called from tests, or a future caller that isn't actually
// bootstrap).
fn handoff_from_bootstrap(app: &AppHandle, ws_id: &str) {
    let label = format!("ws:{ws_id}");
    if let Err(e) = open_window(app, &label) {
        warn!("bootstrap handoff: failed to open {label}: {e}");
        return;
    }
    if let Some(w) = app.get_webview_window("bootstrap") {
        let _ = w.close();
    }
}

// True when `open_labels` contains "ws:<ws_id>" -- the disable/delete
// refusal check (#225), pulled apart from window_open_for's AppHandle
// query so it's unit-testable. Pure.
fn is_window_open_for(open_labels: &[String], ws_id: &str) -> bool {
    let target = format!("ws:{ws_id}");
    open_labels.iter().any(|l| l == &target)
}

// True when a ws:<id> window for this workspace is currently open (#225).
fn window_open_for(app: &AppHandle, ws_id: &str) -> bool {
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    is_window_open_for(&labels, ws_id)
}

// Move ws_id to the end of the focus history, removing any earlier
// occurrence first (re-focusing an already-tracked window just moves it,
// never duplicates). Pure.
fn touch_focus(history: &mut Vec<String>, ws_id: &str) {
    history.retain(|id| id != ws_id);
    history.push(ws_id.to_string());
}

// Drop ws_id from the focus history (its window closed). Pure.
fn untrack_focus(history: &mut Vec<String>, ws_id: &str) {
    history.retain(|id| id != ws_id);
}

// After disabling/deleting removed_id (only possible once its own window
// is closed -- window_open_for already guards that), pick the next
// active_workspace: the most recently focused remaining window, else the
// first remaining enabled workspace (BTreeMap iteration is sorted, so this
// is deterministic), else removed_id itself unchanged -- unreachable in
// the real flows ("cannot delete the last workspace" already guards
// delete_workspace) but a safe default over a panic. Pure.
fn reassign_active_workspace(
    removed_id: &str,
    focus_history: &[String],
    workspaces: &std::collections::BTreeMap<String, workspace::WorkspaceConfig>,
) -> String {
    focus_history
        .iter()
        .rev()
        .find(|id| id.as_str() != removed_id && workspaces.get(id.as_str()).is_some_and(|c| c.enabled))
        .cloned()
        .or_else(|| {
            workspaces
                .iter()
                .find(|(id, c)| id.as_str() != removed_id && c.enabled)
                .map(|(id, _)| id.clone())
        })
        .unwrap_or_else(|| removed_id.to_string())
}

// Rewrite open_windows (every currently-open ws:<id> window) and, when the
// focus history has an entry, active_workspace -- together, under the
// config lock, whenever a window opens or closes (#225; NOT on every focus
// change, only the open/close events that call this). Best-effort: a
// failure to persist is logged, never propagated -- a window has already
// opened/closed by the time this runs, so there's nothing left to roll
// back.
fn persist_open_windows(app: &AppHandle) {
    let open: Vec<String> = app
        .webview_windows()
        .keys()
        .filter_map(|label| label.strip_prefix("ws:").map(str::to_string))
        .collect();
    let active = app
        .try_state::<FocusHistory>()
        .and_then(|s| s.0.lock().ok().and_then(|h| h.last().cloned()));
    if let Err(e) = with_config_mut(app, |file| {
        file.open_windows = open.clone();
        if let Some(a) = &active {
            file.active_workspace = a.clone();
        }
        Ok(())
    }) {
        warn!("failed to persist open_windows: {e}");
    }
}

// Snapshot of the current focus history for reassign_active_workspace
// callers -- cloned out from behind the Mutex rather than held, since
// they need it inside a with_config_mut closure that's already holding
// ConfigLock (a different lock, but no reason to hold both at once).
fn focus_history_snapshot(app: &AppHandle) -> Vec<String> {
    app.try_state::<FocusHistory>()
        .and_then(|s| s.0.lock().ok().map(|h| h.clone()))
        .unwrap_or_default()
}

#[tauri::command]
fn set_turso_token(window: tauri::Window, token: String) -> Result<(), String> {
    let ws_id = ws_of(&window)?;
    keychain_set_ws(KEYCHAIN_TURSO_ACCOUNT, &ws_id, &token)
}

#[tauri::command]
fn clear_turso_token(window: tauri::Window) -> Result<(), String> {
    let ws_id = ws_of(&window)?;
    keychain_delete_ws(KEYCHAIN_TURSO_ACCOUNT, &ws_id);
    Ok(())
}

// Returns the MCP bearer token the current data_mode actually needs. The
// frontend reads it only when the user explicitly asks (Settings → Show /
// Copy) so it doesn't sit in webview JS state by default.
//
// Both data modes hand out the workspace's local sidecar token: the URL the
// Settings panel shows next to it is always the local MCP front door
// (`workspace::global_front_door_url`), which authenticates with
// PORTUNI_AUTH_TOKEN — in central mode the front door proxies graph tools
// to the central server with the device token itself, so the device token
// is never the credential a client needs.
#[tauri::command]
fn get_mcp_token(window: tauri::Window) -> Result<String, String> {
    let ws_id = ws_of(&window)?;
    let app = window.app_handle();
    app.state::<AuthTokens>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&ws_id)
        .cloned()
        .or_else(|| keychain_get_ws(KEYCHAIN_MCP_ACCOUNT, &ws_id))
        .ok_or_else(|| "backend not ready (no token)".to_string())
}

// Rotates the MCP auth token: writes a fresh value to Keychain and into
// the active workspace's entry in the AuthTokens map. Per-mirror .mcp.json and .codex/config.toml
// reference the token via the PORTUNI_MCP_TOKEN env var, so they survive
// rotation (already-running terminals keep the old value until respawned).
// Only ~/.claude.json embeds the literal token and goes stale until the
// user re-runs "Install Claude (global)".
#[tauri::command]
fn regenerate_mcp_token(window: tauri::Window) -> Result<String, String> {
    let ws_id = ws_of(&window)?;
    let app = window.app_handle();
    let fresh = random_token();
    keychain_set_ws(KEYCHAIN_MCP_ACCOUNT, &ws_id, &fresh)?;
    app.state::<AuthTokens>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(ws_id, fresh.clone());
    Ok(fresh)
}

// Resolve (name, url, claude_token, token_env) for one workspace's global
// MCP entry. Local mode: loopback URL from the stable config port and the
// literal persisted token (Claude embeds it; Codex/Vibe use env
// indirection). Central mode: the same loopback front door (never the
// central URL) and env-reference for all.
fn global_entry_parts(
    app: &AppHandle,
    ws_id: &str,
    cfg: &workspace::WorkspaceConfig,
) -> Result<(String, String, String, String), String> {
    let name = workspace::mcp_server_name(ws_id, cfg);
    let token_env = workspace::token_env_var(ws_id);
    // Both data modes run a local sidecar serving the MCP front door, so the
    // global config always targets it — never the central `server_url`. A
    // central URL would route device-local tools (portuni_mirror/store) to a
    // server with no local file plane. See workspace::global_front_door_url.
    let url =
        workspace::global_front_door_url(cfg).map_err(|e| format!("workspace {ws_id}: {e}"))?;
    // Claude's ~/.claude.json embeds the literal token (its http-server
    // headers do not expand env vars for out-of-mirror shells); Codex/Vibe
    // callers use the returned token_env instead. Loopback-only, rotating
    // per-launch token — the same accepted trade-off local mode already made.
    let token = app
        .state::<AuthTokens>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(ws_id)
        .cloned()
        .or_else(|| keychain_get_ws(KEYCHAIN_MCP_ACCOUNT, ws_id))
        .ok_or_else(|| format!("workspace {ws_id}: MCP token unavailable"))?;
    Ok((name, url, token, token_env))
}

pub(crate) fn enabled_workspaces(
    app: &AppHandle,
) -> Result<Vec<(String, workspace::WorkspaceConfig)>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => Ok(f
            .workspaces
            .into_iter()
            .filter(|(_, c)| c.enabled)
            .collect()),
        _ => Err("config not migrated to workspaces yet".to_string()),
    }
}

// Writes Portuni as a user-scoped MCP server in ~/.claude.json, so any
// Claude Code session on this machine can connect without per-project
// .mcp.json. Returns the absolute path of the written file for the UI
// to surface back to the user. Installs one entry per enabled workspace.
//
// In central data_mode: still writes the local front door URL (the agent
// sidecar proxies graph tools to central) and uses the PORTUNI_MCP_TOKEN_<WS>
// env-reference pattern (same as mirror configs) so the token is never
// hardcoded in the file.
#[tauri::command]
fn install_claude_global(app: AppHandle) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = PathBuf::from(home).join(".claude.json");
    // Each workspace entry installs independently; failures aggregate so
    // one broken workspace (e.g. tokenless) cannot block the rest.
    let mut failures: Vec<String> = Vec::new();
    for (ws_id, cfg) in enabled_workspaces(&app)? {
        let result = global_entry_parts(&app, &ws_id, &cfg).and_then(|(name, url, token, _env)| {
            mcp_install::write_claude_config(&path, &name, &url, &token)
        });
        if let Err(e) = result {
            failures.push(format!("{ws_id}: {e}"));
        }
    }
    if failures.is_empty() {
        Ok(path.to_string_lossy().into_owned())
    } else {
        Err(format!("some workspaces failed: {}", failures.join("; ")))
    }
}

// Same idea for Codex: writes one [mcp_servers.<name>] block per enabled
// workspace into ~/.codex/config.toml between Portuni-managed marker
// comments so we can refresh idempotently without clobbering surrounding
// user config.
#[tauri::command]
fn install_codex_global(app: AppHandle) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = PathBuf::from(home).join(".codex").join("config.toml");
    // Each workspace entry installs independently; failures aggregate so
    // one broken workspace (e.g. tokenless) cannot block the rest.
    let mut failures: Vec<String> = Vec::new();
    for (ws_id, cfg) in enabled_workspaces(&app)? {
        let result =
            global_entry_parts(&app, &ws_id, &cfg).and_then(|(name, url, _token, token_env)| {
                mcp_install::write_codex_config(&path, &name, &url, &token_env)
            });
        if let Err(e) = result {
            failures.push(format!("{ws_id}: {e}"));
        }
    }
    if failures.is_empty() {
        Ok(path.to_string_lossy().into_owned())
    } else {
        Err(format!("some workspaces failed: {}", failures.join("; ")))
    }
}

// Same idea for Mistral Vibe: writes one [[mcp_servers]] entry per enabled
// workspace into ~/.vibe/config.toml between Portuni-managed marker
// comments. Vibe pulls the bearer token from the per-workspace env var
// (api_key_env), so — like Codex — the literal token never lands in the
// file in either data mode.
#[tauri::command]
fn install_vibe_global(app: AppHandle) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = PathBuf::from(home).join(".vibe").join("config.toml");
    // Each workspace entry installs independently; failures aggregate so
    // one broken workspace (e.g. tokenless) cannot block the rest.
    let mut failures: Vec<String> = Vec::new();
    for (ws_id, cfg) in enabled_workspaces(&app)? {
        let result =
            global_entry_parts(&app, &ws_id, &cfg).and_then(|(name, url, _token, token_env)| {
                mcp_install::write_vibe_config(&path, &name, &url, &token_env)
            });
        if let Err(e) = result {
            failures.push(format!("{ws_id}: {e}"));
        }
    }
    if failures.is_empty() {
        Ok(path.to_string_lossy().into_owned())
    } else {
        Err(format!("some workspaces failed: {}", failures.join("; ")))
    }
}

// Persisted MCP auth token per workspace, generated on first use.
// Subsequent launches reuse the same token so external `.mcp.json` files
// (Claude Code, Codex) keep working across restarts.
fn ensure_mcp_token_ws(ws_id: &str) -> Result<String, String> {
    if let Some(existing) = keychain_get_ws(KEYCHAIN_MCP_ACCOUNT, ws_id) {
        return Ok(existing);
    }
    let fresh = random_token();
    keychain_set_ws(KEYCHAIN_MCP_ACCOUNT, ws_id, &fresh)?;
    Ok(fresh)
}

// One-shot migration for installs that still carry `turso_auth_token` in
// plaintext config.json. If the field is present and Keychain has no entry
// yet, copy it across, then strip the field from config.json so the next
// boot is plain. If the field is present but Keychain already has a value,
// strip the field anyway — the keychain copy supersedes it and leaving the
// plaintext sitting around defeats the point of this whole refactor.
fn migrate_turso_token_to_keychain(data_dir: &Path) {
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
        // Deliberately unsuffixed: this migrates the legacy pre-workspace
        // plaintext field into the legacy unsuffixed Keychain account, which
        // migrate_to_workspaces then copies into the per-workspace account.
        let existing = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_TURSO_ACCOUNT)
            .ok()
            .and_then(|e| e.get_password().ok())
            .filter(|s| !s.is_empty());
        if existing.is_none() {
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

/// True when config.json is still the flat v1 layout — the frontend uses
/// this to gate the one-time migration prompt. False for both v2 (already
/// migrated) and Missing (fresh install, no migration needed).
#[tauri::command]
fn workspace_migration_status(app: AppHandle) -> Result<bool, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(matches!(workspace::load(&data_dir)?, workspace::LoadedConfig::V1(_)))
}

// One-shot v1 -> v2 migration. Order matters for idempotence: DB files and
// Keychain first, config.json LAST — its `workspaces` key is the completion
// marker, so an interrupted run re-enters here safely.
#[tauri::command]
fn migrate_to_workspaces(app: AppHandle, id: String) -> Result<(), String> {
    if !workspace::is_valid_workspace_id(&id) {
        return Err("invalid workspace id (use lowercase letters, digits, dashes)".to_string());
    }
    // The whole migration -- not just the final config.json write -- runs
    // under the config lock (#224): it starts with a load and ends with a
    // save, and nothing else touching config.json may interleave with the
    // DB-file/Keychain steps in between either.
    with_config_write_lock(&app, || {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let v1 = match workspace::load(&data_dir)? {
            workspace::LoadedConfig::V1(v) => v,
            workspace::LoadedConfig::V2(_) => return Ok(()), // already migrated
            workspace::LoadedConfig::Missing => serde_json::json!({}),
        };

        // 1. DB files into workspaces/<id>/.
        workspace::apply_migration_files(&data_dir, &id)?;

        // 1.5 Any legacy plaintext turso_auth_token still sitting in config.json
        // needs to land in the (unsuffixed) Keychain account first, so the
        // per-workspace copy step below finds it there.
        migrate_turso_token_to_keychain(&data_dir);

        // 2. Keychain: copy unsuffixed accounts to <base>.<id>, delete originals.
        //    Copy-if-missing keeps re-runs safe after a partial failure.
        const BASES: [&str; 5] = [
            "turso_auth_token",
            "mcp_auth_token",
            "google_refresh_token",
            "portuni_session_jwt",
            "portuni_device_token",
        ];
        for base in BASES {
            let old = keyring::Entry::new(KEYCHAIN_SERVICE, base)
                .ok()
                .and_then(|e| e.get_password().ok())
                .filter(|s| !s.is_empty());
            if let Some(value) = old {
                if keychain_get_ws(base, &id).is_none() {
                    keychain_set_ws(base, &id, &value)?;
                }
                if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, base) {
                    let _ = entry.delete_credential();
                }
            }
        }

        // 3. config.json v2 — completion marker.
        let file = workspace::migrate_v1_value(&v1, &id);
        workspace::save(&data_dir, &file)?;
        info!("migrated config.json to v2 with workspace '{id}'");
        Ok(())
    })?;
    // .setup()'s spawn_all_sidecars was a no-op on the pre-migration v1/Missing
    // config, so no sidecar is running. Spawn now — the migration gate's reload
    // otherwise polls an empty BackendPorts map for 30 s. Idempotent:
    // spawn_sidecar_ws's contains_key guard skips any already-running child.
    spawn_all_sidecars(&app);
    handoff_from_bootstrap(&app, &id);
    Ok(())
}

fn random_token() -> String {
    // OsRng draws every byte from the OS CSPRNG. thread_rng would be a
    // userspace PRNG whose state survives process forks/coredumps; this
    // token is the bearer credential for the whole backend API, so take
    // the direct route.
    rand::rngs::OsRng
        .unwrap_err()
        .sample_iter(Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

// The webview's answer to `app-exit-requested`: the user either had nothing
// to guard or explicitly chose to leave. Marks the exit approved and
// re-triggers it; the run-handler gate then lets it pass.
#[tauri::command]
fn approve_exit(app: AppHandle) {
    EXIT_APPROVED.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn get_backend_port(window: tauri::Window) -> Option<u16> {
    // Port of THIS WINDOW's workspace's sidecar (#223). None before the
    // sidecar reports its port, or while the window is "bootstrap" (no
    // workspace yet — the migration/onboarding gate handles that case in
    // the UI).
    let ws_id = ws_of(&window).ok()?;
    let app = window.app_handle();
    let port = app
        .state::<BackendPorts>()
        .0
        .lock()
        .ok()
        .and_then(|g| g.get(&ws_id).copied());
    info!("get_backend_port[{ws_id}] -> {port:?}");
    port
}

// Open a URL (or path) in the OS default handler — browser, Finder, mail
// client. External links used to be routed through the JS shell plugin
// (`plugin:shell|open`), which is a silent no-op inside the macOS webview and
// swallowed its own errors, so a click on the Google Drive folder link or an
// actor's external link did nothing with no diagnostic trail. Doing it
// natively is reliable and logs every attempt to sidecar.log, so a failure is
// visible instead of vanishing.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    // Scheme allowlist mirrors the frontend's safe-url.ts: only ever hand the
    // OS a web or mail link. Without this, a crafted node/actor link could ask
    // the opener to launch file:// or some registered custom-scheme handler.
    let parsed = url::Url::parse(&url).map_err(|e| {
        error!("open_external rejected unparseable url {url}: {e}");
        e.to_string()
    })?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => {}
        other => {
            error!("open_external refusing scheme {other} for {url}");
            return Err(format!("refusing to open scheme: {other}"));
        }
    }
    info!("open_external: {url}");
    open::that(parsed.as_str()).map_err(|e| {
        error!("open_external failed for {url}: {e}");
        e.to_string()
    })
}

/// Returns true when `path` is a LOCAL_ONLY route that requires the sidecar
/// (mirrors, sync, file content, write-scope helpers). These paths either do
/// not exist on the central server or require local filesystem access; in
/// central data_mode they return 501 local_only.
///
/// Rules derived from src/api/router.ts:
///   /scope                      — write-scope gate (local filesystem check)
///   /sandbox-profile            — global sandbox profile (local cwd lookup)
///   /nodes/:id/sandbox-profile  — per-node sandbox profile
///   /nodes/:id/mirror           — create mirror (local filesystem operation)
///   /nodes/:id/sync-status      — sync status (local sync DB)
///   /nodes/:id/sync             — sync run (local sync engine)
///   /nodes/:id/file             — file content (GET/PUT); the agent serves a
///                                 device mirror from disk so unsynced local
///                                 files open in the editor, and falls back to
///                                 central itself when there is no mirror or
///                                 the file is pull-pending
///
/// NOT local-only (served from the central server): the file lifecycle
/// (POST /nodes/:id/files, POST /nodes/:id/files/:fileId/rename,
/// DELETE /nodes/:id/files/:fileId) is adapter-direct on the server, so it
/// forwards in central mode.
/// /nodes/:id/folder-url and /nodes/:id/file-url also stay central (Drive URL
/// lookups on the server). All graph, actor, responsibility, etc. routes are
/// central.
pub(crate) fn is_local_only_path(path: &str) -> bool {
    // Strip query string for matching.
    let p = path.split('?').next().unwrap_or(path);

    // Exact top-level paths. /sync/pending aggregates the DEVICE's mirrors
    // (footer unsynced indicator + quit guard); the central server has none
    // and would answer an empty aggregate. /sync/health is the same shape
    // for the mirror-watcher error buffer (#202) -- also device-local, also
    // empty on the central server. /sync/drive/* is NOT here: Drive
    // remote config lives on the central server in central mode.
    if p == "/scope" || p == "/sandbox-profile" || p == "/sync/pending" || p == "/sync/health" {
        return true;
    }

    // Node sub-paths that are local-only.
    // Matches: /nodes/<id>/mirror, /nodes/<id>/sync-status, /nodes/<id>/sync,
    //          /nodes/<id>/sandbox-profile, /nodes/<id>/file (content)
    //
    // NOT matched (served centrally): /nodes/<id>/files and
    // /nodes/<id>/files/* (B3 lifecycle), /nodes/<id>/file-url,
    // /nodes/<id>/folder-url.
    if let Some(rest) = p.strip_prefix("/nodes/") {
        // rest = "<id>/<sub>" or "<id>/<sub>/..."
        if let Some(slash) = rest.find('/') {
            let sub = &rest[slash + 1..];
            if sub == "mirror"
                || sub == "sync-status"
                || sub == "sync"
                || sub == "sandbox-profile"
                || sub == "file"
            {
                return true;
            }
        }
    }

    false
}

/// True when `candidate`, after lexical normalization (resolving `.`/`..`),
/// stays inside `root`. Scopes the portuni-html protocol to the workspace
/// mirror so a crafted URL cannot read arbitrary files (e.g. ../../etc/passwd).
/// Lexical only — does not resolve symlinks; the mirror is trusted not to
/// contain symlinks escaping the workspace.
fn path_within_root(root: &std::path::Path, candidate: &std::path::Path) -> bool {
    use std::path::Component;
    let mut normalized = std::path::PathBuf::new();
    for comp in candidate.components() {
        match comp {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized.starts_with(root)
}

/// Expand a leading `~` / `~/` in a config path to the user's home dir.
/// The sidecar expands PORTUNI_WORKSPACE_ROOT this way (mirror-create.ts,
/// local-db.ts), so the derived `local_path` is always absolute — but Rust's
/// PathBuf leaves `~` literal. A config value like "~/Workspaces/portuni-tempo"
/// must therefore be expanded before it can be compared against that absolute
/// path in `path_within_root`; without this every preview 403s.
pub(crate) fn expand_tilde(home: &std::path::Path, raw: &str) -> std::path::PathBuf {
    if raw == "~" {
        home.to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else {
        std::path::PathBuf::from(raw)
    }
}

#[derive(Serialize)]
struct DataModeResponse {
    mode: String,
    server_url: Option<String>,
}

/// Return the current data mode and server URL. Used by the React frontend
/// to adapt its UI (hide mirror/sync affordances in central mode).
#[tauri::command]
fn get_data_mode(window: tauri::Window) -> Result<DataModeResponse, String> {
    let ws_id = ws_of(&window)?;
    let cfg = workspace_config_for(window.app_handle(), &ws_id)?;
    let mode = if workspace::is_central(&cfg) {
        "central"
    } else {
        "local"
    }
    .to_string();
    Ok(DataModeResponse {
        mode,
        server_url: cfg.server_url,
    })
}

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: String,
}

#[derive(Serialize)]
struct TursoStatus {
    /// True iff config.json exists on disk. False means a fresh install
    /// — the frontend should show the onboarding wizard instead of
    /// silently defaulting to local mode.
    config_exists: bool,
    /// True iff config.json has a non-empty `turso_url`.
    url_set: bool,
    /// True iff Keychain has a non-empty Turso auth token.
    token_set: bool,
    /// The current `turso_url` value, if any. Frontend uses it to
    /// distinguish remote (`libsql://...`) from local (`file:...`)
    /// — only the remote case actually needs the modal.
    url: Option<String>,
}

#[tauri::command]
fn get_turso_status(app: AppHandle) -> Result<TursoStatus, String> {
    // Must NOT hard-error just because the config lacks a v2 active workspace:
    // TursoSetupGate treats a failed get_turso_status as "ready" and skips the
    // onboarding wizard, so a `?` on active_workspace here would strand a fresh
    // install with the wizard never rendered and no sidecar ever spawned (boot
    // then times out at 30 s). Handle each config state explicitly; only a
    // genuinely corrupt config.json (workspace::load Err) propagates.
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match workspace::load(&data_dir)? {
        // Fresh install: signal the onboarding wizard (config_exists = false).
        workspace::LoadedConfig::Missing => Ok(TursoStatus {
            config_exists: false,
            url_set: false,
            token_set: false,
            url: None,
        }),
        // v1 config is blocked by WorkspaceMigrationGate, which renders BEFORE
        // TursoSetupGate — so this value is never actually rendered. Report a
        // best-effort config_exists = true (the file is on disk) with no
        // url/token rather than hard-erroring, so the command stays infallible.
        workspace::LoadedConfig::V1(_) => Ok(TursoStatus {
            config_exists: true,
            url_set: false,
            token_set: false,
            url: None,
        }),
        // v2: report the active workspace's Turso state (today's behavior).
        workspace::LoadedConfig::V2(file) => {
            let ws_id = file.active_workspace.clone();
            let cfg = file
                .workspaces
                .get(&ws_id)
                .ok_or_else(|| "active workspace missing from config".to_string())?;
            let url = cfg
                .turso_url
                .clone()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            Ok(TursoStatus {
                config_exists: true,
                url_set: url.is_some(),
                token_set: keychain_get_ws(KEYCHAIN_TURSO_ACCOUNT, &ws_id)
                    .is_some_and(|t| !t.trim().is_empty()),
                url,
            })
        }
    }
}

// Used by the first-run onboarding wizard to commit the user's choice
// (connect to a remote Turso DB, or start locally) to disk. Writing an
// empty `turso_url` produces a `{}` config — the marker that the user
// has chosen local mode and we should stop showing the wizard.
#[tauri::command]
fn save_config(app: AppHandle, turso_url: Option<String>) -> Result<(), String> {
    let turso = turso_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut fresh_install = false;
    let mut active = String::new();
    with_config_write_lock(&app, || {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let loaded = workspace::load(&data_dir)?;
        // Fresh install path: .setup()'s spawn_all_sidecars was a no-op
        // (config was Missing at boot), so nothing is running yet and we
        // must spawn below.
        fresh_install = matches!(loaded, workspace::LoadedConfig::Missing);
        let mut file = match loaded {
            workspace::LoadedConfig::V2(f) => f,
            // Fresh install: onboarding commits its first choice here — create a
            // v2 file with a single `default` workspace so the install is v2 from
            // the outset (no separate v1->v2 migration step needed).
            workspace::LoadedConfig::Missing => {
                workspace::migrate_v1_value(&serde_json::json!({}), "default")
            }
            workspace::LoadedConfig::V1(_) => {
                return Err("config awaiting workspace migration".to_string())
            }
        };
        active = file.active_workspace.clone();
        let cfg = file
            .workspaces
            .get_mut(&active)
            .ok_or_else(|| "active workspace missing from config".to_string())?;
        cfg.turso_url = turso;
        workspace::save(&data_dir, &file)
    })?;
    // Fresh install: bring the just-created `default` workspace's sidecar up
    // now so the wizard's reload finds a running backend instead of polling an
    // empty BackendPorts map for 30 s. On the "connect to org" path
    // TursoSetupGate then calls set_turso_token + restart_sidecar (which
    // kills+respawns to pick up the token); on "start local" no restart runs
    // and this is the only spawn. spawn_sidecar_ws's contains_key guard makes
    // the eventual restart's kill+respawn double-call safe.
    if fresh_install {
        spawn_all_sidecars(&app);
        handoff_from_bootstrap(&app, &active);
    }
    Ok(())
}

// Onboarding wizard "join a team" path: from just a server URL, fetch the
// public desktop OAuth client (/auth/desktop-config) and commit a central-
// mode config. Mirrors save_config's fresh-install dance: create the v2
// `default` workspace when config.json is missing and spawn sidecars so
// the wizard's reload finds a running backend. After the reload,
// CentralLoginGate sees data_mode=central + configured and runs the
// Google login.
#[derive(serde::Deserialize)]
struct DesktopClientConfig {
    google_client_id: String,
    google_client_secret: String,
}

#[tauri::command]
async fn setup_central(app: AppHandle, server_url: String) -> Result<(), String> {
    let server = workspace::normalize_server_url(&server_url)?;
    // bound the fetch — a typo'd host must fail, not hang the wizard
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let resp = http
        .get(format!("{server}/auth/desktop-config"))
        .send()
        .await
        .map_err(|e| format!("server unreachable: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Err(format!(
            "{server} does not serve a desktop client config — ask your admin to set PORTUNI_DESKTOP_GOOGLE_CLIENT_ID/SECRET"
        ));
    }
    if !resp.status().is_success() {
        return Err(format!(
            "desktop-config request failed: HTTP {}",
            resp.status().as_u16()
        ));
    }
    let client: DesktopClientConfig = resp
        .json()
        .await
        .map_err(|e| format!("invalid desktop-config response: {e}"))?;
    if client.google_client_id.trim().is_empty() || client.google_client_secret.trim().is_empty() {
        return Err("desktop-config response is missing the client id or secret".to_string());
    }

    let mut fresh_install = false;
    let mut active = String::new();
    with_config_write_lock(&app, || {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let loaded = workspace::load(&data_dir)?;
        fresh_install = matches!(loaded, workspace::LoadedConfig::Missing);
        let mut file = match loaded {
            workspace::LoadedConfig::V2(f) => f,
            workspace::LoadedConfig::Missing => {
                workspace::migrate_v1_value(&serde_json::json!({}), "default")
            }
            workspace::LoadedConfig::V1(_) => {
                return Err("config awaiting workspace migration".to_string())
            }
        };
        active = file.active_workspace.clone();
        let cfg = file
            .workspaces
            .get_mut(&active)
            .ok_or_else(|| "active workspace missing from config".to_string())?;
        cfg.server_url = Some(server.clone());
        cfg.google_client_id = Some(client.google_client_id.trim().to_string());
        cfg.google_client_secret = Some(client.google_client_secret.trim().to_string());
        cfg.data_mode = Some("central".to_string());
        cfg.turso_url = None;
        workspace::save(&data_dir, &file)
    })?;
    if fresh_install {
        spawn_all_sidecars(&app);
        handoff_from_bootstrap(&app, &active);
    }
    Ok(())
}

// Spawn an external Terminal.app window in the given working directory
// and run the given shell command. macOS-only; on other platforms returns
// a "UNSUPPORTED_OS" error so the webview can fall back to clipboard
// copy. The webview is responsible for building the full shell command
// (via app/src/lib/prompt.ts:buildAgentCommand) which already starts
// with `cd <cwd> && ...` — we still validate `cwd` here so a malformed
// path surfaces as a clear error before AppleScript sees it.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn launch_claude_for_node(
    cwd: String,
    command: String,
    template: String,
) -> Result<(), String> {
    if cwd.trim().is_empty() {
        return Err("cwd is required".to_string());
    }
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    if command.trim().is_empty() {
        return Err("command is required".to_string());
    }
    if template.trim().is_empty() {
        return Err("template is required".to_string());
    }
    // The terminal-launch template (Settings -> Terminal) runs as `sh -c`.
    // The default uses Terminal.app via osascript and carries the cold-start
    // two-window fix; users can pick iTerm2 / Ghostty / Warp / cmux or write
    // their own. We expose three env vars: PORTUNI_COMMAND (the full
    // `cd <path> && <agent> ...` from buildAgentCommand), PORTUNI_CWD, and
    // PORTUNI_COMMAND_AS (AppleScript-escaped: \ -> \\, " -> \" so it drops
    // straight into a `do script "..."` double-quoted string).
    let command_as = command.replace('\\', "\\\\").replace('"', "\\\"");
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(&template)
        .env("PORTUNI_CWD", &cwd)
        .env("PORTUNI_COMMAND", &command)
        .env("PORTUNI_COMMAND_AS", &command_as)
        .output()
        .map_err(|e| format!("template run failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut detail = String::new();
        if !stderr.trim().is_empty() {
            detail.push_str(" stderr=");
            detail.push_str(stderr.trim());
        }
        if !stdout.trim().is_empty() {
            detail.push_str(" stdout=");
            detail.push_str(stdout.trim());
        }
        let msg = format!("template exited with {}{}", output.status, detail);
        // Mirror to the file logger — the UI toast truncates long messages.
        error!("launch_claude_for_node: {msg}");
        return Err(msg);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn launch_claude_for_node(
    _cwd: String,
    _command: String,
    _template: String,
) -> Result<(), String> {
    Err("UNSUPPORTED_OS".to_string())
}

// Open a path in Finder. If reveal=true, uses `open -R` to select/reveal
// the file; if false, uses `open` to open the folder itself. macOS-only;
// on other platforms returns UNSUPPORTED_OS so callers can fall through.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn open_in_finder(path: String, reveal: bool) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("path is required".to_string());
    }
    // Defense against argv flag smuggling: `open` has no `--` end-of-options
    // sentinel, so a path beginning with `-` would be parsed as a flag.
    // Portuni only passes absolute mirror paths; reject leading-dash defensively.
    if path.starts_with('-') {
        return Err("invalid path".to_string());
    }
    if !std::path::Path::new(&path).exists() {
        return Err(format!("path does not exist: {path}"));
    }
    let mut cmd = std::process::Command::new("open");
    if reveal {
        cmd.arg("-R");
    }
    cmd.arg(&path);
    let output = cmd.output().map_err(|e| format!("open failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "open exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn open_in_finder(_path: String, _reveal: bool) -> Result<(), String> {
    Err("UNSUPPORTED_OS".to_string())
}

// Open a local file in the OS default application. For .html files this
// means the system default browser. The path is scope-guarded against the
// configured workspace root so only files inside the mirror are reachable.
#[tauri::command]
fn open_path_external(window: tauri::Window, path: String) -> Result<(), String> {
    let ws_id = ws_of(&window)?;
    let app = window.app_handle();
    let cfg = workspace_config_for(app, &ws_id)?;
    let raw_root = cfg.effective_workspace_root();
    // Expand the config's leading ~ to match the sidecar-derived absolute path.
    let root = match app.path().home_dir() {
        Ok(h) => expand_tilde(&h, &raw_root),
        Err(_) => std::path::PathBuf::from(&raw_root),
    };
    let candidate = std::path::PathBuf::from(&path);
    if !path_within_root(&root, &candidate) {
        return Err("path out of workspace scope".into());
    }
    // Extension allowlist: open::that launches the OS default handler, so an
    // arbitrary in-scope file type could trigger code execution. Mirror the
    // portuni-html protocol handler and only ever open .html/.htm externally.
    let ext_ok = candidate
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
        .unwrap_or(false);
    if !ext_ok {
        return Err("only .html/.htm may be opened externally".into());
    }
    info!("open_path_external: {path}");
    open::that(&candidate).map_err(|e| e.to_string())
}

// Read a file path from the macOS clipboard. Uses osascript to coerce
// the clipboard to a POSIX file URL (POSIX path). Returns Ok(Some(path))
// when the clipboard holds a file reference, Ok(None) when it does not
// (AppleScript coercion errors are treated as "no file", not an error).
// Non-macOS always returns Ok(None).
#[cfg(target_os = "macos")]
#[tauri::command]
async fn clipboard_file_path() -> Result<Option<String>, String> {
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg("POSIX path of (the clipboard as \u{00ab}class furl\u{00bb})")
        .output()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            return Ok(None);
        }
        Ok(Some(path))
    } else {
        // Non-zero exit means the clipboard did not contain a file —
        // AppleScript coercion failed. Treat as "no file", not an error.
        Ok(None)
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn clipboard_file_path() -> Result<Option<String>, String> {
    Ok(None)
}

// Bounce a workspace's Node sidecar so it picks up freshly-changed config
// (Turso token, server URL, ...). Used by the first-run gate after the user
// pastes their token (no id — defaults to the calling window's own
// workspace, #223) and by WorkspacesSection for any enabled, non-running
// workspace (explicit id, which may differ from the calling window's own).
// Idempotent: if no sidecar is running, just spawns one.
#[tauri::command]
async fn restart_sidecar(window: tauri::Window, id: Option<String>) -> Result<(), String> {
    let app = window.app_handle().clone();
    let ws = match id {
        Some(i) => i,
        None => ws_of(&window)?,
    };
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(file) if file.workspaces.contains_key(&ws) => {}
        workspace::LoadedConfig::V2(_) => return Err(format!("unknown workspace '{ws}'")),
        _ => return Err("config not migrated to workspaces yet".to_string()),
    }
    kill_sidecar_ws(&app, &ws);
    spawn_sidecar_ws(&app, &ws).map_err(|e| e.to_string())
}

// Snapshot the local sidecar's port + bearer token for `ws_id`, then drop
// the guards before the caller awaits anything — holding a std::sync::Mutex
// across .await deadlocks the executor on contention. Shared by api_request
// (webview proxy) and auth::google_drive_connect (loopback POST to the
// sidecar), both of which need to reach the same local backend.
//
// Port 0 is the central-mode sentinel: the sync agent for this workspace
// isn't running (not logged in yet, or no server_url). Callers that need to
// distinguish that case from "genuinely not ready" should match on the
// exact error string "sync agent not running".
pub(crate) fn sidecar_port_and_token(app: &AppHandle, ws_id: &str) -> Result<(u16, String), String> {
    let port = {
        let state = app.state::<BackendPorts>();
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard
            .get(ws_id)
            .copied()
            .ok_or_else(|| "backend not ready".to_string())?
    };
    if port == 0 {
        return Err("sync agent not running".to_string());
    }
    let token = app
        .state::<AuthTokens>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(ws_id)
        .cloned()
        .ok_or_else(|| "backend not ready (no token)".to_string())?;
    Ok((port, token))
}

// The per-workspace, per-launch secret proving a request came through this
// trusted Tauri host process rather than a spawned agent terminal (#213).
// Shared by api_request's webview proxy and pty.rs's terminal-exit report
// (#219) -- both originate in Rust code here, not webview JS or a shell's
// env, so both are entitled to prove it the same way.
pub(crate) fn webview_proxy_secret(app: &AppHandle, ws_id: &str) -> Option<String> {
    app.state::<WebviewProxySecrets>()
        .0
        .lock()
        .ok()?
        .get(ws_id)
        .cloned()
}

// Webview-side HTTP proxy. The webview no longer talks to the sidecar
// directly: it invokes this command, which lives in the same trust
// domain as the sidecar (the Tauri host that spawned it) and therefore
// is the right place to attach the per-launch bearer. Keeps the
// PORTUNI_AUTH_TOKEN out of webview JS entirely.
//
// In central data_mode the command routes to server_url instead of the
// local sidecar:
//   - LOCAL_ONLY paths (mirror, sync, file content, write-scope) → 501
//   - everything else → do_central_request with JWT + silent 401 refresh
#[tauri::command]
async fn api_request(
    app: AppHandle,
    window: tauri::Window,
    method: String,
    path: String,
    body: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<ApiResponse, String> {
    // Route by THIS WINDOW's workspace config (#223), not the globally
    // "active" one.
    let ws_id = ws_of(&window)?;
    let cfg = workspace_config_for(&app, &ws_id)?;
    let is_central = workspace::is_central(&cfg);

    // In central mode, LOCAL_ONLY paths (mirror/sync/scope/sandbox) are
    // served by the LOCAL sync agent — fall through to the local proxy
    // below. Everything else goes to the central server.
    if is_central && !is_local_only_path(&path) {
        // Route to the central server using the JWT + silent refresh logic.
        let server_url = cfg
            .server_url
            .clone()
            .ok_or_else(|| "central mode requires server_url in config.json".to_string())?;

        let jwt = keychain_get_ws(auth::KEYCHAIN_SESSION_JWT, &ws_id)
            .ok_or_else(|| "central mode: not logged in (no session JWT)".to_string())?;

        // Convert body: api_request takes Option<String>, do_central_request
        // takes Option<&serde_json::Value>. Parse if present, fall through as
        // raw string if not valid JSON (shouldn't happen but be defensive).
        let body_value: Option<serde_json::Value> = body.as_deref().and_then(|b| {
            serde_json::from_str(b).ok()
        });

        let resp = auth::do_central_request_raw(
            &server_url,
            &method,
            &path,
            body_value.as_ref(),
            &jwt,
        )
        .await?;

        if resp.status == 401 {
            // Silent refresh + retry once. Same window, so the same
            // workspace the request above was actually for (#223) --
            // auth_refresh no longer re-derives it from "the active one".
            info!("api_request central: got 401, attempting silent refresh");
            match auth::auth_refresh(window.clone()).await {
                Err(e) => {
                    warn!("api_request central: silent refresh failed: {e}");
                    return Ok(ApiResponse {
                        status: resp.status,
                        body: resp.body,
                    });
                }
                Ok(_) => {
                    let new_jwt = keychain_get_ws(auth::KEYCHAIN_SESSION_JWT, &ws_id)
                        .ok_or_else(|| "not logged in after refresh".to_string())?;
                    let resp2 = auth::do_central_request_raw(
                        &server_url,
                        &method,
                        &path,
                        body_value.as_ref(),
                        &new_jwt,
                    )
                    .await?;
                    return Ok(ApiResponse {
                        status: resp2.status,
                        body: resp2.body,
                    });
                }
            }
        }

        return Ok(ApiResponse {
            status: resp.status,
            body: resp.body,
        });
    }

    // Local proxy: the bundled sidecar (local mode) or the sync agent
    // (central mode, LOCAL_ONLY paths).
    // Snapshot port + token from state, then drop the guard before
    // awaiting — holding a std::sync::Mutex across .await deadlocks
    // the executor on contention.
    let (port, token) = match sidecar_port_and_token(&app, &ws_id) {
        Ok(pt) => pt,
        Err(e) if e == "sync agent not running" => {
            // Central-mode sentinel: the sync agent is not running (not
            // logged in yet, or no server_url). Local-only affordances
            // stay parked.
            return Ok(ApiResponse {
                status: 501,
                body: "{\"error\":\"local_only\",\"detail\":\"sync agent not running\"}"
                    .to_string(),
            });
        }
        Err(e) => return Err(e),
    };

    let url = format!("http://127.0.0.1:{port}{path}");
    let method_parsed =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = reqwest::Client::new()
        .request(method_parsed, &url)
        .header("Authorization", format!("Bearer {token}"))
        // Backend's PORTUNI_ALLOWED_ORIGINS includes tauri://localhost
        // so the existing origin allowlist accepts proxied requests.
        .header("Origin", "tauri://localhost");
    // Proves this request came through the Tauri host, not a spawned
    // agent terminal holding the same bearer token (#213) — the server's
    // env-mode write gate treats this header as proof of the desktop UI's
    // blanket write exemption. Only set when the sidecar for this
    // workspace is known to have one (always true once spawn_sidecar_ws
    // has run).
    if let Some(secret) = app
        .state::<WebviewProxySecrets>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&ws_id)
        .cloned()
    {
        req = req.header("X-Portuni-Webview-Proxy", secret);
    }
    if let Some(headers) = headers {
        for (k, v) in headers {
            // The host owns auth — drop any caller-provided Authorization
            // or webview-proxy-secret header to prevent webview JS from
            // spoofing one.
            if k.eq_ignore_ascii_case("authorization") || k.eq_ignore_ascii_case("x-portuni-webview-proxy") {
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

// True when `ws_id` is the active workspace at call time. Gates the
// `backend-ready` / `backend-error` emits: the webview boot contract
// (apps/web/src/lib/backend-url.ts) resolves/rejects on ANY such event, so
// events must only describe the workspace the webview is displaying.
// Non-active workspace state stays visible via list_workspaces (`running`).
fn is_active_ws(app: &AppHandle, ws_id: &str) -> bool {
    active_workspace(app).map(|(id, _)| id).ok().as_deref() == Some(ws_id)
}

// Kill one workspace's sidecar child if we still hold a handle to it, and
// drop its port entry. Used by the lifecycle commands (disable/delete/
// restart) and, via kill_all_sidecars, the app exit paths.
fn kill_sidecar_ws(app: &AppHandle, ws_id: &str) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.remove(ws_id) {
                info!("killing sidecar[{ws_id}] (pid={})", child.pid());
                let _ = child.kill();
            }
        }
    }
    if let Some(state) = app.try_state::<BackendPorts>() {
        if let Ok(mut guard) = state.0.lock() {
            guard.remove(ws_id);
        }
    }
}

// Kill every running sidecar. Called on the app exit paths that previously
// relied solely on `WindowEvent::Destroyed`.
fn kill_all_sidecars(app: &AppHandle) {
    let ids: Vec<String> = app
        .try_state::<SidecarState>()
        .and_then(|s| s.0.lock().ok().map(|g| g.keys().cloned().collect()))
        .unwrap_or_default();
    for id in ids {
        kill_sidecar_ws(app, &id);
    }
}

// Reap any orphan portuni-sidecar process holding our loopback port,
// then wait briefly for the OS to release the socket. Recovers from
// abnormal exits (force-kill, crash, OS-skipped Destroyed event) where
// the previous instance left a sidecar running. Bounded: we only kill
// processes whose binary name matches "portuni-sidecar", never anything
// else, even if it happens to occupy the port.
fn reap_orphan_sidecar(port: u16) {
    use std::process::Command;
    let lsof = Command::new("lsof")
        .args([
            "-nP",
            "-sTCP:LISTEN",
            "-t",
            &format!("-iTCP:{port}"),
        ])
        .output();
    let Ok(lsof) = lsof else {
        return;
    };
    let stdout = String::from_utf8_lossy(&lsof.stdout);
    let pids: Vec<u32> = stdout
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect();
    if pids.is_empty() {
        return;
    }
    let self_pid = std::process::id();
    for pid in pids {
        if pid == self_pid {
            continue;
        }
        let ps = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output();
        let Ok(ps) = ps else {
            continue;
        };
        let comm = String::from_utf8_lossy(&ps.stdout);
        if comm.contains("portuni-sidecar") {
            info!("reaping orphan sidecar pid={pid} on port {port}");
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
        } else {
            warn!(
                "port {port} held by pid={pid} ({}) — not portuni-sidecar, leaving alone",
                comm.trim()
            );
        }
    }
    // Give the kernel a moment to release the socket so the next bind() succeeds.
    std::thread::sleep(std::time::Duration::from_millis(300));
}

/// Append a raw sidecar line to the per-workspace log file. Best-effort:
/// all IO errors are silently ignored. Creates parent directories as needed.
fn append_ws_log(path: &Option<std::path::PathBuf>, line: &str) {
    if let Some(p) = path {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
        {
            use std::io::Write;
            let _ = writeln!(f, "{line}");
        }
    }
}

// Spawn (or no-op if already running) the sidecar for one workspace. Core
// mirrors the old single-sidecar path — Turso vs. central sync agent, port
// reaping, stdout port parsing — but keyed by workspace id into the state
// maps so multiple workspaces run concurrently on their own ports.
pub(crate) fn spawn_sidecar_ws(
    app: &AppHandle,
    ws_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_data = app.path().app_data_dir()?;
    let (_, all) = match workspace::load(&app_data)? {
        workspace::LoadedConfig::V2(f) => (f.active_workspace.clone(), f.workspaces),
        _ => return Err("config not migrated to workspaces".into()),
    };
    let cfg = all
        .get(ws_id)
        .cloned()
        .ok_or_else(|| format!("unknown workspace {ws_id}"))?;
    if !cfg.enabled {
        return Ok(());
    }
    // Re-invocations (post-login, retry) must not double-spawn.
    if app
        .state::<SidecarState>()
        .0
        .lock()
        .unwrap()
        .contains_key(ws_id)
    {
        info!("workspace {ws_id}: sidecar already running");
        return Ok(());
    }

    let ws_data_dir = workspace::workspace_data_dir(&app_data, ws_id);
    std::fs::create_dir_all(&ws_data_dir).ok();
    let data_dir_str = ws_data_dir.to_string_lossy().to_string();
    let is_central = workspace::is_central(&cfg);

    // In central data_mode the webview talks to the remote server for the
    // graph, and the LOCAL sidecar runs as a sync agent (teammate mirrors:
    // watcher + mirror/sync routes + the MCP front door, no graph db). The
    // agent needs a
    // device token, which needs a login — before login we only signal
    // readiness with the sentinel port (0) so the login gate can render;
    // google_login re-invokes spawn_sidecar_ws after a successful login.
    let mut agent_env: Option<Vec<(String, String)>> = None;
    if is_central {
        let server_url = cfg
            .server_url
            .clone()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().trim_end_matches('/').to_string());
        let device_token = server_url
            .as_ref()
            .and_then(|u| crate::pty::ensure_device_token(app, ws_id, u).ok());
        match (server_url, device_token) {
            (Some(url), Some(token)) => {
                info!("workspace {ws_id}: starting sync agent against {url}");
                agent_env = Some(vec![
                    ("PORTUNI_AGENT_MODE".to_string(), "1".to_string()),
                    ("PORTUNI_CENTRAL_URL".to_string(), url.clone()),
                    ("PORTUNI_CENTRAL_TOKEN".to_string(), token),
                    // PORTUNI_URL is the central base URL for the agent's
                    // REST client; per-mirror .mcp.json URLs still point at
                    // this sidecar's front door (resolvePortuniMcpUrl checks
                    // PORTUNI_AGENT_MODE first).
                    ("PORTUNI_URL".to_string(), url),
                ]);
            }
            _ => {
                info!("workspace {ws_id}: sync agent deferred (no server_url or not logged in)");
                app.state::<BackendPorts>()
                    .0
                    .lock()
                    .unwrap()
                    .insert(ws_id.to_string(), 0);
                // Emit only for the active workspace: the webview boot
                // resolves on any backend-ready, so another workspace's
                // sentinel must not complete the active workspace's boot.
                // Non-active status surfaces via list_workspaces instead.
                if is_active_ws(app, ws_id) {
                    let _ = app.emit("backend-ready", 0u16);
                }
                return Ok(());
            }
        }
    }

    let turso_url = if is_central {
        String::new()
    } else {
        cfg.turso_url.clone().unwrap_or_default()
    };
    let turso_token = if is_central {
        String::new() // the agent never sees Turso credentials
    } else {
        keychain_get_ws(KEYCHAIN_TURSO_ACCOUNT, ws_id).unwrap_or_default()
    };
    let workspace_root = cfg.effective_workspace_root();
    info!(
        "spawn_sidecar_ws[{ws_id}]: central={is_central} turso_url={} turso_auth_token={} workspace_root={}",
        if turso_url.is_empty() { "<unset>" } else { "<set>" },
        if turso_token.is_empty() { "<unset>" } else { "<set>" },
        workspace_root,
    );

    // Per-workspace persisted MCP token, cached in the AuthTokens map so
    // api_request / pty_spawn read it without touching Keychain each time.
    let auth_token = ensure_mcp_token_ws(ws_id).unwrap_or_else(|e| {
        warn!("Keychain unavailable for {ws_id} MCP token, using per-launch random: {e}");
        random_token()
    });
    app.state::<AuthTokens>()
        .0
        .lock()
        .unwrap()
        .insert(ws_id.to_string(), auth_token.clone());

    // Per-launch webview-proxy secret (#213): proves an env-mode REST write
    // came through this Tauri host's api_request proxy, not a spawned agent
    // terminal holding the same bearer token. Regenerated on every spawn,
    // kept only in memory and in the sidecar's own child-process env below.
    let webview_proxy_secret = random_token();
    app.state::<WebviewProxySecrets>()
        .0
        .lock()
        .unwrap()
        .insert(ws_id.to_string(), webview_proxy_secret.clone());

    // Tauri's webview ships requests from a non-loopback origin the backend's
    // default allowlist doesn't know about. Pass the Tauri origins explicitly.
    let allowed_origins = [
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ]
    .join(",");

    // The Bun-compiled sidecar walks up from cwd looking for the platform
    // @libsql native binding; set cwd to the staged sidecar-deps dir so a
    // Finder-launched .app (cwd=/) still resolves it.
    let resource_dir = app.path().resource_dir()?;
    let sidecar_cwd = resource_dir.join("sidecar-deps");
    if !sidecar_cwd.exists() {
        warn!("sidecar-deps dir missing at {:?}", sidecar_cwd);
    }

    // Stable per-workspace loopback port so external .mcp.json configs stay
    // valid; reap any orphan sidecar holding it before binding.
    let port = cfg.mcp_port.unwrap_or(workspace::DEFAULT_MCP_PORT_BASE);
    reap_orphan_sidecar(port);

    let mut envs: Vec<(String, String)> = vec![
        ("PORTUNI_DATA_DIR".to_string(), data_dir_str),
        ("PORTUNI_PORT".to_string(), port.to_string()),
        ("PORTUNI_AUTH_TOKEN".to_string(), auth_token),
        ("PORTUNI_WEBVIEW_PROXY_SECRET".to_string(), webview_proxy_secret),
        ("PORTUNI_WORKSPACE_ROOT".to_string(), workspace_root),
        ("PORTUNI_WORKSPACE_ID".to_string(), ws_id.to_string()),
        ("PORTUNI_ALLOWED_ORIGINS".to_string(), allowed_origins),
        ("PORTUNI_LOG_REQUESTS".to_string(), "1".to_string()),
        ("HOME".to_string(), std::env::var("HOME").unwrap_or_default()),
        ("PATH".to_string(), std::env::var("PATH").unwrap_or_default()),
    ];
    // portuni-guard.sh is staged into sidecar-deps by build-sidecar.mjs. The
    // compiled sidecar cannot resolve it repo-relative, so hand it the staged
    // path explicitly — without this, materialized mirrors get no hooks block
    // and the tier-3 write guard is silently unenforced.
    let guard_script = sidecar_cwd.join("portuni-guard.sh");
    if guard_script.exists() {
        envs.push((
            "PORTUNI_GUARD_SCRIPT".to_string(),
            guard_script.to_string_lossy().to_string(),
        ));
    } else {
        warn!(
            "portuni-guard.sh missing at {:?}; tier-3 guard hooks will be omitted",
            guard_script
        );
    }
    match agent_env {
        // Central sync agent: central URL + device token, no Turso.
        Some(extra) => envs.extend(extra),
        // Local sidecar: direct Turso credentials, as before.
        None => {
            envs.push(("TURSO_URL".to_string(), turso_url));
            envs.push(("TURSO_AUTH_TOKEN".to_string(), turso_token));
        }
    }
    let mut cmd = app
        .shell()
        .sidecar("portuni-sidecar")?
        .current_dir(sidecar_cwd)
        .env_clear();
    for (k, v) in envs {
        cmd = cmd.env(k, v);
    }
    let (mut rx, child) = cmd.spawn()?;
    app.state::<SidecarState>()
        .0
        .lock()
        .unwrap()
        .insert(ws_id.to_string(), child);

    let handle = app.clone();
    let ws = ws_id.to_string();
    let ws_log_path = app
        .path()
        .app_log_dir()
        .ok()
        .map(|d| d.join(format!("sidecar-{ws_id}.log")));
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).into_owned();
                    let line = line.trim_end_matches(['\n', '\r']);
                    append_ws_log(&ws_log_path, line);
                    if let Some(rest) = line.strip_prefix("PORTUNI_LISTENING_PORT=") {
                        if let Ok(port) = rest.trim().parse::<u16>() {
                            handle
                                .state::<BackendPorts>()
                                .0
                                .lock()
                                .unwrap()
                                .insert(ws.clone(), port);
                            // Webview boot contract: it resolves/rejects on
                            // any backend-ready/-error, so only the ACTIVE
                            // workspace's sidecar may emit. Non-active status
                            // surfaces via list_workspaces (`running`).
                            if is_active_ws(&handle, &ws) {
                                let _ = handle.emit("backend-ready", port);
                            }
                            info!("sidecar[{ws}] ready on port {port}");
                        }
                    } else if let Some(rest) = line.strip_prefix("PORTUNI_BACKEND_ERROR=") {
                        let msg = rest.trim().to_string();
                        error!("sidecar[{ws}] backend error: {msg}");
                        // Active-only: a non-active workspace's startup
                        // failure must not reject the webview boot.
                        if is_active_ws(&handle, &ws) {
                            let _ = handle.emit("backend-error", msg);
                        }
                    } else {
                        info!("sidecar[{ws}]: {line}");
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line).into_owned();
                    let line = line.trim_end_matches(['\n', '\r']);
                    append_ws_log(&ws_log_path, line);
                    warn!("sidecar[{ws}]:err: {line}");
                }
                CommandEvent::Terminated(payload) => {
                    error!("sidecar[{ws}] terminated: code={:?}", payload.code);
                    handle
                        .state::<BackendPorts>()
                        .0
                        .lock()
                        .unwrap()
                        .remove(&ws);
                    // Active-only (webview boot contract): another
                    // workspace's crash must not take down the UI boot;
                    // it stays visible via list_workspaces (`running`).
                    if is_active_ws(&handle, &ws) {
                        let _ = handle.emit(
                            "backend-error",
                            format!("sidecar {ws} terminated (exit code {:?})", payload.code),
                        );
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}

// Spawn a sidecar for every enabled workspace. Called from .setup(). A v1 or
// Missing config is a no-op — the app waits on migration/onboarding first.
pub(crate) fn spawn_all_sidecars(app: &AppHandle) {
    let Ok(app_data) = app.path().app_data_dir() else {
        return;
    };
    let file = match workspace::load(&app_data) {
        Ok(workspace::LoadedConfig::V2(f)) => f,
        Ok(_) => {
            info!("config awaiting migration/onboarding; no sidecars spawned");
            return;
        }
        Err(e) => {
            error!("config.json unreadable: {e}");
            let _ = app.emit("backend-error", format!("config.json: {e}"));
            return;
        }
    };
    // Each enabled workspace spawns on its own OS thread rather than serially:
    // spawn_sidecar_ws's reap_orphan_sidecar sleeps 300ms per call, so a
    // serial loop added 300ms of boot latency per extra workspace. Threads
    // race to call spawn_sidecar_ws, but that's safe — its contains_key
    // check against SidecarState is the single double-spawn guard regardless
    // of which thread (or a later re-invocation, e.g. post-login) gets there
    // first.
    for (id, cfg) in &file.workspaces {
        if !cfg.enabled {
            continue;
        }
        let handle = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            if let Err(e) = spawn_sidecar_ws(&handle, &id) {
                error!("failed to spawn sidecar for {id}: {e}");
            }
        });
    }
}

// Remove one workspace's entries from all three user-scoped agent configs.
// Best-effort per file: a missing file is fine; a parse error propagates.
// Resolves the MCP entry name from the (still-present) workspace config, then
// delegates to remove_global_mcp_entries_by_name. delete_workspace must
// instead resolve the name BEFORE it removes the workspace from config and
// call the by-name helper directly (the config no longer has the entry to
// look the name up from at cleanup time).
fn remove_global_mcp_entries(app: &AppHandle, ws_id: &str) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let name = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f
            .workspaces
            .get(ws_id)
            .map(|c| workspace::mcp_server_name(ws_id, c))
            .unwrap_or_else(|| format!("portuni-{ws_id}")),
        _ => format!("portuni-{ws_id}"),
    };
    remove_global_mcp_entries_by_name(&name)
}

// Remove the given MCP server entry from all three user-scoped agent configs.
// Best-effort per file: a missing file is fine; a parse error propagates.
fn remove_global_mcp_entries_by_name(name: &str) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let claude = PathBuf::from(&home).join(".claude.json");
    if let Ok(raw) = std::fs::read_to_string(&claude) {
        let next = mcp_install::remove_claude_server(Some(&raw), name)?;
        std::fs::write(&claude, next).map_err(|e| e.to_string())?;
    }
    let codex = PathBuf::from(&home).join(".codex").join("config.toml");
    if let Ok(raw) = std::fs::read_to_string(&codex) {
        std::fs::write(&codex, mcp_install::remove_codex_block(&raw, name))
            .map_err(|e| e.to_string())?;
    }
    let vibe = PathBuf::from(&home).join(".vibe").join("config.toml");
    if let Ok(raw) = std::fs::read_to_string(&vibe) {
        let next = mcp_install::remove_vibe_server(&raw, name)?;
        std::fs::write(&vibe, next).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
struct WorkspaceInfo {
    id: String,
    label: String,
    data_mode: String,
    enabled: bool,
    mcp_port: Option<u16>,
    active: bool,
    running: bool,
    // True when the BackendPorts entry for this workspace is the central
    // sentinel (Some(0)): a central-mode sync agent that is deferred because
    // the user has not logged in yet (see spawn_sidecar_ws). Distinct from
    // "not running" (no entry at all, or a crashed/never-spawned sidecar) so
    // the UI can show "waiting for login" instead of a plain error state.
    deferred: bool,
    mcp_server_name: String,
    workspace_root: String,
    // True when a ws:<id> window is currently open for this workspace
    // (#226) -- read live from app.webview_windows(), not from the
    // persisted open_windows (which can lag a focus-only change). Drives
    // the Sidebar switcher's "already open" marking.
    window_open: bool,
}

#[tauri::command]
fn list_workspaces(app: AppHandle) -> Result<Vec<WorkspaceInfo>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => return Ok(vec![]),
    };
    let ports_state = app.state::<BackendPorts>();
    let ports = ports_state.0.lock().map_err(|e| e.to_string())?;
    Ok(file
        .workspaces
        .iter()
        .map(|(id, cfg)| WorkspaceInfo {
            id: id.clone(),
            label: cfg.label.clone().unwrap_or_else(|| id.clone()),
            data_mode: if workspace::is_central(cfg) {
                "central"
            } else {
                "local"
            }
            .to_string(),
            enabled: cfg.enabled,
            mcp_port: cfg.mcp_port,
            active: *id == file.active_workspace,
            running: ports.get(id).is_some_and(|p| *p > 0),
            deferred: ports.get(id).is_some_and(|p| *p == 0),
            mcp_server_name: workspace::mcp_server_name(id, cfg),
            workspace_root: cfg.effective_workspace_root(),
            window_open: window_open_for(&app, id),
        })
        .collect())
}

// Focus ws:<id> if it already has a window, else create one (#226) -- the
// switcher's single entry point, replacing set_active_workspace + a full
// page reload. Validates the workspace exists and is enabled first:
// open_window itself doesn't check, and a disabled/unknown id would
// otherwise silently create an unusable window.
#[tauri::command]
fn open_workspace_window(app: AppHandle, id: String) -> Result<(), String> {
    let label = format!("ws:{id}");
    if let Some(w) = app.get_webview_window(&label) {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(file) => match file.workspaces.get(&id) {
            Some(cfg) if cfg.enabled => {}
            Some(_) => return Err(format!("workspace '{id}' is disabled")),
            None => return Err(format!("unknown workspace '{id}'")),
        },
        _ => return Err("config not migrated to workspaces yet".to_string()),
    }
    open_window(&app, &label).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct CreateWorkspaceArgs {
    id: String,
    label: Option<String>,
    data_mode: String, // "local" | "central"
    turso_url: Option<String>,
    server_url: Option<String>,
    google_client_id: Option<String>,
    google_client_secret: Option<String>,
    workspace_root: String,
}

#[tauri::command]
fn create_workspace(app: AppHandle, args: CreateWorkspaceArgs) -> Result<(), String> {
    if !workspace::is_valid_workspace_id(&args.id) {
        return Err("invalid workspace id (use lowercase letters, digits, dashes)".to_string());
    }
    with_config_mut(&app, |file| {
        if file.workspaces.contains_key(&args.id) {
            return Err(format!("workspace '{}' already exists", args.id));
        }
        let port = workspace::allocate_port(&file.workspaces);
        let cfg = workspace::WorkspaceConfig {
            label: args.label.clone(),
            enabled: true,
            turso_url: args.turso_url.clone().filter(|s| !s.trim().is_empty()),
            workspace_root: Some(args.workspace_root.clone()),
            mcp_port: Some(port),
            server_url: args.server_url.clone().filter(|s| !s.trim().is_empty()),
            google_client_id: args.google_client_id.clone().filter(|s| !s.trim().is_empty()),
            google_client_secret: args
                .google_client_secret
                .clone()
                .filter(|s| !s.trim().is_empty()),
            data_mode: if args.data_mode == "central" {
                Some("central".to_string())
            } else {
                None
            },
            mcp_server_name: None,
        };
        file.workspaces.insert(args.id.clone(), cfg);
        Ok(())
    })?;
    if let Err(e) = spawn_sidecar_ws(&app, &args.id) {
        warn!("new workspace {} sidecar spawn failed: {e}", args.id);
    }
    // Open and focus the new workspace's own window (#225).
    let label = format!("ws:{}", args.id);
    if let Err(e) = open_window(&app, &label) {
        warn!("new workspace {}: window open failed: {e}", args.id);
    } else if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn set_active_workspace(app: AppHandle, id: String) -> Result<(), String> {
    with_config_mut(&app, |file| {
        if !file.workspaces.contains_key(&id) {
            return Err(format!("unknown workspace '{id}'"));
        }
        file.active_workspace = id.clone();
        Ok(())
    })
}

#[tauri::command]
fn set_workspace_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    if !enabled && window_open_for(&app, &id) {
        return Err("Nejdřív zavři okno tohoto workspace.".to_string());
    }
    let history = focus_history_snapshot(&app);
    with_config_mut(&app, |file| {
        {
            let cfg = file
                .workspaces
                .get_mut(&id)
                .ok_or_else(|| format!("unknown workspace '{id}'"))?;
            cfg.enabled = enabled;
        }
        // The window-open guard above already means this workspace's own
        // window is closed, but the value config.json last recorded as
        // active_workspace can still be stale-pointing at it (persisted
        // only on open/close, not on every focus) -- reassign so a later
        // "empty open_windows -> fall back to active_workspace" startup
        // never lands on a disabled workspace.
        if !enabled && file.active_workspace == id {
            file.active_workspace = reassign_active_workspace(&id, &history, &file.workspaces);
        }
        Ok(())
    })?;
    if enabled {
        if let Err(e) = spawn_sidecar_ws(&app, &id) {
            warn!("enable {id}: sidecar spawn failed: {e}");
        }
    } else {
        kill_sidecar_ws(&app, &id);
        remove_global_mcp_entries(&app, &id).unwrap_or_else(|e| warn!("uninstall {id}: {e}"));
    }
    Ok(())
}

#[tauri::command]
fn delete_workspace(app: AppHandle, id: String) -> Result<(), String> {
    if window_open_for(&app, &id) {
        return Err("Nejdřív zavři okno tohoto workspace.".to_string());
    }
    let history = focus_history_snapshot(&app);
    let mut mcp_name = String::new();
    with_config_mut(&app, |file| {
        if file.workspaces.len() == 1 {
            return Err("cannot delete the last workspace".to_string());
        }
        if !file.workspaces.contains_key(&id) {
            return Err(format!("unknown workspace '{id}'"));
        }
        // Resolve the MCP entry name while the workspace is still in config
        // — the migrated workspace keeps the historical "portuni" name,
        // which we could not recover once it's removed below.
        mcp_name = file
            .workspaces
            .get(&id)
            .map(|c| workspace::mcp_server_name(&id, c))
            .unwrap_or_else(|| format!("portuni-{id}"));
        // Stop the sidecar (a process, no persisted state) before the
        // commit point below.
        kill_sidecar_ws(&app, &id);
        // COMMIT POINT: drop the workspace from config.json; with_config_mut
        // persists it right after this closure returns. If that save fails
        // we return early having touched no credentials — the workspace is
        // still fully intact (config lists it, Keychain holds its secrets)
        // and its sidecar re-spawns on the next launch.
        file.workspaces.remove(&id);
        // See set_workspace_enabled's comment: config.json's active_workspace
        // can be stale-pointing at the just-deleted id even though its
        // window (guarded above) is already closed.
        if file.active_workspace == id {
            file.active_workspace = reassign_active_workspace(&id, &history, &file.workspaces);
        }
        Ok(())
    })?;
    // Config committed — the workspace is gone. Everything below is best-effort
    // cleanup of now-orphaned state, logged but never propagated, so a Keychain
    // or config-file hiccup cannot leave the workspace half-listed with its
    // credentials already deleted.
    remove_global_mcp_entries_by_name(&mcp_name)
        .unwrap_or_else(|e| warn!("uninstall {id}: {e}"));
    for base in [
        "turso_auth_token",
        "mcp_auth_token",
        "google_refresh_token",
        "portuni_session_jwt",
        "portuni_device_token",
    ] {
        keychain_delete_ws(base, &id);
    }
    // Data dir + mirrors stay on disk by design (spec §5): destructive
    // cleanup is manual only. The UI dialog states what remains.
    Ok(())
}

// --- CLI profiles registry (phase 3, spawn UX) -----------------------------
//
// Non-secret, so it lives in config.json like the workspace registry rather
// than Keychain. Zero registered profiles keeps the whole feature invisible
// on the web side; these commands are only ever called from the Settings
// "Profily" section and the per-spawn picker.
//
// #207: env VALUES never leave this process. list_profiles returns only key
// NAMES -- a value round-tripped through list_profiles would violate "no
// secret in webview JS, ever" the moment a value actually is one, even
// though this registry is meant for non-secret config. create_profile/
// update_profile additionally reject secret-shaped keys outright (see
// workspace::is_secret_shaped_env_key) so a user pasting e.g.
// ANTHROPIC_API_KEY=... gets pointed at the Keychain instead of persisting
// it to plaintext config.json. Because values are never read back, editing
// an existing profile is a partial-update: update_profile treats an empty
// submitted value for a key that already exists as "leave unchanged"
// (apps/web/src/components/ProfilesSection.tsx pre-fills existing keys with
// an empty value for exactly this reason) -- only a non-empty value
// actually overwrites the stored one.

fn reject_secret_shaped_keys(env: &std::collections::BTreeMap<String, String>) -> Result<(), String> {
    for key in env.keys() {
        if workspace::is_secret_shaped_env_key(key) {
            return Err(format!(
                "'{key}' looks like a secret (matches *_TOKEN/*_KEY/*_SECRET/*PASSWORD*) -- store secrets in the OS keychain, not the profiles registry"
            ));
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct ProfileInfo {
    id: String,
    label: String,
    env_keys: Vec<String>,
    command: Option<String>,
}

#[derive(Serialize)]
struct ProfilesData {
    profiles: Vec<ProfileInfo>,
    default_by_org: std::collections::BTreeMap<String, String>,
}

#[tauri::command]
fn list_profiles(app: AppHandle) -> Result<ProfilesData, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => {
            return Ok(ProfilesData {
                profiles: vec![],
                default_by_org: std::collections::BTreeMap::new(),
            })
        }
    };
    Ok(ProfilesData {
        profiles: file
            .profiles
            .into_iter()
            .map(|(id, cfg)| ProfileInfo {
                id,
                label: cfg.label,
                env_keys: cfg.env.into_keys().collect(),
                command: cfg.command,
            })
            .collect(),
        default_by_org: file.default_profile_by_org,
    })
}

#[derive(Deserialize)]
struct CreateProfileArgs {
    id: String,
    label: String,
    env: std::collections::BTreeMap<String, String>,
    command: Option<String>,
}

#[tauri::command]
fn create_profile(app: AppHandle, args: CreateProfileArgs) -> Result<(), String> {
    if !workspace::is_valid_profile_id(&args.id) {
        return Err("invalid profile id (use lowercase letters, digits, dashes)".to_string());
    }
    if args.label.trim().is_empty() {
        return Err("profile label is required".to_string());
    }
    reject_secret_shaped_keys(&args.env)?;
    with_config_mut(&app, |file| {
        if file.profiles.contains_key(&args.id) {
            return Err(format!("profile '{}' already exists", args.id));
        }
        file.profiles.insert(
            args.id.clone(),
            workspace::ProfileConfig {
                label: args.label.clone(),
                env: args.env.clone(),
                command: args.command.clone().filter(|s| !s.trim().is_empty()),
            },
        );
        Ok(())
    })
}

#[derive(Deserialize)]
struct UpdateProfileArgs {
    id: String,
    label: String,
    env: std::collections::BTreeMap<String, String>,
    command: Option<String>,
}

/// Merge a profile update's submitted env into its stored one: an empty
/// submitted value for a key that already exists means "leave unchanged"
/// (the webview never received the old value to resubmit it verbatim, see
/// ProfilesSection.tsx's envKeysToText) -- only a non-empty value, or a
/// genuinely new key, is actually stored as given. A key omitted from
/// `submitted` entirely is dropped (the user deleted that line).
fn merge_profile_env_update(
    stored: &std::collections::BTreeMap<String, String>,
    submitted: std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    submitted
        .into_iter()
        .map(|(k, v)| {
            if v.is_empty() {
                if let Some(existing) = stored.get(&k) {
                    return (k, existing.clone());
                }
            }
            (k, v)
        })
        .collect()
}

#[tauri::command]
fn update_profile(app: AppHandle, args: UpdateProfileArgs) -> Result<(), String> {
    if args.label.trim().is_empty() {
        return Err("profile label is required".to_string());
    }
    reject_secret_shaped_keys(&args.env)?;
    with_config_mut(&app, |file| {
        let cfg = file
            .profiles
            .get_mut(&args.id)
            .ok_or_else(|| format!("unknown profile '{}'", args.id))?;
        cfg.label = args.label.clone();
        cfg.env = merge_profile_env_update(&cfg.env, args.env.clone());
        cfg.command = args.command.clone().filter(|s| !s.trim().is_empty());
        Ok(())
    })
}

// Narrow, purpose-built exception to "list_profiles never returns env
// values" (#207): DetailPane.sessions.tsx's resume-info check needs the
// resumed session's CLAUDE_CONFIG_DIR value to ask the sidecar about
// conversation-resumability at the right transcript location (#204).
// CLAUDE_CONFIG_DIR is a plain directory path, never secret-shaped
// (create_profile/update_profile reject secret-shaped keys outright), and
// this command exposes exactly that one well-known key -- not the general
// env map -- so it cannot become a path for a future secret-shaped key to
// leak into the webview the way returning the whole map would.
#[tauri::command]
fn profile_config_dir(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => return Ok(None),
    };
    Ok(file.profiles.get(&id).and_then(|cfg| cfg.env.get("CLAUDE_CONFIG_DIR").cloned()))
}

#[tauri::command]
fn delete_profile(app: AppHandle, id: String) -> Result<(), String> {
    with_config_mut(&app, |file| {
        if !file.profiles.contains_key(&id) {
            return Err(format!("unknown profile '{id}'"));
        }
        file.profiles.remove(&id);
        file.default_profile_by_org.retain(|_, p| p != &id);
        Ok(())
    })
}

#[tauri::command]
fn set_default_profile_for_org(
    app: AppHandle,
    org_id: String,
    profile_id: Option<String>,
) -> Result<(), String> {
    with_config_mut(&app, |file| {
        match &profile_id {
            Some(pid) => {
                if !file.profiles.contains_key(pid) {
                    return Err(format!("unknown profile '{pid}'"));
                }
                file.default_profile_by_org.insert(org_id.clone(), pid.clone());
            }
            None => {
                file.default_profile_by_org.remove(&org_id);
            }
        }
        Ok(())
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // State maps start empty and are filled per workspace by .setup()'s
    // spawn_all_sidecars — each spawn_sidecar_ws caches that workspace's
    // MCP token into AuthTokens and its bound port into BackendPorts.
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Per-window (by label) size/position persistence (#225): each
        // ws:<id> window remembers its own geometry across launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Logger plugin is initialised before spawn_all_sidecars so every line we
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
        .manage(SidecarState(Mutex::new(HashMap::new())))
        .manage(BackendPorts(Mutex::new(HashMap::new())))
        .manage(AuthTokens(Mutex::new(HashMap::new())))
        .manage(WebviewProxySecrets(Mutex::new(HashMap::new())))
        .manage(ConfigLock(Mutex::new(())))
        .manage(FocusHistory(Mutex::new(Vec::new())))
        .manage(pty::PtyState::default())
        .manage(updater::PendingUpdate::default())
        .register_uri_scheme_protocol("portuni-html", |ctx, request| {
            use tauri::http::Response;
            let app = ctx.app_handle();
            // URL: portuni-html://localhost/<percent-encoded absolute path>
            // Strip exactly one leading slash (the literal '/' that separates
            // the authority from the path in the URL). Using strip_prefix
            // rather than trim_start_matches so we only consume one character,
            // matching the FE contract: portuni-html://localhost/<encodeURIComponent(absPath)>.
            let raw_path = request.uri().path();
            let raw = raw_path.strip_prefix('/').unwrap_or(raw_path);
            let decoded = percent_encoding::percent_decode_str(raw)
                .decode_utf8_lossy()
                .to_string();
            let candidate = std::path::PathBuf::from(&decoded);

            // Scope the preview to THIS WINDOW's workspace mirror root (#223)
            // -- resolved from the requesting webview's own label, not the
            // globally-"active" workspace, so a preview in one window can
            // never read another window's mirror. Expand the config's
            // leading ~ (the sidecar does this for the absolute local_path
            // we compare against); fall back to the raw value if the home
            // dir is somehow unavailable.
            let root = app
                .path()
                .app_data_dir()
                .ok()
                .and_then(|data_dir| ws_of_from_dir(ctx.webview_label(), &data_dir).ok())
                .and_then(|ws_id| workspace_config_for(app, &ws_id).ok())
                .map(|cfg| {
                    let raw = cfg.effective_workspace_root();
                    match app.path().home_dir() {
                        Ok(h) => expand_tilde(&h, &raw),
                        Err(_) => std::path::PathBuf::from(raw),
                    }
                });

            let forbidden = || {
                Response::builder()
                    .status(403)
                    .header("Content-Type", "text/plain")
                    .body(b"forbidden".to_vec())
                    .unwrap()
            };

            let Some(root) = root else { return forbidden() };
            if !path_within_root(&root, &candidate) {
                error!("portuni-html refused out-of-scope path: {decoded}");
                return forbidden();
            }
            // Defense-in-depth: only serve .html/.htm files. The preview
            // never requests anything else, so this never breaks normal use;
            // it narrows what the protocol can serve even if the scope check
            // were somehow bypassed.
            let ext_ok = candidate
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
                .unwrap_or(false);
            if !ext_ok {
                error!("portuni-html refused non-html path: {decoded}");
                return forbidden();
            }
            match std::fs::read(&candidate) {
                Ok(bytes) => Response::builder()
                    .status(200)
                    .header("Content-Type", "text/html; charset=utf-8")
                    // Own permissive CSP: this origin is sandboxed (no
                    // allow-same-origin) and isolated from the app, so the
                    // app CSP is intentionally NOT applied here.
                    .header("Content-Security-Policy", "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'")
                    .body(bytes)
                    .unwrap(),
                Err(e) => {
                    error!("portuni-html read failed for {decoded}: {e}");
                    Response::builder()
                        .status(404)
                        .header("Content-Type", "text/plain")
                        .body(b"not found".to_vec())
                        .unwrap()
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            approve_exit,
            decline_exit,
            get_backend_port,
            get_data_mode,
            open_external,
            api_request,
            set_turso_token,
            clear_turso_token,
            get_turso_status,
            save_config,
            setup_central,
            restart_sidecar,
            workspace_migration_status,
            migrate_to_workspaces,
            get_mcp_token,
            regenerate_mcp_token,
            install_claude_global,
            install_codex_global,
            install_vibe_global,
            launch_claude_for_node,
            open_in_finder,
            open_path_external,
            clipboard_file_path,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            auth::auth_status,
            auth::google_login,
            auth::google_client_configured,
            auth::google_drive_connect,
            auth::auth_refresh,
            auth::auth_logout,
            auth::central_request,
            list_workspaces,
            create_workspace,
            set_active_workspace,
            set_workspace_enabled,
            delete_workspace,
            open_workspace_window,
            list_profiles,
            create_profile,
            update_profile,
            delete_profile,
            set_default_profile_for_org,
            profile_config_dir,
            updater::check_update,
            updater::install_update,
            updater::restart_app,
            updater::get_app_version,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // app.windows in tauri.conf.json is [] (#222): the startup
            // window(s) are created here instead of automatically, restoring
            // open_windows (#225) or falling back to a single window / bootstrap.
            create_startup_windows(&handle)?;
            // Each enabled workspace gets its own sidecar; spawn_sidecar_ws
            // caches the per-workspace MCP token into AuthTokens as it goes.
            // A v1/Missing config is a no-op until migration/onboarding.
            spawn_all_sidecars(&handle);
            // Replace the native Quit menu item with our own. The default
            // item uses the macOS `terminate:` selector, which destroys the
            // window and ends the process WITHOUT ever firing
            // RunEvent::ExitRequested (verified empirically) — so Cmd+Q
            // bypassed every JS guard. A custom item with the same
            // accelerator routes through on_menu_event instead, where the
            // exit is delegated to the webview guards.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind};
                let menu = Menu::default(&handle)?;
                if let Some(MenuItemKind::Submenu(app_menu)) =
                    menu.items()?.into_iter().next()
                {
                    // The standard macOS app submenu always ends with Quit.
                    let items = app_menu.items()?;
                    if let Some(last) = items.last() {
                        let _ = match last {
                            MenuItemKind::MenuItem(i) => app_menu.remove(i),
                            MenuItemKind::Predefined(i) => app_menu.remove(i),
                            MenuItemKind::Submenu(i) => app_menu.remove(i),
                            MenuItemKind::Check(i) => app_menu.remove(i),
                            MenuItemKind::Icon(i) => app_menu.remove(i),
                        };
                    }
                    let quit = MenuItem::with_id(
                        &handle,
                        "portuni-quit",
                        "Quit Portuni",
                        true,
                        Some("CmdOrCtrl+Q"),
                    )?;
                    app_menu.append(&quit)?;
                }
                app.set_menu(menu)?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "portuni-quit" {
                // Same contract as the run-handler gate: ask the webview
                // guards when there is a window to ask; otherwise just exit.
                // "Any window" rather than a fixed "main" label (#222): a
                // window is now "bootstrap" or "ws:<id>", never "main".
                if !EXIT_APPROVED.load(Ordering::SeqCst)
                    && !app.webview_windows().is_empty()
                    && app.emit("app-exit-requested", ()).is_ok()
                {
                    info!("quit requested (menu/Cmd+Q) — delegated to webview guards");
                    schedule_exit_fallback(app);
                } else {
                    app.exit(0);
                }
            }
        })
        .on_window_event(|window, event| {
            // Only Destroyed, not CloseRequested: the webview registers an
            // onCloseRequested listener (dirty-editor guard), so a close
            // request may be cancelled in JS. Killing the sidecars on the
            // request would leave a live window with dead backends.
            // Cmd+Q / app exit is covered by ExitRequested/Exit below.
            // TODO(#229): this kills EVERY workspace's sidecar on ANY
            // window closing, which is wrong once more than one can be
            // open -- sidecar teardown moves to app-exit-only there.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                kill_all_sidecars(window.app_handle());
            }
            // #225: track ws:<id> windows for open_windows/active_workspace
            // persistence. "bootstrap" is never a workspace and ws_of
            // rejects it, so this is a no-op for it.
            match event {
                tauri::WindowEvent::Focused(true) => {
                    if let Ok(ws_id) = ws_of(window) {
                        if let Some(state) = window.app_handle().try_state::<FocusHistory>() {
                            if let Ok(mut history) = state.0.lock() {
                                touch_focus(&mut history, &ws_id);
                            }
                        }
                        // Not persisted here -- only in-memory. persist_open_windows
                        // (called on the next open/close) is what writes it out,
                        // matching the spec's "not on every focus change".
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if let Ok(ws_id) = ws_of(window) {
                        let app = window.app_handle();
                        if let Some(state) = app.try_state::<FocusHistory>() {
                            if let Ok(mut history) = state.0.lock() {
                                untrack_focus(&mut history, &ws_id);
                            }
                        }
                        persist_open_windows(app);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Explicit exit: prevent it once and hand the decision to the
            // webview guards (dirty editor, unsynced files) via
            // `app-exit-requested`; the webview answers with approve_exit,
            // whose re-exit passes the EXIT_APPROVED gate. macOS Cmd+Q /
            // menu Quit arrives via the native `terminate:` selector as
            // ExitRequested with code None — the same code the
            // all-windows-closed exit carries — so the branches are told
            // apart by whether a window still exists: Cmd+Q fires with a
            // window alive, the post-close exit fires after it was
            // destroyed (its JS onCloseRequested guard already ran). "Any
            // window" rather than a fixed "main" label (#222): a window is
            // now "bootstrap" or "ws:<id>", never "main". If there is no
            // window to ask — or the emit fails — never block the exit.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                let approved = EXIT_APPROVED.load(Ordering::SeqCst);
                let has_window = !app.webview_windows().is_empty();
                info!("exit requested (code={code:?}, approved={approved}, window={has_window})");
                if !approved && has_window && app.emit("app-exit-requested", ()).is_ok() {
                    api.prevent_exit();
                    schedule_exit_fallback(app);
                    return;
                }
            }
            // Catch the macOS Cmd+Q / app-relaunch path that does not always
            // tear down the window first. ExitRequested fires before the
            // process exits; Exit is the final point where we still hold
            // the AppHandle. Killing twice is harmless (handle is taken).
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                kill_all_sidecars(app);
            }
        });
}

#[cfg(test)]
mod ws_of_tests {
    use super::ws_of_from_dir;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "portuni-ws-of-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn valid_label_resolves_a_registered_workspace() {
        let dir = temp_dir("valid");
        let file = crate::workspace::migrate_v1_value(&serde_json::json!({}), "acme");
        crate::workspace::save(&dir, &file).unwrap();
        assert_eq!(ws_of_from_dir("ws:acme", &dir).unwrap(), "acme");
    }

    #[test]
    fn unknown_workspace_id_is_an_error() {
        let dir = temp_dir("unknown");
        let file = crate::workspace::migrate_v1_value(&serde_json::json!({}), "acme");
        crate::workspace::save(&dir, &file).unwrap();
        assert!(ws_of_from_dir("ws:nope", &dir).is_err());
    }

    #[test]
    fn bootstrap_label_is_an_error() {
        let dir = temp_dir("bootstrap");
        let file = crate::workspace::migrate_v1_value(&serde_json::json!({}), "acme");
        crate::workspace::save(&dir, &file).unwrap();
        assert!(ws_of_from_dir("bootstrap", &dir).is_err());
    }

    #[test]
    fn garbage_label_is_an_error() {
        let dir = temp_dir("garbage");
        assert!(ws_of_from_dir("not-a-real-label", &dir).is_err());
        assert!(ws_of_from_dir("ws:", &dir).is_err(), "empty id after the prefix");
        assert!(ws_of_from_dir("", &dir).is_err());
    }
}

#[cfg(test)]
mod config_lock_tests {
    use super::with_config_mut_at;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier, Mutex};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "portuni-config-lock-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // The bug #224 fixes: two commands each doing their own load ->
    // modify -> workspace::save (no lock) can interleave -- thread A loads,
    // thread B loads the same pre-A-write state, A saves, B saves and
    // clobbers A's change. Guarding the whole cycle with one Mutex<()>
    // serializes them so both edits land regardless of interleaving.
    #[test]
    fn two_concurrent_mutations_both_land() {
        let dir = temp_dir("concurrent");
        let seed = crate::workspace::migrate_v1_value(&serde_json::json!({}), "seed");
        crate::workspace::save(&dir, &seed).unwrap();

        let lock = Arc::new(Mutex::new(()));
        // Release both threads at the same instant so a missing lock would
        // actually race in practice, not just in theory.
        let barrier = Arc::new(Barrier::new(2));

        let handles: Vec<_> = ["alpha", "beta"]
            .into_iter()
            .map(|id| {
                let lock = lock.clone();
                let dir = dir.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    with_config_mut_at(&lock, &dir, |file| {
                        file.workspaces.insert(
                            id.to_string(),
                            crate::workspace::WorkspaceConfig::default(),
                        );
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let file = match crate::workspace::load(&dir).unwrap() {
            crate::workspace::LoadedConfig::V2(f) => f,
            _ => panic!("expected V2"),
        };
        assert!(file.workspaces.contains_key("seed"));
        assert!(file.workspaces.contains_key("alpha"), "alpha's write was lost");
        assert!(file.workspaces.contains_key("beta"), "beta's write was lost");
    }
}

#[cfg(test)]
mod multi_window_phase2_tests {
    use super::{
        is_window_open_for, reassign_active_workspace, startup_window_labels, touch_focus,
        untrack_focus,
    };
    use crate::workspace::{WorkspaceConfig, WorkspacesFile};
    use std::collections::BTreeMap;

    fn ws(enabled: bool) -> WorkspaceConfig {
        WorkspaceConfig {
            enabled,
            ..Default::default()
        }
    }

    fn file(active: &str, open_windows: &[&str], workspaces: &[(&str, bool)]) -> WorkspacesFile {
        WorkspacesFile {
            config_version: 2,
            active_workspace: active.to_string(),
            workspaces: workspaces
                .iter()
                .map(|(id, enabled)| (id.to_string(), ws(*enabled)))
                .collect(),
            profiles: BTreeMap::new(),
            default_profile_by_org: BTreeMap::new(),
            open_windows: open_windows.iter().map(|s| s.to_string()).collect(),
        }
    }

    // --- startup_window_labels: startup selection rules ---

    #[test]
    fn restores_every_valid_enabled_open_window() {
        let f = file("acme", &["acme", "beta"], &[("acme", true), ("beta", true)]);
        let mut labels = startup_window_labels(&f);
        labels.sort();
        assert_eq!(labels, vec!["ws:acme".to_string(), "ws:beta".to_string()]);
    }

    #[test]
    fn filters_out_disabled_or_unknown_open_window_ids() {
        // "beta" is disabled, "ghost" no longer exists -- neither gets a window.
        let f = file("acme", &["acme", "beta", "ghost"], &[("acme", true), ("beta", false)]);
        assert_eq!(startup_window_labels(&f), vec!["ws:acme".to_string()]);
    }

    #[test]
    fn empty_open_windows_falls_back_to_active_workspace() {
        let f = file("acme", &[], &[("acme", true), ("beta", true)]);
        assert_eq!(startup_window_labels(&f), vec!["ws:acme".to_string()]);
    }

    #[test]
    fn fully_invalid_open_windows_falls_back_to_active_workspace() {
        let f = file("acme", &["ghost", "beta"], &[("acme", true), ("beta", false)]);
        assert_eq!(startup_window_labels(&f), vec!["ws:acme".to_string()]);
    }

    #[test]
    fn no_valid_fallback_either_returns_empty_for_bootstrap() {
        // active_workspace itself is disabled, open_windows is empty.
        let f = file("acme", &[], &[("acme", false)]);
        assert!(startup_window_labels(&f).is_empty());
    }

    // --- is_window_open_for: disable/delete refusal ---

    #[test]
    fn refuses_while_its_window_is_open() {
        let open = vec!["ws:acme".to_string(), "bootstrap".to_string()];
        assert!(is_window_open_for(&open, "acme"));
        assert!(!is_window_open_for(&open, "beta"));
    }

    // --- reassign_active_workspace: fallback reassignment ---

    #[test]
    fn reassigns_to_the_most_recently_focused_remaining_window() {
        let workspaces: BTreeMap<String, WorkspaceConfig> =
            [("acme", true), ("beta", true), ("gamma", true)]
                .into_iter()
                .map(|(id, e)| (id.to_string(), ws(e)))
                .collect();
        let history = vec!["gamma".to_string(), "beta".to_string(), "acme".to_string()];
        // "acme" is being removed; "beta" is the next-most-recently focused.
        assert_eq!(reassign_active_workspace("acme", &history, &workspaces), "beta");
    }

    #[test]
    fn skips_history_entries_that_are_disabled_or_the_removed_id_itself() {
        let workspaces: BTreeMap<String, WorkspaceConfig> =
            [("acme", true), ("beta", false), ("gamma", true)]
                .into_iter()
                .map(|(id, e)| (id.to_string(), ws(e)))
                .collect();
        let history = vec!["gamma".to_string(), "beta".to_string(), "acme".to_string()];
        assert_eq!(reassign_active_workspace("acme", &history, &workspaces), "gamma");
    }

    #[test]
    fn falls_back_to_the_first_remaining_enabled_workspace_with_no_useful_history() {
        let workspaces: BTreeMap<String, WorkspaceConfig> = [("acme", true), ("beta", true)]
            .into_iter()
            .map(|(id, e)| (id.to_string(), ws(e)))
            .collect();
        assert_eq!(reassign_active_workspace("acme", &[], &workspaces), "beta");
    }

    // --- touch_focus / untrack_focus ---

    #[test]
    fn touch_focus_moves_an_existing_entry_to_the_end_without_duplicating() {
        let mut history = vec!["acme".to_string(), "beta".to_string()];
        touch_focus(&mut history, "acme");
        assert_eq!(history, vec!["beta".to_string(), "acme".to_string()]);
    }

    #[test]
    fn untrack_focus_removes_the_entry() {
        let mut history = vec!["acme".to_string(), "beta".to_string()];
        untrack_focus(&mut history, "acme");
        assert_eq!(history, vec!["beta".to_string()]);
    }
}

#[cfg(test)]
mod fallback_should_fire_tests {
    use super::fallback_should_fire;

    #[test]
    fn armed_and_unanswered_still_exits() {
        // Same generation the timer was armed with, never approved: the
        // webview genuinely never answered -- must still force-exit.
        assert!(fallback_should_fire(1, 1, false));
    }

    #[test]
    fn armed_then_declined_does_not_exit() {
        // decline_exit bumped the generation past what this timer was
        // armed with while it was sleeping.
        assert!(!fallback_should_fire(1, 2, false));
    }

    #[test]
    fn armed_then_approved_does_not_double_exit() {
        // approve_exit already called app.exit(0) itself; the timer waking
        // up afterward on the same generation must not fire again.
        assert!(!fallback_should_fire(1, 1, true));
    }

    #[test]
    fn a_superseded_older_timer_does_not_exit() {
        // A second schedule_exit_fallback call (e.g. a fresh Cmd+Q while an
        // older, now-orphaned timer is still sleeping) bumps the generation
        // too -- the older timer must defer to the newer one, not fire on
        // its own stale view.
        assert!(!fallback_should_fire(1, 3, false));
    }
}

#[cfg(test)]
mod local_only_path_tests {
    use super::is_local_only_path;

    #[test]
    fn scope_is_local_only() {
        assert!(is_local_only_path("/scope"));
    }

    #[test]
    fn sandbox_profile_top_level_is_local_only() {
        assert!(is_local_only_path("/sandbox-profile"));
    }

    #[test]
    fn node_sandbox_profile_is_local_only() {
        assert!(is_local_only_path("/nodes/abc123/sandbox-profile"));
    }

    #[test]
    fn node_file_content_is_local_only() {
        // File CONTENT (GET/PUT /nodes/:id/file) routes to the local sync
        // agent so unsynced device-mirror files open in the editor; the agent
        // falls back to central itself when there is no mirror.
        assert!(is_local_only_path("/nodes/abc123/file"));
        assert!(is_local_only_path("/nodes/abc123/file?path=wip%2Fa.md"));
    }

    #[test]
    fn node_files_create_is_central_phase_b() {
        // File lifecycle (create) is served adapter-direct by
        // the central server, so /nodes/:id/files must NOT be gated local-only.
        assert!(!is_local_only_path("/nodes/abc123/files"));
    }

    #[test]
    fn node_files_sub_path_is_central_phase_b() {
        // Rename + delete also forward to the central server.
        assert!(!is_local_only_path("/nodes/abc123/files/somefile.md/rename"));
        assert!(!is_local_only_path("/nodes/abc123/files/somefileid"));
    }

    #[test]
    fn node_mirror_is_local_only() {
        assert!(is_local_only_path("/nodes/abc123/mirror"));
    }

    #[test]
    fn node_sync_status_is_local_only() {
        assert!(is_local_only_path("/nodes/abc123/sync-status"));
    }

    #[test]
    fn node_sync_run_is_local_only() {
        assert!(is_local_only_path("/nodes/abc123/sync"));
    }

    #[test]
    fn sync_pending_is_local_only() {
        // The cross-mirror unsynced aggregate (footer indicator + quit
        // guard) is device-local state: the central server has no mirrors
        // and answers an empty aggregate, so this must hit the local agent.
        assert!(is_local_only_path("/sync/pending"));
    }

    #[test]
    fn sync_health_is_local_only() {
        // The mirror-watcher error buffer (#202) is in-process state on this
        // device's sidecar; the central server never runs a watcher against
        // this device's mirrors and would answer an empty/wrong result.
        assert!(is_local_only_path("/sync/health"));
    }

    #[test]
    fn sync_drive_stays_central() {
        // Drive remote config lives on the central server in central mode
        // (the agent has no Drive credentials) -- only /sync/pending is
        // device-local, not the whole /sync/* namespace.
        assert!(!is_local_only_path("/sync/drive/status"));
    }

    #[test]
    fn graph_is_not_local_only() {
        assert!(!is_local_only_path("/graph"));
    }

    #[test]
    fn nodes_get_is_not_local_only() {
        assert!(!is_local_only_path("/nodes/abc123"));
    }

    #[test]
    fn folder_url_is_not_local_only() {
        assert!(!is_local_only_path("/nodes/abc123/folder-url"));
    }

    #[test]
    fn file_url_is_not_local_only() {
        // "file-url" must not be swallowed by the "files" prefix check; it is
        // a central Drive-URL lookup.
        assert!(!is_local_only_path("/nodes/abc123/file-url"));
        assert!(!is_local_only_path("/nodes/abc123/file-url?file_id=F1"));
    }

    #[test]
    fn actors_is_not_local_only() {
        assert!(!is_local_only_path("/actors"));
    }

    #[test]
    fn health_is_not_local_only() {
        assert!(!is_local_only_path("/health"));
    }

    #[test]
    fn query_string_stripped_before_matching() {
        assert!(is_local_only_path("/scope?cwd=/foo/bar"));
        assert!(is_local_only_path("/nodes/abc/sync-status?fast=1"));
        assert!(!is_local_only_path("/graph?filter=all"));
        // file-url stays central even though it shares the /file prefix.
        assert!(!is_local_only_path("/nodes/abc/file-url?file_id=xyz"));
    }
}

#[cfg(test)]
mod protocol_scope_tests {
    use super::path_within_root;
    use std::path::Path;

    #[test]
    fn allows_file_inside_root() {
        assert!(path_within_root(
            Path::new("/ws"),
            Path::new("/ws/nodes/abc/wip/page.html")
        ));
    }

    #[test]
    fn rejects_traversal_escape() {
        assert!(!path_within_root(
            Path::new("/ws"),
            Path::new("/ws/../etc/passwd")
        ));
    }

    #[test]
    fn rejects_unrelated_root() {
        assert!(!path_within_root(Path::new("/ws"), Path::new("/etc/passwd")));
    }
}

#[cfg(test)]
mod expand_tilde_tests {
    use super::expand_tilde;
    use std::path::Path;

    #[test]
    fn expands_tilde_slash_prefix() {
        assert_eq!(
            expand_tilde(Path::new("/Users/honzapav"), "~/Workspaces/portuni-tempo"),
            Path::new("/Users/honzapav/Workspaces/portuni-tempo")
        );
    }

    #[test]
    fn expands_bare_tilde() {
        assert_eq!(
            expand_tilde(Path::new("/Users/honzapav"), "~"),
            Path::new("/Users/honzapav")
        );
    }

    #[test]
    fn leaves_absolute_path_untouched() {
        assert_eq!(
            expand_tilde(Path::new("/Users/honzapav"), "/abs/mirror"),
            Path::new("/abs/mirror")
        );
    }

    #[test]
    fn regression_expanded_root_contains_expanded_local_path() {
        // The bug: raw "~/Workspaces/portuni-tempo" never contained the
        // sidecar-expanded absolute local_path, so every preview 403'd.
        let home = Path::new("/Users/honzapav");
        let root = expand_tilde(home, "~/Workspaces/portuni-tempo");
        let local_path =
            Path::new("/Users/honzapav/Workspaces/portuni-tempo/nodes/abc/wip/page.html");
        assert!(super::path_within_root(&root, local_path));
    }
}

#[cfg(test)]
mod reject_secret_shaped_keys_tests {
    use super::reject_secret_shaped_keys;
    use std::collections::BTreeMap;

    #[test]
    fn rejects_a_secret_shaped_key_among_ordinary_ones() {
        let mut env = BTreeMap::new();
        env.insert("CLAUDE_CONFIG_DIR".to_string(), "/Users/x/.claude-work".to_string());
        env.insert("ANTHROPIC_API_KEY".to_string(), "sk-...".to_string());
        let err = reject_secret_shaped_keys(&env).unwrap_err();
        assert!(err.contains("ANTHROPIC_API_KEY"));
        assert!(err.to_lowercase().contains("keychain"));
    }

    #[test]
    fn accepts_ordinary_keys() {
        let mut env = BTreeMap::new();
        env.insert("CLAUDE_CONFIG_DIR".to_string(), "/Users/x/.claude-work".to_string());
        env.insert("EDITOR".to_string(), "vim".to_string());
        assert!(reject_secret_shaped_keys(&env).is_ok());
    }

    #[test]
    fn accepts_an_empty_map() {
        assert!(reject_secret_shaped_keys(&BTreeMap::new()).is_ok());
    }
}

#[cfg(test)]
mod merge_profile_env_update_tests {
    use super::merge_profile_env_update;
    use std::collections::BTreeMap;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn empty_value_for_an_existing_key_keeps_the_stored_value() {
        let stored = map(&[("CLAUDE_CONFIG_DIR", "/Users/x/.claude-work")]);
        let submitted = map(&[("CLAUDE_CONFIG_DIR", "")]);
        assert_eq!(
            merge_profile_env_update(&stored, submitted),
            map(&[("CLAUDE_CONFIG_DIR", "/Users/x/.claude-work")])
        );
    }

    #[test]
    fn non_empty_value_overwrites_the_stored_value() {
        let stored = map(&[("CLAUDE_CONFIG_DIR", "/Users/x/.claude-work")]);
        let submitted = map(&[("CLAUDE_CONFIG_DIR", "/Users/x/.claude-other")]);
        assert_eq!(
            merge_profile_env_update(&stored, submitted),
            map(&[("CLAUDE_CONFIG_DIR", "/Users/x/.claude-other")])
        );
    }

    #[test]
    fn empty_value_for_a_brand_new_key_is_stored_as_empty() {
        let stored = BTreeMap::new();
        let submitted = map(&[("NEW_KEY", "")]);
        assert_eq!(merge_profile_env_update(&stored, submitted), map(&[("NEW_KEY", "")]));
    }

    #[test]
    fn a_key_omitted_from_the_submission_is_dropped() {
        let stored = map(&[("A", "1"), ("B", "2")]);
        let submitted = map(&[("A", "1")]);
        assert_eq!(merge_profile_env_update(&stored, submitted), map(&[("A", "1")]));
    }
}
