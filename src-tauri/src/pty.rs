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

// For device-token Keychain operations in ensure_device_token.
use keyring;

// Keychain account for the long-lived device token used by agent terminals
// in central data_mode. Separate from the per-launch MCP token used in local
// mode so the two don't interfere.
const KEYCHAIN_DEVICE_TOKEN_ACCOUNT: &str = "portuni_device_token";

/// Return the device token for central-mode terminal sessions. Tries Keychain
/// first; if absent, mints one via POST /device-tokens on the central server
/// (using the current session JWT) and stores it. Errors if not logged in.
///
/// Blocking: calls block_on internally because pty_spawn is a sync command.
fn ensure_device_token(app: &AppHandle) -> Result<String, String> {
    // Return cached token if already in Keychain.
    if let Some(t) = crate::auth::keychain_get(KEYCHAIN_DEVICE_TOKEN_ACCOUNT) {
        return Ok(t);
    }

    // Need to mint. Require a session JWT.
    let jwt = crate::auth::keychain_get(crate::auth::KEYCHAIN_SESSION_JWT)
        .ok_or_else(|| "not logged in: no session JWT in Keychain".to_string())?;

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = crate::load_config(&data_dir);
    let server_url = config
        .server_url
        .ok_or_else(|| "central mode requires server_url in config.json".to_string())?;

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
    keyring::Entry::new(crate::KEYCHAIN_SERVICE, KEYCHAIN_DEVICE_TOKEN_ACCOUNT)
        .map_err(|e| e.to_string())?
        .set_password(&token)
        .map_err(|e| e.to_string())?;
    info!("pty: device token minted and stored in Keychain");

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
    // Inject PORTUNI_MCP_TOKEN so the per-mirror .mcp.json (which references
    // it as `${PORTUNI_MCP_TOKEN:-}`) resolves to the right bearer credential.
    //
    // In local mode: use the per-launch sidecar auth token from AuthToken state.
    // In central mode: use the device token from Keychain (account
    //   "portuni_device_token"); if absent, mint one via POST /device-tokens and
    //   store it. If not logged in, skip injection (terminal works without MCP).
    {
        let is_central = {
            if let Ok(data_dir) = app.path().app_data_dir() {
                let cfg = crate::load_config(&data_dir);
                cfg.data_mode.as_deref() == Some("central")
            } else {
                false
            }
        };

        if is_central {
            match ensure_device_token(&app) {
                Ok(token) => {
                    cmd.env("PORTUNI_MCP_TOKEN", token);
                }
                Err(e) => {
                    warn!("pty_spawn: could not obtain device token for central mode, skipping PORTUNI_MCP_TOKEN injection: {e}");
                }
            }
        } else {
            // Local mode: use the per-launch sidecar auth token.
            if let Ok(token) = app.state::<crate::AuthToken>().0.lock() {
                if !token.is_empty() {
                    cmd.env("PORTUNI_MCP_TOKEN", token.clone());
                }
            }
        }
    }

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
    if !args.command.trim().is_empty() {
        let tempfile = std::env::temp_dir().join(format!(
            "portuni-precmd-{}.sh",
            session_id.replace('/', "_"),
        ));
        let script = format!("#!/bin/bash\n{}\n", args.command.trim());
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
                    if let Err(e) = app_for_reader.emit(
                        "pty-data",
                        PtyDataEvent {
                            session_id: sid_for_reader.clone(),
                            data_b64: encoded,
                        },
                    ) {
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
        let _ = app_for_reader.emit(
            "pty-exit",
            PtyExitEvent {
                session_id: sid_for_reader.clone(),
                code: None,
            },
        );
        if let Some(state) = app_for_reader.try_state::<PtyState>() {
            if let Ok(mut sessions) = state.sessions.lock() {
                sessions.remove(&sid_for_reader);
            }
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
pub fn pty_write(state: State<'_, PtyState>, args: WriteArgs) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&args.session_id)
        .ok_or_else(|| format!("no session {}", args.session_id))?;
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
pub fn pty_resize(state: State<'_, PtyState>, args: ResizeArgs) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&args.session_id)
        .ok_or_else(|| format!("no session {}", args.session_id))?;
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
pub fn pty_kill(state: State<'_, PtyState>, args: KillArgs) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    // Dropping the PtySession drops the child handle, which sends
    // SIGHUP to the process group. The reader thread sees EOF and
    // exits naturally.
    sessions.remove(&args.session_id);
    Ok(())
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
