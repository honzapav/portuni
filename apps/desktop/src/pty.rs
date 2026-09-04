// PTY backend for the embedded terminal pane.
//
// Each session owns a portable-pty master pair, a child process running
// the user's shell with a node-bound command, and a reader thread that
// streams stdout/stderr to the webview via the `pty-data` event. The
// webview holds the session id and uses it to write keystrokes, resize
// on container changes, and kill on unmount.
//
// Cross-platform by virtue of portable-pty: same code path works on
// macOS, Linux, and Windows. The shell choice (zsh on mac, $SHELL or
// fallback elsewhere) is picked at spawn time from env.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use base64::{prelude::BASE64_STANDARD, Engine};
use log::{error, info, warn};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

// Keychain account for the long-lived device token used by agent terminals
// in central data_mode. Separate from the persisted per-workspace MCP token
// (AuthTokens map / Keychain) used in local mode so the two don't interfere.
// pub(crate): auth.rs's auth_logout deletes this account for the active
// workspace too.
pub(crate) const KEYCHAIN_DEVICE_TOKEN_ACCOUNT: &str = "portuni_device_token";

/// Return the device token for central-mode terminal sessions. Tries Keychain
/// first; if absent, mints one via POST /device-tokens on the central server
/// (using the current session JWT) and stores it. Errors if not logged in.
/// `ws_id` and `server_url` come from the caller's `active_workspace(&app)?`
/// lookup — this function itself does no config resolution.
///
/// Blocking: calls block_on internally because pty_spawn is a sync command.
/// pub(crate): the sync-agent sidecar spawn (lib.rs) authenticates with the
/// same device token.
pub(crate) fn ensure_device_token(
    _app: &AppHandle,
    ws_id: &str,
    server_url: &str,
) -> Result<String, String> {
    // Return cached token if already in Keychain.
    if let Some(t) = crate::keychain_get_ws(KEYCHAIN_DEVICE_TOKEN_ACCOUNT, ws_id) {
        return Ok(t);
    }

    // Need to mint. Require a session JWT.
    let jwt = crate::keychain_get_ws(crate::auth::KEYCHAIN_SESSION_JWT, ws_id)
        .ok_or_else(|| "not logged in: no session JWT in Keychain".to_string())?;

    let server_url = server_url.trim().trim_end_matches('/').to_string();
    let ws_for_store = ws_id.to_string();
    // Mint via POST /device-tokens {"label": "Desktop terminály"}.
    // block_on is safe here because pty_spawn runs on a Tauri thread-pool
    // thread (not inside an async context), so we won't deadlock.
    let token = tauri::async_runtime::block_on(async move {
        let body = serde_json::json!({ "label": "Desktop terminály" });
        let resp = crate::auth::do_central_request_raw(
            &server_url,
            "POST",
            "/device-tokens",
            Some(&body),
            &jwt,
        )
        .await?;
        if resp.status != 201 {
            return Err(format!(
                "POST /device-tokens returned {}: {}",
                resp.status, resp.body
            ));
        }
        // Response: {"id": "...", "token": "plaintext-value"}
        let parsed: serde_json::Value = serde_json::from_str(&resp.body)
            .map_err(|e| format!("device-tokens response parse failed: {e}"))?;
        parsed["token"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "device-tokens response missing 'token' field".to_string())
    })?;

    // Persist to Keychain so subsequent spawns reuse it.
    crate::keychain_set_ws(KEYCHAIN_DEVICE_TOKEN_ACCOUNT, &ws_for_store, &token)?;
    info!("pty: device token minted and stored for workspace {ws_for_store}");

    Ok(token)
}

#[derive(Serialize, Clone)]
pub struct PtyDataEvent {
    pub session_id: String,
    /// Base64 of the raw bytes read from the PTY. The frontend
    /// decodes this and feeds it to `term.write(Uint8Array)` so
    /// xterm's own streaming UTF-8 decoder handles boundary-spanning
    /// codepoints correctly. Sending a Rust String here would force
    /// `String::from_utf8_lossy` on each chunk, which silently
    /// replaces split multibyte sequences with U+FFFD — fatal for
    /// Claude Code's Unicode-heavy TUI.
    pub data_b64: String,
}

