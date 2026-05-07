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
    let mut cmd = CommandBuilder::new(&shell);
    for a in &shell_args {
        cmd.arg(a);
    }
    cmd.cwd(&args.cwd);
    // Inherit a useful env: HOME, USER, TERM, LANG, etc. portable-pty
    // copies the parent env by default, which is what we want here so
    // the user's shell rc files have what they expect.
    cmd.env("TERM", "xterm-256color");

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
