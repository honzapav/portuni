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

mod auth;
mod mcp_install;
mod pty;
mod workspace;

use log::{error, info, warn};
use rand::distr::Alphanumeric;
use rand::{Rng, TryRngCore};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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

// Keychain coordinates for secrets we persist across launches. Service is
// bundle-id-shaped so entries show up under "ooo.workflow.portuni" in
// Keychain Access on macOS; account is the secret's role within that
// service.
pub(crate) const KEYCHAIN_SERVICE: &str = "ooo.workflow.portuni";
const KEYCHAIN_TURSO_ACCOUNT: &str = "turso_auth_token";
pub(crate) const KEYCHAIN_MCP_ACCOUNT: &str = "mcp_auth_token";

fn config_path(data_dir: &PathBuf) -> PathBuf {
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

#[tauri::command]
fn set_turso_token(app: AppHandle, token: String) -> Result<(), String> {
    let (ws_id, _) = active_workspace(&app)?;
    keychain_set_ws(KEYCHAIN_TURSO_ACCOUNT, &ws_id, &token)
}

#[tauri::command]
fn clear_turso_token(app: AppHandle) -> Result<(), String> {
    let (ws_id, _) = active_workspace(&app)?;
    keychain_delete_ws(KEYCHAIN_TURSO_ACCOUNT, &ws_id);
    Ok(())
}

// Returns the MCP bearer token the current data_mode actually needs. The
// frontend reads it only when the user explicitly asks (Settings → Show /
// Copy) so it doesn't sit in webview JS state by default.
//
// Local mode: the workspace's persisted MCP auth token from the AuthTokens map.
// Central mode: the long-lived device token from Keychain (minted on
// demand) — the central server rejects the local sidecar token, so
// handing that out here would give the user a credential that 401s.
#[tauri::command]
fn get_mcp_token(app: AppHandle) -> Result<String, String> {
    let (ws_id, cfg) = active_workspace(&app)?;
    if workspace::is_central(&cfg) {
        let server_url = cfg
            .server_url
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "central mode requires server_url in config.json".to_string())?;
        return pty::ensure_device_token(&app, &ws_id, server_url);
    }
    app.state::<AuthTokens>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&ws_id)
        .cloned()
        .ok_or_else(|| "backend not ready (no token)".to_string())
}