#[derive(Serialize, Clone)]
pub struct PtyExitEvent {
    pub session_id: String,
    pub code: Option<i32>,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    // Kept around so dropping the session sends SIGHUP to the child.
    _child: Box<dyn portable_pty::Child + Send + Sync>,
    // Workspace this terminal was spawned for, captured once at spawn time
    // (#219) rather than re-resolved at exit -- the active workspace can
    // change while the terminal is alive (pre-phase-1, "active" is global,
    // not per-window). None when no workspace is configured yet (fresh
    // install), in which case the exit report below is skipped: there is no
    // sidecar to tell. Phase 1 (#223) reuses this field for per-window
    // authorization once pty_spawn itself becomes window-routed.
    ws_id: Option<String>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Deserialize)]
pub struct SpawnArgs {
    pub session_id: String,
    pub cwd: String,
    /// Shell command to run after the shell starts (e.g. `claude '<prompt>'`).
    /// If empty, the shell starts in interactive mode without a pre-command.
    pub command: String,
    pub cols: u16,
    pub rows: u16,
    /// Seatbelt profile text (from GET /nodes/:id/sandbox-profile). When
    /// set on macOS, the shell is wrapped in `sandbox-exec -f <profile>`
    /// so every process in the terminal — any agent binary included —
    /// gets the node's disk scope enforced by the kernel. Absent/empty
    /// spawns unsandboxed (older frontends, nodes without mirrors).
    #[serde(default)]
    pub sandbox_profile: Option<String>,
    /// Session id the sandbox profile's projection grant is narrowed to
    /// (from the same GET /nodes/:id/sandbox-profile response as
    /// sandbox_profile, #208 follow-up). Exported as
    /// PORTUNI_SPAWN_SESSION_ID so a Claude Code connection reuses it as
    /// the MCP session's own id. Absent/empty for older frontends or a
    /// profile response minted before this field existed.
    #[serde(default)]
    pub spawn_session_id: Option<String>,
    /// Id of a CLI spawn profile (config.json `profiles`, phase 3 spawn UX).
    /// When set and known, its env vars are merged into the shell and its
    /// `command` override (if any) replaces `command` above. Absent/unknown
    /// spawns exactly as before -- profiles are additive, never required.
    #[serde(default)]
    pub profile_id: Option<String>,
}

/// Compute the (program, argv) pair for the PTY child. Pure so the
/// sandbox wrapping is unit-testable: with a profile path the shell is
/// wrapped in sandbox-exec, without one it runs directly.
fn spawn_program(
    shell: &str,
    shell_args: &[String],
    profile_path: Option<&str>,
) -> (String, Vec<String>) {
    match profile_path {
        Some(p) => {
            let mut argv = vec!["-f".to_string(), p.to_string(), shell.to_string()];
            argv.extend(shell_args.iter().cloned());
            ("/usr/bin/sandbox-exec".to_string(), argv)
        }
        None => (shell.to_string(), shell_args.to_vec()),
    }
}

// POSIX-safe single-quote escape for embedding a path into a shell
// command. Wraps the input in single quotes; any internal single quote
// is escaped by closing the quote, inserting an escaped quote, and
// reopening: 'a'b' -> 'a'\''b'.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Expand a leading `~` (bare, or `~/...`) in a profile env value to
/// `home`, reusing lib.rs's path-tilde-expansion (same PORTUNI_WORKSPACE_ROOT
/// rule, just applied to a plain string value here instead of a PathBuf).
/// portable-pty's CommandBuilder passes env values to the child verbatim (no
/// shell involved), so `~` is never expanded on its own -- without this,
/// `CLAUDE_CONFIG_DIR=~/.claude-work` makes Claude Code create a literal `~`
/// directory inside the mirror cwd instead of switching accounts (#207).
fn expand_tilde(value: &str, home: Option<&str>) -> String {
    match home {
        Some(home) => crate::expand_tilde(std::path::Path::new(home), value)
            .to_string_lossy()
            .into_owned(),
        None => value.to_string(),
    }
}

