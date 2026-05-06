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

mod mcp_install;

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
// Wrapped in a Mutex so the regenerate_mcp_token command can rotate the
// shared token at runtime (after a fresh value lands in Keychain) without
// restarting the whole Tauri host.
struct AuthToken(Mutex<String>);

// Keychain coordinates for secrets we persist across launches. Service is
// bundle-id-shaped so entries show up under "ooo.workflow.portuni" in
// Keychain Access on macOS; account is the secret's role within that
// service.
const KEYCHAIN_SERVICE: &str = "ooo.workflow.portuni";
const KEYCHAIN_TURSO_ACCOUNT: &str = "turso_auth_token";
const KEYCHAIN_MCP_ACCOUNT: &str = "mcp_auth_token";

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
    /// Loopback port the bundled MCP server listens on. Stable across
    /// launches so external agents (Claude Code, Codex) can keep their
    /// `.mcp.json` configs valid. Defaults to DEFAULT_MCP_PORT; override
    /// in config.json if it collides with another local service.
    #[serde(default)]
    mcp_port: Option<u16>,
}

/// Default loopback port for the bundled MCP server. Picked high enough
/// to avoid common dev-server ports (3000/4000/5173/4011 dev backend);
/// users hitting a collision can override via config.json `mcp_port`.
const DEFAULT_MCP_PORT: u16 = 47011;

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

// Returns the current in-memory MCP auth token. The frontend reads it
// only when the user explicitly asks (Settings → Show / Copy) so it
// doesn't sit in webview JS state by default.
#[tauri::command]
fn get_mcp_token(app: AppHandle) -> Result<String, String> {
    Ok(app
        .state::<AuthToken>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone())
}

// Rotates the MCP auth token: writes a fresh value to Keychain and into
// the shared AuthToken state. Note that any external configs (per-mirror
// .mcp.json, ~/.claude.json, ~/.codex/config.toml) become stale until the
// user re-runs the corresponding "Install …" command.
#[tauri::command]
fn regenerate_mcp_token(app: AppHandle) -> Result<String, String> {
    let fresh = random_token();
    keychain_set_mcp_token(&fresh)?;
    let state = app.state::<AuthToken>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = fresh.clone();
    Ok(fresh)
}

// Snapshots the live MCP endpoint (URL built from the bound port) +
// auth token. Returns ("url", "token") so the install_* commands don't
// each duplicate the same plumbing. Errors with a human message when
// the sidecar hasn't reported its port yet — the UI gates the install
// buttons on the same status, so this should not normally happen.
fn snapshot_mcp_endpoint(app: &AppHandle) -> Result<(String, String), String> {
    let port = {
        let state = app.state::<BackendPort>();
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.ok_or_else(|| "MCP server not yet running".to_string())?
    };
    let token = {
        let state = app.state::<AuthToken>();
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };
    Ok((format!("http://127.0.0.1:{port}/mcp"), token))
}

// Writes Portuni as a user-scoped MCP server in ~/.claude.json, so any
// Claude Code session on this machine can connect without per-project
// .mcp.json. Returns the absolute path of the written file for the UI
// to surface back to the user.
#[tauri::command]
fn install_claude_global(app: AppHandle) -> Result<String, String> {
    let (url, token) = snapshot_mcp_endpoint(&app)?;
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = PathBuf::from(home).join(".claude.json");
    mcp_install::write_claude_config(&path, &url, &token)?;
    Ok(path.to_string_lossy().into_owned())
}

// Same idea for Codex: writes the [mcp_servers.portuni] block into
// ~/.codex/config.toml between Portuni-managed marker comments so we
// can refresh idempotently without clobbering surrounding user config.
#[tauri::command]
fn install_codex_global(app: AppHandle) -> Result<String, String> {
    let (url, token) = snapshot_mcp_endpoint(&app)?;
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = PathBuf::from(home).join(".codex").join("config.toml");
    mcp_install::write_codex_config(&path, &url, &token)?;
    Ok(path.to_string_lossy().into_owned())
}

fn keychain_get_mcp_token() -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_MCP_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|s| !s.is_empty())
}

fn keychain_set_mcp_token(token: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_MCP_ACCOUNT)
        .map_err(|e| e.to_string())?
        .set_password(token)
        .map_err(|e| e.to_string())
}

// Returns the persisted MCP auth token, generating + storing one on first
// call. Subsequent launches reuse the same token so external `.mcp.json`
// files (Claude Code, Codex) keep working across restarts.
fn ensure_mcp_token() -> Result<String, String> {
    if let Some(existing) = keychain_get_mcp_token() {
        return Ok(existing);
    }
    let fresh = random_token();
    keychain_set_mcp_token(&fresh)?;
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
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config_exists = config_path(&data_dir).exists();
    let config = load_config(&data_dir);
    let url = config
        .turso_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(TursoStatus {
        config_exists,
        url_set: url.is_some(),
        token_set: keychain_get_turso_token()
            .is_some_and(|t| !t.trim().is_empty()),
        url,
    })
}