// Rotates the MCP auth token: writes a fresh value to Keychain and into
// the active workspace's entry in the AuthTokens map. Per-mirror .mcp.json and .codex/config.toml
// reference the token via the PORTUNI_MCP_TOKEN env var, so they survive
// rotation (already-running terminals keep the old value until respawned).
// Only ~/.claude.json embeds the literal token and goes stale until the
// user re-runs "Install Claude (global)".
#[tauri::command]
fn regenerate_mcp_token(app: AppHandle) -> Result<String, String> {
    let (ws_id, _) = active_workspace(&app)?;
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
// indirection). Central mode: {server_url}/mcp and env-reference for all.
fn global_entry_parts(
    app: &AppHandle,
    ws_id: &str,
    cfg: &workspace::WorkspaceConfig,
) -> Result<(String, String, String, String), String> {
    let name = workspace::mcp_server_name(ws_id, cfg);
    let token_env = workspace::token_env_var(ws_id);
    if workspace::is_central(cfg) {
        let server_url = cfg
            .server_url
            .clone()
            .ok_or_else(|| format!("workspace {ws_id}: central mode requires server_url"))?;
        let url = format!("{}/mcp", server_url.trim_end_matches('/'));
        let claude_token = format!("${{{token_env}:-}}");
        Ok((name, url, claude_token, token_env))
    } else {
        let port = cfg
            .mcp_port
            .ok_or_else(|| format!("workspace {ws_id}: no mcp_port assigned"))?;
        let url = format!("http://127.0.0.1:{port}/mcp");
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
// In central data_mode: writes {server_url}/mcp as the URL and uses the
// PORTUNI_MCP_TOKEN_<WS> env-reference pattern (same as mirror configs) so
// the token is never hardcoded in the file.
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
    // .setup()'s spawn_all_sidecars was a no-op on the pre-migration v1/Missing
    // config, so no sidecar is running. Spawn now — the migration gate's reload
    // otherwise polls an empty BackendPorts map for 30 s. Idempotent:
    // spawn_sidecar_ws's contains_key guard skips any already-running child.
    spawn_all_sidecars(&app);
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

#[tauri::command]
fn get_backend_port(app: AppHandle) -> Option<u16> {
    // Port of the ACTIVE workspace's sidecar. None before the sidecar reports
    // its port, or while config is still v1/Missing (the migration/onboarding
    // gate handles that case in the UI).
    let ws_id = active_workspace(&app).ok()?.0;
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
///
/// NOT local-only (Phase B serves these from the central server): file CONTENT
/// (GET/PUT /nodes/:id/file) and the file lifecycle (POST /nodes/:id/files,
/// POST /nodes/:id/files/:fileId/rename, DELETE /nodes/:id/files/:fileId) are
/// adapter-direct on the server, so they forward in central mode.
/// /nodes/:id/folder-url and /nodes/:id/file-url also stay central (Drive URL
/// lookups on the server). All graph, actor, responsibility, etc. routes are
/// central.
pub(crate) fn is_local_only_path(path: &str) -> bool {
    // Strip query string for matching.
    let p = path.split('?').next().unwrap_or(path);

    // Exact top-level paths.
    if p == "/scope" || p == "/sandbox-profile" {
        return true;
    }

    // Node sub-paths that are local-only.
    // Matches: /nodes/<id>/mirror, /nodes/<id>/sync-status, /nodes/<id>/sync,
    //          /nodes/<id>/sandbox-profile
    //
    // NOT matched (Phase B serves these centrally): /nodes/<id>/file (content),
    // /nodes/<id>/files and /nodes/<id>/files/* (B3 lifecycle),
    // /nodes/<id>/file-url, /nodes/<id>/folder-url.
    if let Some(rest) = p.strip_prefix("/nodes/") {
        // rest = "<id>/<sub>" or "<id>/<sub>/..."
        if let Some(slash) = rest.find('/') {
            let sub = &rest[slash + 1..];
            if sub == "mirror"
                || sub == "sync-status"
                || sub == "sync"
                || sub == "sandbox-profile"
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
fn expand_tilde(home: &std::path::Path, raw: &str) -> std::path::PathBuf {
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
fn get_data_mode(app: AppHandle) -> Result<DataModeResponse, String> {
    let (_, cfg) = active_workspace(&app)?;
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
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let turso = turso_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let loaded = workspace::load(&data_dir)?;
    // Fresh install path: .setup()'s spawn_all_sidecars was a no-op (config was
    // Missing at boot), so nothing is running yet and we must spawn below.
    let fresh_install = matches!(loaded, workspace::LoadedConfig::Missing);
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
    let active = file.active_workspace.clone();
    let cfg = file
        .workspaces
        .get_mut(&active)
        .ok_or_else(|| "active workspace missing from config".to_string())?;
    cfg.turso_url = turso;
    workspace::save(&data_dir, &file)?;
    // Fresh install: bring the just-created `default` workspace's sidecar up
    // now so the wizard's reload finds a running backend instead of polling an
    // empty BackendPorts map for 30 s. On the "connect to org" path
    // TursoSetupGate then calls set_turso_token + restart_sidecar (which
    // kills+respawns to pick up the token); on "start local" no restart runs
    // and this is the only spawn. spawn_sidecar_ws's contains_key guard makes
    // the eventual restart's kill+respawn double-call safe.
    if fresh_install {
        spawn_all_sidecars(&app);
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
fn open_path_external(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let (_, cfg) = active_workspace(&app)?;
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

// Bounce the Node sidecar so it picks up a freshly-set Turso token
// from the Keychain. Used by the first-run gate after the user pastes
// their token. Idempotent: if no sidecar is running, just spawns one.
#[tauri::command]
async fn restart_sidecar(app: AppHandle) -> Result<(), String> {
    let (ws_id, _) = active_workspace(&app)?;
    kill_sidecar_ws(&app, &ws_id);
    spawn_sidecar_ws(&app, &ws_id).map_err(|e| e.to_string())
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
    method: String,
    path: String,
    body: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<ApiResponse, String> {
    // Route by the ACTIVE workspace's config.
    let (ws_id, cfg) = active_workspace(&app)?;
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
            // Silent refresh + retry once.
            info!("api_request central: got 401, attempting silent refresh");
            match auth::auth_refresh(app.clone()).await {
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
    let port = {
        let state = app.state::<BackendPorts>();
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard
            .get(&ws_id)
            .copied()
            .ok_or_else(|| "backend not ready".to_string())?
    };
    if port == 0 {
        // Central-mode sentinel: the sync agent is not running (not logged
        // in yet, or no server_url). Local-only affordances stay parked.
        return Ok(ApiResponse {
            status: 501,
            body: "{\"error\":\"local_only\",\"detail\":\"sync agent not running\"}".to_string(),
        });
    }
    let token = app
        .state::<AuthTokens>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&ws_id)
        .cloned()
        .ok_or_else(|| "backend not ready (no token)".to_string())?;

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
    // watcher + mirror/sync routes, no graph db, no MCP). The agent needs a
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
                    // Per-mirror .mcp.json URLs materialize from PORTUNI_URL,
                    // so agents launched inside mirrors connect to the central
                    // MCP (the agent sidecar serves none).
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
        ("PORTUNI_WORKSPACE_ROOT".to_string(), workspace_root),
        ("PORTUNI_WORKSPACE_ID".to_string(), ws_id.to_string()),
        ("PORTUNI_ALLOWED_ORIGINS".to_string(), allowed_origins),
        ("PORTUNI_LOG_REQUESTS".to_string(), "1".to_string()),
        ("HOME".to_string(), std::env::var("HOME").unwrap_or_default()),
        ("PATH".to_string(), std::env::var("PATH").unwrap_or_default()),
    ];
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
                    let line = line.trim_end_matches(|c| c == '\n' || c == '\r');
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
                    let line = line.trim_end_matches(|c| c == '\n' || c == '\r');
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
    for (id, cfg) in &file.workspaces {
        if !cfg.enabled {
            continue;
        }
        if let Err(e) = spawn_sidecar_ws(app, id) {
            error!("failed to spawn sidecar for {id}: {e}");
        }
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
    mcp_server_name: String,
    workspace_root: String,
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
            mcp_server_name: workspace::mcp_server_name(id, cfg),
            workspace_root: cfg.effective_workspace_root(),
        })
        .collect())
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
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => return Err("config not migrated to workspaces yet".to_string()),
    };
    if file.workspaces.contains_key(&args.id) {
        return Err(format!("workspace '{}' already exists", args.id));
    }
    let port = workspace::allocate_port(&file.workspaces);
    let cfg = workspace::WorkspaceConfig {
        label: args.label,
        enabled: true,
        turso_url: args.turso_url.filter(|s| !s.trim().is_empty()),
        workspace_root: Some(args.workspace_root),
        mcp_port: Some(port),
        server_url: args.server_url.filter(|s| !s.trim().is_empty()),
        google_client_id: args.google_client_id.filter(|s| !s.trim().is_empty()),
        google_client_secret: args.google_client_secret.filter(|s| !s.trim().is_empty()),
        data_mode: if args.data_mode == "central" {
            Some("central".to_string())
        } else {
            None
        },
        mcp_server_name: None,
    };
    file.workspaces.insert(args.id.clone(), cfg);
    workspace::save(&data_dir, &file)?;
    if let Err(e) = spawn_sidecar_ws(&app, &args.id) {
        warn!("new workspace {} sidecar spawn failed: {e}", args.id);
    }
    Ok(())
}

#[tauri::command]
fn set_active_workspace(app: AppHandle, id: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => return Err("config not migrated to workspaces yet".to_string()),
    };
    if !file.workspaces.contains_key(&id) {
        return Err(format!("unknown workspace '{id}'"));
    }
    file.active_workspace = id;
    workspace::save(&data_dir, &file)
}

#[tauri::command]
fn set_workspace_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => return Err("config not migrated to workspaces yet".to_string()),
    };
    {
        let cfg = file
            .workspaces
            .get_mut(&id)
            .ok_or_else(|| format!("unknown workspace '{id}'"))?;
        cfg.enabled = enabled;
    }
    if !enabled && file.active_workspace == id {
        return Err("cannot disable the active workspace — switch first".to_string());
    }
    workspace::save(&data_dir, &file)?;
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
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => return Err("config not migrated to workspaces yet".to_string()),
    };
    if file.active_workspace == id {
        return Err("cannot delete the active workspace — switch first".to_string());
    }
    if file.workspaces.len() == 1 {
        return Err("cannot delete the last workspace".to_string());
    }
    if !file.workspaces.contains_key(&id) {
        return Err(format!("unknown workspace '{id}'"));
    }
    // Resolve the MCP entry name while the workspace is still in config — the
    // migrated workspace keeps the historical "portuni" name, which we could
    // not recover once it's removed below.
    let mcp_name = file
        .workspaces
        .get(&id)
        .map(|c| workspace::mcp_server_name(&id, c))
        .unwrap_or_else(|| format!("portuni-{id}"));
    // Stop the sidecar (a process, no persisted state).
    kill_sidecar_ws(&app, &id);
    // COMMIT POINT: drop the workspace from config.json and persist FIRST. If
    // this save fails we return early having touched no credentials — the
    // workspace is still fully intact (config lists it, Keychain holds its
    // secrets) and its sidecar re-spawns on the next launch.
    file.workspaces.remove(&id);
    workspace::save(&data_dir, &file)?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // State maps start empty and are filled per workspace by .setup()'s
    // spawn_all_sidecars — each spawn_sidecar_ws caches that workspace's
    // MCP token into AuthTokens and its bound port into BackendPorts.
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
        .manage(pty::PtyState::default())
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

            // Scope the preview to the ACTIVE workspace's mirror root. Expand
            // the config's leading ~ (the sidecar does this for the absolute
            // local_path we compare against); fall back to the raw value if the
            // home dir is somehow unavailable.
            let root = active_workspace(app).ok().map(|(_, cfg)| {
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
            get_backend_port,
            get_data_mode,
            open_external,
            api_request,
            set_turso_token,
            clear_turso_token,
            get_turso_status,
            save_config,
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
            auth::auth_refresh,
            auth::auth_logout,
            auth::central_request,
            list_workspaces,
            create_workspace,
            set_active_workspace,
            set_workspace_enabled,
            delete_workspace,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Each enabled workspace gets its own sidecar; spawn_sidecar_ws
            // caches the per-workspace MCP token into AuthTokens as it goes.
            // A v1/Missing config is a no-op until migration/onboarding.
            spawn_all_sidecars(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Only Destroyed, not CloseRequested: the webview registers an
            // onCloseRequested listener (dirty-editor guard), so a close
            // request may be cancelled in JS. Killing the sidecars on the
            // request would leave a live window with dead backends.
            // Cmd+Q / app exit is covered by ExitRequested/Exit below.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                kill_all_sidecars(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
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
    fn node_file_content_is_central_phase_b() {
        // Phase B: file CONTENT (GET/PUT /nodes/:id/file) is served by the
        // central server (Drive-direct), so it must NOT be gated local-only.
        assert!(!is_local_only_path("/nodes/abc123/file"));
    }

    #[test]
    fn node_files_create_is_central_phase_b() {
        // Phase B (B3): file lifecycle (create) is served adapter-direct by
        // the central server, so /nodes/:id/files must NOT be gated local-only.
        assert!(!is_local_only_path("/nodes/abc123/files"));
    }

    #[test]
    fn node_files_sub_path_is_central_phase_b() {
        // Phase B (B3): rename + delete also forward to the central server.
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
        // file CONTENT is central in Phase B even with a query string.
        assert!(!is_local_only_path("/nodes/abc/file?encoding=utf8"));
        assert!(is_local_only_path("/nodes/abc/sync-status?fast=1"));
        assert!(!is_local_only_path("/graph?filter=all"));
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