/// Env vars to actually inject from a profile's stored map (#207): `PORTUNI_*`
/// keys are dropped so a profile can never silently override the
/// credential/profile-id env pty_spawn already exported before this merge
/// runs (a profile defining e.g. `PORTUNI_MCP_TOKEN` would otherwise make
/// every MCP call 401), and each value gets `expand_tilde` applied. Pure and
/// order-preserving (BTreeMap iterates sorted by key) so it is unit-testable
/// without a real CommandBuilder/child process.
fn resolve_profile_env(
    profile_env: &std::collections::BTreeMap<String, String>,
    home: Option<&str>,
) -> Vec<(String, String)> {
    profile_env
        .iter()
        .filter(|(k, _)| !k.starts_with("PORTUNI_"))
        .map(|(k, v)| (k.clone(), expand_tilde(v, home)))
        .collect()
}

// Env var name a Claude Code connection reads via write-scope.ts's
// X-Portuni-Terminal header (env-expanded at config-load time, same channel
// PORTUNI_PROFILE_ID already uses) so the server can stamp the resulting
// session row's `terminal_id` and later correlate it back to this PTY
// (#219, "Sessions follow PTY exit").
const TERMINAL_ID_ENV_VAR: &str = "PORTUNI_TERMINAL_ID";

// The frontend's terminal id (`term_<node>_<ts>_<rand>`, `lib/sessions.ts`)
// IS `args.session_id` -- pty_spawn is invoked with it directly, so there is
// nothing to mint here. Exported unconditionally (unlike
// PORTUNI_SPAWN_SESSION_ID, which is optional): the terminal id is always
// known at spawn time. Pure so the mapping is unit-testable.
fn terminal_id_env(session_id: &str) -> (&'static str, String) {
    (TERMINAL_ID_ENV_VAR, session_id.to_string())
}

// URL + headers for the PTY-exit report (#219): pure so the request shape
// is unit-testable without a running sidecar. webview_proxy_secret is None
// when the hardened posture (#213) isn't active for this workspace's
// sidecar, in which case the header is simply omitted -- the receiving
// gate's unhardened default already allows the request through.
fn terminal_exit_request(
    port: u16,
    terminal_id: &str,
    token: &str,
    webview_proxy_secret: Option<&str>,
) -> (String, Vec<(String, String)>) {
    let url = format!("http://127.0.0.1:{port}/terminals/{terminal_id}/exit");
    let mut headers = vec![
        ("Authorization".to_string(), format!("Bearer {token}")),
        ("Origin".to_string(), "tauri://localhost".to_string()),
    ];
    if let Some(secret) = webview_proxy_secret {
        headers.push(("X-Portuni-Webview-Proxy".to_string(), secret.to_string()));
    }
    (url, headers)
}

// Best-effort notification to the owning workspace's sidecar that a PTY
// exited, so the server can close every `running` session sharing this
// terminal_id (#219). Called from the reader thread's EOF/error path, so it
// fires for every exit reason -- pty_kill, the user typing `exit`, a CLI
// crash -- not just a deliberate close. Failures (no workspace resolved at
// spawn time, sidecar unreachable, non-2xx) are logged and swallowed: a
// missed report just leaves the row `running` until the MCP transport's
// idle GC backstop closes it later; it must never block PTY teardown that
// has already happened.
fn report_terminal_exit(app: &AppHandle, ws_id: &str, terminal_id: &str) {
    let (port, token) = match crate::sidecar_port_and_token(app, ws_id) {
        Ok(pt) => pt,
        Err(e) => {
            warn!("pty exit report for {terminal_id} skipped: {e}");
            return;
        }
    };
    let secret = crate::webview_proxy_secret(app, ws_id);
    let (url, headers) = terminal_exit_request(port, terminal_id, &token, secret.as_deref());
    let terminal_id = terminal_id.to_string();
    // block_on is safe here: the reader thread is a plain std::thread, not
    // already inside an async context, same reasoning as
    // ensure_device_token above.
    tauri::async_runtime::block_on(async move {
        let mut req = crate::http_client()
            .post(&url)
            .timeout(std::time::Duration::from_secs(5));
        for (k, v) in headers {
            req = req.header(k, v);
        }
        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                info!("pty exit reported for terminal {terminal_id}");
            }
            Ok(resp) => {
                warn!(
                    "pty exit report for {terminal_id} returned {}",
                    resp.status()
                );
            }
            Err(e) => {
                warn!("pty exit report for {terminal_id} failed: {e}");
            }
        }
    });
}