// Used by the first-run onboarding wizard to commit the user's choice
// (connect to a remote Turso DB, or start locally) to disk. Writing an
// empty `turso_url` produces a `{}` config — the marker that the user
// has chosen local mode and we should stop showing the wizard.
#[tauri::command]
fn save_config(app: AppHandle, turso_url: Option<String>) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let mut config = load_config(&data_dir);
    config.turso_url = turso_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(&data_dir), json).map_err(|e| e.to_string())
}

// Run the user's terminal-launch template (configured in Settings) as a
// shell command. The template gets these env vars exposed:
//
//   PORTUNI_CWD          working directory of the node
//   PORTUNI_COMMAND      full shell command (cd <path> && claude ...)
//   PORTUNI_COMMAND_AS   same command, AppleScript-escaped (\ -> \\,
//                        " -> \") so it drops straight into a `do script`
//                        double-quoted string without further escaping.
//
// macOS-only; on other platforms returns "UNSUPPORTED_OS" so the webview
// can fall back to clipboard copy. The default template uses Terminal.app
// via osascript heredoc, but the user can pick iTerm2, Ghostty, Warp,
// cmux, or write their own template — Rust just exec's whatever they
// configured.
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
        // Mirror to the file logger so we can diagnose without relying
        // on the UI toast (which truncates long messages off-screen).
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

// Bounce the Node sidecar so it picks up a freshly-set Turso token
// from the Keychain. Used by the first-run gate after the user pastes
// their token. Idempotent: if no sidecar is running, just spawns one.
#[tauri::command]
async fn restart_sidecar(app: AppHandle) -> Result<(), String> {
    kill_managed_sidecar(&app);
    spawn_sidecar(&app).map_err(|e| e.to_string())
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
    let token = app
        .state::<AuthToken>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

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

// Drop-side cleanup: kill the bundled sidecar child if we still hold a
// handle to it. Used by `kill_managed_sidecar` and the various exit
// paths that previously relied solely on `WindowEvent::Destroyed`.
fn kill_managed_sidecar(app: &AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                info!("killing managed sidecar (pid={})", child.pid());
                let _ = child.kill();
            }
        }
    }
    if let Some(state) = app.try_state::<BackendPort>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = None;
        }
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
    let auth_token = app
        .state::<AuthToken>()
        .0
        .lock()
        .expect("AuthToken mutex poisoned")
        .clone();

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

    // The MCP loopback port is fixed across launches so external clients'
    // .mcp.json configs stay valid — but that means we collide with any
    // orphan sidecar (previous abnormal exit) holding the port. Reap it
    // before binding so the launch succeeds instead of erroring with
    // "Failed to start server. Is port <n> in use?".
    let port = config.mcp_port.unwrap_or(DEFAULT_MCP_PORT);
    reap_orphan_sidecar(port);

    // tauri-plugin-shell 2.x's env_clear() does not reliably scrub the
    // parent env on macOS — additionally force-empty the variables we
    // don't want leaking from a developer's varlock-loaded shell.
    let (mut rx, child) = app
        .shell()
        .sidecar("portuni-sidecar")?
        .current_dir(sidecar_cwd)
        .env_clear()
        .env("PORTUNI_DATA_DIR", data_dir_str)
        .env("PORTUNI_PORT", port.to_string())
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
    // Persisted across launches so user-scoped MCP configs (Claude Code,
    // Codex, per-mirror .mcp.json) stay valid. Falls back to a random
    // value if Keychain is unreachable — the app can still boot, just
    // without external-agent support until Keychain comes back.
    let auth_token = ensure_mcp_token().unwrap_or_else(|e| {
        warn!("Keychain unavailable for MCP token, falling back to per-launch random: {e}");
        random_token()
    });

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
        .manage(AuthToken(Mutex::new(auth_token)))
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            api_request,
            set_turso_token,
            clear_turso_token,
            get_turso_status,
            save_config,
            restart_sidecar,
            get_mcp_token,
            regenerate_mcp_token,
            install_claude_global,
            install_codex_global,
            launch_claude_for_node,
        ])
        .setup(|app| {
            info!(
                "MCP auth token loaded (length={})",
                app.state::<AuthToken>()
                    .0
                    .lock()
                    .map(|g| g.len())
                    .unwrap_or(0)
            );
            if let Err(e) = spawn_sidecar(&app.handle().clone()) {
                error!("failed to spawn sidecar: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Cover both lifecycle points: CloseRequested fires for Cmd+W /
            // clicking the close button, Destroyed fires once the window is
            // gone. Either is enough on its own; handling both is defensive
            // against the orphan-sidecar leak that happens when only one
            // path actually fires.
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                kill_managed_sidecar(window.app_handle());
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
                kill_managed_sidecar(app);
            }
        });
}