// A session (spawned in some window, PtySession.ws_id, #219) may only be
// written to, resized, or killed by a caller whose OWN window resolves to
// that same workspace (#223) -- PtyState is process-wide, so without this
// one workspace's window could otherwise reach into another's PTY. Pure so
// the same/different/unresolved cases are unit-testable without a real
// window; unresolved on either side (a session with no workspace captured
// at spawn time, or a caller whose own window isn't a workspace window)
// is a deny, not a free pass.
fn session_owned_by(session_ws_id: Option<&str>, caller_ws_id: Option<&str>) -> bool {
    matches!((session_ws_id, caller_ws_id), (Some(a), Some(b)) if a == b)
}

fn pick_shell() -> (String, Vec<String>) {
    // Prefer the user's $SHELL so they get their familiar prompt, history,
    // aliases, etc. Fall back to /bin/zsh on macOS (default since 10.15)
    // and /bin/bash elsewhere if SHELL isn't set or readable.
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        });
    // -l makes it a login shell so /etc/zprofile / .zprofile run and
    // PATH picks up Homebrew etc. -i keeps it interactive after the
    // optional pre-command finishes, so the user can keep working
    // (e.g. claude exits, they stay in the shell).
    (shell, vec!["-l".into(), "-i".into()])
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, PtyState>,
    args: SpawnArgs,
) -> Result<(), String> {
    if !std::path::Path::new(&args.cwd).is_dir() {
        return Err(format!("cwd does not exist: {}", args.cwd));
    }

    // Guard against duplicate spawns. The multi-session design assumes
    // exactly one pty_spawn per session_id; the React TerminalPane mounts
    // once per session and never re-spawns on rerenders. If we land here
    // and the id already exists, something on the frontend is remounting
    // (a known symptom: 1Password keeps asking because the shell keeps
    // restarting). The right move is to keep the existing PTY alive and
    // log loudly — replacing would SIGHUP the running shell, which is
    // exactly the wrong thing for a multi-session workspace.
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(&args.session_id) {
            warn!(
                "pty_spawn called twice for session {} — keeping existing PTY (frontend remount bug?)",
                args.session_id
            );
            return Ok(());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // Workspace this terminal belongs to: the CALLING WINDOW's own (#223),
    // captured once here rather than re-resolved at exit time (#219) -- see
    // the PtySession.ws_id doc comment. None only for a fresh install with
    // no workspace configured yet, which cannot have a node terminal open
    // in the first place (every window that can spawn one is ws:<id>).
    let spawn_ws_id = crate::ws_of(&window).ok();

    let (shell, shell_args) = pick_shell();

    // Materialise the Seatbelt profile to a temp file and wrap the shell
    // in sandbox-exec. Fail-closed: when the caller asked for a sandbox
    // and we cannot apply it, refuse the spawn rather than silently
    // running the agent without the disk boundary. Non-macOS platforms
    // have no sandbox-exec; the profile is ignored with a warning there.
    let mut sandbox_profile_path: Option<std::path::PathBuf> = None;
    if let Some(profile) = args
        .sandbox_profile
        .as_deref()
        .filter(|p| !p.trim().is_empty())
    {
        if cfg!(target_os = "macos") {
            let path = std::env::temp_dir().join(format!(
                "portuni-sbx-{}.sb",
                args.session_id.replace('/', "_"),
            ));
            std::fs::write(&path, profile)
                .map_err(|e| format!("sandbox profile write failed: {e}"))?;
            sandbox_profile_path = Some(path);
        } else {
            warn!("sandbox_profile supplied on a non-macOS platform — spawning unsandboxed");
        }
    }

    let (program, argv) = spawn_program(
        &shell,
        &shell_args,
        sandbox_profile_path
            .as_ref()
            .map(|p| p.to_string_lossy())
            .as_deref(),
    );
    let mut cmd = CommandBuilder::new(&program);
    for a in &argv {
        cmd.arg(a);
    }
    cmd.cwd(&args.cwd);
    // Inherit a useful env: HOME, USER, TERM, LANG, etc. portable-pty
    // copies the parent env by default, which is what we want here so
    // the user's shell rc files have what they expect.
    cmd.env("TERM", "xterm-256color");
    {
        let (k, v) = terminal_id_env(&args.session_id);
        cmd.env(k, v);
    }
    // Spawn session id (#208 follow-up: "kernel-level isolation between
    // concurrent sessions on the same node"): the Seatbelt profile's own
    // projection grant is already narrowed to this id (it comes from the
    // same GET /nodes/:id/sandbox-profile response as sandbox_profile
    // above), so exporting it lets a Claude Code connection thread it
    // through (write-scope.ts's X-Portuni-Spawn-Id header) and reuse it as
    // the MCP session's own id instead of minting an unrelated one.
    // Exported whenever present, regardless of whether sandbox_profile
    // itself was applied (non-macOS spawns still benefit from the session
    // id lining up with the disk projection directory).
    if let Some(sid) = args
        .spawn_session_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        cmd.env("PORTUNI_SPAWN_SESSION_ID", sid);
    }
    // Inject one token env var per enabled workspace, so per-mirror configs
    // (which reference ${PORTUNI_MCP_TOKEN_<ID>:-}) resolve the right
    // credential regardless of which workspace the terminal's cwd belongs
    // to. PORTUNI_MCP_TOKEN keeps carrying the CALLING WINDOW's own
    // workspace token (#223; was the globally-active workspace pre-#222)
    // for backward compatibility with pre-workspace mirror configs.
    //
    // Both central-mode (agent) and local-mode terminals inject the LOCAL
    // sidecar's per-launch token (the value cached in AuthTokens / Keychain
    // KEYCHAIN_MCP_ACCOUNT, i.e. the sidecar's PORTUNI_AUTH_TOKEN). The
    // materialized .mcp.json points every terminal at the local sidecar, so
    // the central device token would be rejected (401) by the local gate —
    // see workspace::terminal_mcp_token.
    {
        let active_id = spawn_ws_id.clone();
        if let Ok(workspaces) = crate::enabled_workspaces(&app) {
            for (ws_id, cfg) in workspaces {
                let local_token = app
                    .state::<crate::AuthTokens>()
                    .0
                    .lock()
                    .ok()
                    .and_then(|m| m.get(&ws_id).cloned())
                    .or_else(|| crate::keychain_get_ws(crate::KEYCHAIN_MCP_ACCOUNT, &ws_id));
                let token = crate::workspace::terminal_mcp_token(
                    crate::workspace::is_central(&cfg),
                    local_token,
                );
                if let Some(token) = token {
                    cmd.env(crate::workspace::token_env_var(&ws_id), &token);
                    if active_id.as_deref() == Some(ws_id.as_str()) {
                        cmd.env("PORTUNI_MCP_TOKEN", &token);
                    }
                }
            }
        }
    }

    // Spawn profile (phase 3, spawn UX): merge its env vars into the shell
    // and, when it carries a command override, use that instead of the
    // caller's derived agent command. Also exports PORTUNI_PROFILE_ID so a
    // Claude Code connection can thread it through to the session record
    // (see write-scope.ts's X-Portuni-Profile header) -- exported whenever
    // a profile id was requested, even if the registry lookup below finds
    // nothing (a profile since deleted from config.json), so the session
    // record still reflects the user's intent. resolve_profile_env drops
    // PORTUNI_* keys (must not override the token/profile-id env already
    // set above) and expands a leading `~` in each value (#207).
    let mut command_override: Option<String> = None;
    if let Some(pid) = args.profile_id.as_deref().filter(|p| !p.trim().is_empty()) {
        cmd.env("PORTUNI_PROFILE_ID", pid);
        if let Ok(data_dir) = app.path().app_data_dir() {
            if let Ok(crate::workspace::LoadedConfig::V2(file)) = crate::workspace::load(&data_dir) {
                if let Some(profile) = file.profiles.get(pid) {
                    let home = std::env::var("HOME").ok();
                    for (k, v) in resolve_profile_env(&profile.env, home.as_deref()) {
                        cmd.env(k, v);
                    }
                    command_override = profile.command.clone();
                }
            }
        }
    }
    let effective_command = command_override.unwrap_or_else(|| args.command.clone());

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn shell failed: {e}"))?;
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader failed: {e}"))?;

    let session_id = args.session_id.clone();
    let session = PtySession {
        master: pair.master,
        writer,
        _child: child,
        ws_id: spawn_ws_id.clone(),
    };

    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        // If a session with this id already exists, replace it (the old
        // child will be dropped, sending SIGHUP). The webview is expected
        // to use unique ids per mount, but be defensive.
        sessions.insert(session_id.clone(), session);
    }

    // If a pre-command was supplied, write it to a tempfile and inject
    // a short `bash /tmp/X; rm /tmp/X` line into the shell instead of
    // typing the full multi-line command via the pty. Typing it directly
    // makes bash print PS2 continuation prompts (`cmdand quote>`) for
    // every embedded newline in the agent prompt, which looks broken
    // even though it eventually executes correctly.
    if !effective_command.trim().is_empty() {
        let tempfile = std::env::temp_dir().join(format!(
            "portuni-precmd-{}.sh",
            session_id.replace('/', "_"),
        ));
        let script = format!("#!/bin/bash\n{}\n", effective_command.trim());
        if let Err(e) = std::fs::write(&tempfile, script) {
            warn!("pty pre-command tempfile write failed: {e}");
        } else {
            let quoted = shell_single_quote(&tempfile.to_string_lossy());
            let invocation = format!("bash {0}; rm -f {0}\n", quoted);
            let sid = session_id.clone();
            let app_handle = app.clone();
            thread::spawn(move || {
                // Give the shell ~150ms to print its first prompt before
                // injecting. Not strictly required but cosmetic.
                thread::sleep(std::time::Duration::from_millis(150));
                if let Some(state) = app_handle.try_state::<PtyState>() {
                    if let Ok(mut sessions) = state.sessions.lock() {
                        if let Some(s) = sessions.get_mut(&sid) {
                            if let Err(e) = s.writer.write_all(invocation.as_bytes()) {
                                warn!("pty pre-command write failed for {sid}: {e}");
                            } else {
                                let _ = s.writer.flush();
                            }
                        }
                    }
                }
            });
        }
    }

    // Reader thread: streams pty output to the webview as `pty-data`
    // events. Exits when read returns 0 (pty closed) or errors.
    let app_for_reader = app.clone();
    let sid_for_reader = session_id.clone();
    // Per-window events (#227): pty-data/pty-exit target only the window
    // that owns this session, not every window (a second workspace's window
    // must never see another's terminal output). Captured once here, same
    // as PtySession.ws_id -- None falls back to a broadcast emit, the old
    // (pre-#227) behavior, for the never-actually-happens case of no
    // workspace resolved at spawn time.
    let label_for_reader = spawn_ws_id.clone().map(|id| format!("ws:{id}"));
    let profile_for_cleanup = sandbox_profile_path.clone();
    thread::spawn(move || {
        let mut reader = reader;
        // 16 KB buffer reduces per-chunk overhead (event serialization
        // + IPC round-trip) for high-throughput output. Larger buffers
        // mean fewer events; xterm's WebGL renderer handles the bigger
        // chunks easily.
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    info!("pty {sid_for_reader} EOF");
                    break;
                }
                Ok(n) => {
                    let encoded = BASE64_STANDARD.encode(&buf[..n]);
                    let payload = PtyDataEvent {
                        session_id: sid_for_reader.clone(),
                        data_b64: encoded,
                    };
                    let sent = match &label_for_reader {
                        Some(label) => app_for_reader.emit_to(label, "pty-data", payload),
                        None => app_for_reader.emit("pty-data", payload),
                    };
                    if let Err(e) = sent {
                        error!("pty-data emit failed for {sid_for_reader}: {e}");
                        break;
                    }
                }
                Err(e) => {
                    info!("pty {sid_for_reader} read err: {e}");
                    break;
                }
            }
        }
        // Tell the webview the session is gone so it can clean up xterm.
        let exit_payload = PtyExitEvent {
            session_id: sid_for_reader.clone(),
            code: None,
        };
        let _ = match &label_for_reader {
            Some(label) => app_for_reader.emit_to(label, "pty-exit", exit_payload),
            None => app_for_reader.emit("pty-exit", exit_payload),
        };
        // Removing returns the session so its ws_id (captured at spawn,
        // #219) is available for the exit report below without a second
        // capture into this closure.
        let mut removed_ws_id: Option<String> = None;
        if let Some(state) = app_for_reader.try_state::<PtyState>() {
            if let Ok(mut sessions) = state.sessions.lock() {
                removed_ws_id = sessions.remove(&sid_for_reader).and_then(|s| s.ws_id);
            }
        }
        // Tell the sidecar this PTY is gone so it closes any correlated
        // `running` session (#219). Fires for every exit reason; see
        // report_terminal_exit's doc comment.
        match removed_ws_id.as_deref() {
            Some(ws_id) => report_terminal_exit(&app_for_reader, ws_id, &sid_for_reader),
            None => warn!(
                "pty exit report for {sid_for_reader} skipped: no workspace resolved at spawn time"
            ),
        }
        // The sandbox profile tempfile is only needed at exec time;
        // remove it once the session is gone.
        if let Some(p) = profile_for_cleanup {
            let _ = std::fs::remove_file(p);
        }
    });

    Ok(())
}

#[derive(Deserialize)]
pub struct WriteArgs {
    pub session_id: String,
    pub data: String,
}

#[tauri::command]
pub fn pty_write(
    window: tauri::Window,
    state: State<'_, PtyState>,
    args: WriteArgs,
) -> Result<(), String> {
    let caller_ws = crate::ws_label_id(&window);
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&args.session_id)
        .ok_or_else(|| format!("no session {}", args.session_id))?;
    if !session_owned_by(session.ws_id.as_deref(), caller_ws.as_deref()) {
        return Err(format!("session {} does not belong to this window", args.session_id));
    }
    session
        .writer
        .write_all(args.data.as_bytes())
        .map_err(|e| format!("pty write failed: {e}"))?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Deserialize)]
pub struct ResizeArgs {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[tauri::command]
pub fn pty_resize(
    window: tauri::Window,
    state: State<'_, PtyState>,
    args: ResizeArgs,
) -> Result<(), String> {
    let caller_ws = crate::ws_label_id(&window);
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&args.session_id)
        .ok_or_else(|| format!("no session {}", args.session_id))?;
    if !session_owned_by(session.ws_id.as_deref(), caller_ws.as_deref()) {
        return Err(format!("session {} does not belong to this window", args.session_id));
    }
    session
        .master
        .resize(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))?;
    Ok(())
}

#[derive(Deserialize)]
pub struct KillArgs {
    pub session_id: String,
}

#[tauri::command]
pub fn pty_kill(
    window: tauri::Window,
    state: State<'_, PtyState>,
    args: KillArgs,
) -> Result<(), String> {
    let caller_ws = crate::ws_label_id(&window);
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let Some(session) = sessions.get(&args.session_id) else {
        // Already gone (e.g. the reader thread's own removal raced this
        // call) -- killing a nonexistent session is a no-op, not an error.
        return Ok(());
    };
    if !session_owned_by(session.ws_id.as_deref(), caller_ws.as_deref()) {
        return Err(format!("session {} does not belong to this window", args.session_id));
    }
    // Dropping the PtySession drops the child handle, which sends
    // SIGHUP to the process group. The reader thread sees EOF and
    // exits naturally.
    sessions.remove(&args.session_id);
    Ok(())
}

#[cfg(test)]
mod session_owned_by_tests {
    use super::session_owned_by;

    #[test]
    fn same_workspace_is_owned() {
        assert!(session_owned_by(Some("acme"), Some("acme")));
    }

    #[test]
    fn different_workspace_is_refused() {
        assert!(!session_owned_by(Some("acme"), Some("other")));
    }

    #[test]
    fn a_session_with_no_captured_workspace_is_refused() {
        assert!(!session_owned_by(None, Some("acme")));
    }

    #[test]
    fn a_caller_with_no_resolved_workspace_is_refused() {
        assert!(!session_owned_by(Some("acme"), None));
    }

    #[test]
    fn both_unresolved_is_refused() {
        assert!(!session_owned_by(None, None));
    }
}

#[cfg(test)]
mod terminal_exit_tests {
    use super::*;

    #[test]
    fn terminal_id_env_exports_the_session_id_verbatim() {
        let (k, v) = terminal_id_env("term_n1_1758012345_ab12");
        assert_eq!(k, "PORTUNI_TERMINAL_ID");
        assert_eq!(v, "term_n1_1758012345_ab12");
    }

    #[test]
    fn exit_request_builds_url_and_headers_without_proxy_secret() {
        let (url, headers) =
            terminal_exit_request(47011, "term_n1_1_abc", "tok123", None);
        assert_eq!(url, "http://127.0.0.1:47011/terminals/term_n1_1_abc/exit");
        assert_eq!(
            headers,
            vec![
                ("Authorization".to_string(), "Bearer tok123".to_string()),
                ("Origin".to_string(), "tauri://localhost".to_string()),
            ]
        );
    }

    #[test]
    fn exit_request_includes_webview_proxy_secret_when_present() {
        let (_, headers) =
            terminal_exit_request(47011, "term_n1_1_abc", "tok123", Some("secret-xyz"));
        assert_eq!(
            headers,
            vec![
                ("Authorization".to_string(), "Bearer tok123".to_string()),
                ("Origin".to_string(), "tauri://localhost".to_string()),
                (
                    "X-Portuni-Webview-Proxy".to_string(),
                    "secret-xyz".to_string()
                ),
            ]
        );
    }
}

#[cfg(test)]
mod spawn_program_tests {
    use super::*;

    #[test]
    fn wraps_shell_in_sandbox_exec_when_profile_given() {
        let (program, argv) = spawn_program(
            "/bin/zsh",
            &["-l".to_string(), "-i".to_string()],
            Some("/tmp/portuni-sbx-s1.sb"),
        );
        assert_eq!(program, "/usr/bin/sandbox-exec");
        assert_eq!(argv, vec!["-f", "/tmp/portuni-sbx-s1.sb", "/bin/zsh", "-l", "-i"]);
    }

    #[test]
    fn runs_shell_directly_without_profile() {
        let (program, argv) = spawn_program("/bin/zsh", &["-l".to_string()], None);
        assert_eq!(program, "/bin/zsh");
        assert_eq!(argv, vec!["-l"]);
    }
}

#[cfg(test)]
mod profile_env_tests {
    use super::*;

    #[test]
    fn expand_tilde_expands_leading_slash_form() {
        assert_eq!(
            expand_tilde("~/.claude-work", Some("/Users/honza")),
            "/Users/honza/.claude-work"
        );
    }

    #[test]
    fn expand_tilde_expands_bare_tilde() {
        assert_eq!(expand_tilde("~", Some("/Users/honza")), "/Users/honza");
    }

    #[test]
    fn expand_tilde_leaves_absolute_paths_untouched() {
        assert_eq!(
            expand_tilde("/Users/honza/.claude-work", Some("/Users/honza")),
            "/Users/honza/.claude-work"
        );
    }

    #[test]
    fn expand_tilde_only_expands_a_leading_tilde() {
        // A tilde elsewhere in the value (not the leading char) is not a
        // shell home-dir reference and must be left alone.
        assert_eq!(
            expand_tilde("foo~/bar", Some("/Users/honza")),
            "foo~/bar"
        );
    }

    #[test]
    fn expand_tilde_without_a_known_home_is_a_no_op() {
        assert_eq!(expand_tilde("~/.claude-work", None), "~/.claude-work");
    }

    #[test]
    fn resolve_profile_env_drops_portuni_keys_and_expands_tilde() {
        let mut env = std::collections::BTreeMap::new();
        env.insert("CLAUDE_CONFIG_DIR".to_string(), "~/.claude-work".to_string());
        env.insert("PORTUNI_MCP_TOKEN".to_string(), "attacker-supplied".to_string());
        env.insert("PORTUNI_PROFILE_ID".to_string(), "sneaky".to_string());
        env.insert("EDITOR".to_string(), "vim".to_string());

        let resolved = resolve_profile_env(&env, Some("/Users/honza"));

        assert_eq!(
            resolved,
            vec![
                ("CLAUDE_CONFIG_DIR".to_string(), "/Users/honza/.claude-work".to_string()),
                ("EDITOR".to_string(), "vim".to_string()),
            ]
        );
    }

    #[test]
    fn resolve_profile_env_of_an_empty_map_is_empty() {
        assert!(resolve_profile_env(&std::collections::BTreeMap::new(), Some("/Users/honza")).is_empty());
    }
}
