// The live channel bridge (#341, docs/superpowers/specs/
// 2026-09-12-runner-and-session-design.md, "Model: Live channel; Desktop").
// The webview never opens the session WebSocket itself (security rule 3,
// root CLAUDE.md): `sessions_connect` holds ONE connection per window to
// that window's own workspace sidecar (`ws_of(&window)`, same bearer
// source `api_request` uses) and bridges every server frame to a
// `session-event` window event; `sessions_send` writes a client frame back
// through the same connection. Reconnects with backoff 1 s -> 30 s inside
// Rust, emitting `session-connection { status }` so the UI can show it.
//
// Registry is keyed by workspace id (like `BackendPorts`/`AuthTokens` in
// lib.rs), not by an opaque per-call id -- the spec is explicit about one
// connection per window, and every `ws:<id>` window maps 1:1 to a workspace.

use crate::errors::CmdError;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use log::{info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

const MIN_BACKOFF_MS: u64 = 1_000;
const MAX_BACKOFF_MS: u64 = 30_000;

// Pure: given the delay just used for a failed (re)connect attempt, what's
// the next one. Doubles, capped at MAX_BACKOFF_MS. A successful connect
// resets the caller's own tracked delay back to MIN_BACKOFF_MS -- this
// function only ever computes the step, never the reset.
pub(crate) fn next_backoff_ms(current_ms: u64) -> u64 {
    current_ms.saturating_mul(2).min(MAX_BACKOFF_MS)
}

#[derive(Serialize, Clone)]
struct SessionEventPayload {
    frame: serde_json::Value,
}

#[derive(Serialize, Clone)]
struct SessionConnectionPayload {
    status: &'static str,
}

// The frame codec: every server->client message on the wire is a JSON
// object (reply/error/event/delta/session_state -- see
// apps/server/api/sessions-ws.ts). Decoded into an untyped serde_json::Value
// rather than a matching Rust enum on purpose -- this bridge only ever
// forwards frames to the webview, which already owns the typed protocol
// (apps/web/src/lib/sessions-client.ts); duplicating that union here would
// just be a second place for the two to drift apart. Extracted as its own
// function purely so decode failures (a malformed frame, or a future
// protocol change on the server side this build doesn't know about yet)
// are independently testable without a live socket.
fn decode_server_frame(text: &str) -> serde_json::Result<serde_json::Value> {
    serde_json::from_str(text)
}

fn encode_session_event(frame: serde_json::Value) -> SessionEventPayload {
    SessionEventPayload { frame }
}

// The frames waiting for the live socket (#496). sessions_send pushes, the
// background task pops and writes, sessions_cancel takes a still-queued
// frame back out by its request id. A frame sent while the socket is down
// waits here across the reconnect -- which is why it has to be cancellable:
// the webview reports a request that got no reply in time as failed and
// cancels it, and a failed request must never be delivered afterwards (a
// resend would reach the agent twice). A frame already written is out of
// reach; cancelling it is a no-op.
#[derive(Default)]
struct Outbox {
    queue: Mutex<VecDeque<(Option<String>, String)>>,
    notify: Notify,
    closed: AtomicBool,
}

impl Outbox {
    fn push(&self, frame: String) {
        let id = frame_id(&frame);
        if let Ok(mut queue) = self.queue.lock() {
            queue.push_back((id, frame));
        }
        self.notify.notify_one();
    }

    fn cancel(&self, id: &str) {
        if let Ok(mut queue) = self.queue.lock() {
            queue.retain(|(frame_id, _)| frame_id.as_deref() != Some(id));
        }
    }

    fn pop(&self) -> Option<String> {
        self.queue.lock().ok()?.pop_front().map(|(_, frame)| frame)
    }

    // Wakes the background task for good: it closes its socket and exits.
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.notify.notify_one();
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

// The request id the webview put on a client frame (every request frame
// carries one, apps/web/src/lib/sessions-client.ts); None for a frame
// without one, which then cannot be cancelled.
fn frame_id(frame: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(frame)
        .ok()?
        .get("id")?
        .as_str()
        .map(str::to_owned)
}

struct Connection {
    // sessions_send writes frames in here; the background task reads them
    // and forwards each over the live socket.
    outbox: Arc<Outbox>,
    // Bumped on every sessions_connect/sessions_disconnect for this
    // workspace so a background task from a PRIOR connect (e.g. sleeping
    // out a reconnect backoff when a fresh connect or a disconnect
    // supersedes it) recognizes it no longer owns the registry entry and
    // exits instead of resurrecting a connection nothing wants anymore.
    generation: u64,
}

#[derive(Default)]
pub struct SessionsWsState {
    connections: Mutex<HashMap<String, Connection>>,
}

fn is_current_generation(app: &AppHandle, ws_id: &str, generation: u64) -> bool {
    let Some(state) = app.try_state::<SessionsWsState>() else {
        return false;
    };
    let Ok(conns) = state.connections.lock() else {
        return false;
    };
    conns.get(ws_id).map(|c| c.generation) == Some(generation)
}

fn emit_connection_status(app: &AppHandle, ws_id: &str, status: &'static str) {
    let _ = app.emit_to(
        format!("ws:{ws_id}"),
        "session-connection",
        SessionConnectionPayload { status },
    );
}

#[tauri::command]
pub(crate) async fn sessions_connect(app: AppHandle, window: tauri::Window) -> Result<(), CmdError> {
    let ws_id = crate::ws_of(&window)?;
    let outbox = Arc::new(Outbox::default());
    let generation = {
        let state = app.state::<SessionsWsState>();
        let mut conns = state.connections.lock().map_err(|e| e.to_string())?;
        // Replacing an existing entry (a second sessions_connect for the
        // same window, e.g. a remount) closes its outbox, which is exactly
        // the signal the old background task needs to close its socket and
        // stop instead of running alongside the new one.
        let generation = conns.get(&ws_id).map(|c| c.generation + 1).unwrap_or(0);
        if let Some(old) = conns.insert(
            ws_id.clone(),
            Connection {
                outbox: outbox.clone(),
                generation,
            },
        ) {
            old.outbox.close();
        }
        generation
    };

    tauri::async_runtime::spawn(run_connection_loop(app, ws_id, generation, outbox));
    Ok(())
}

#[tauri::command]
pub(crate) fn sessions_disconnect(app: AppHandle, window: tauri::Window) -> Result<(), CmdError> {
    let ws_id = crate::ws_of(&window)?;
    disconnect_for_ws(&app, &ws_id);
    Ok(())
}

// Shared by the sessions_disconnect command and lib.rs's window Destroyed
// handler -- a force-closed window must not leave an orphaned background
// task holding a live socket open.
pub(crate) fn disconnect_for_ws(app: &AppHandle, ws_id: &str) {
    if let Some(state) = app.try_state::<SessionsWsState>() {
        if let Ok(mut conns) = state.connections.lock() {
            // Closing the entry's outbox wakes the background task, which
            // is its own signal to close the socket and exit for good
            // rather than reconnect.
            if let Some(conn) = conns.remove(ws_id) {
                conn.outbox.close();
            }
        }
    }
    emit_connection_status(app, ws_id, "closed");
}

#[tauri::command]
pub(crate) fn sessions_send(app: AppHandle, window: tauri::Window, frame: String) -> Result<(), CmdError> {
    let ws_id = crate::ws_of(&window)?;
    let state = app.state::<SessionsWsState>();
    let conns = state.connections.lock().map_err(|e| e.to_string())?;
    let conn = conns
        .get(&ws_id)
        .ok_or_else(|| "sessions_send: not connected".to_string())?;
    conn.outbox.push(frame);
    Ok(())
}

// Takes a frame the webview gave up on out of the outbox, if it is still
// queued (#496).
#[tauri::command]
pub(crate) fn sessions_cancel(app: AppHandle, window: tauri::Window, id: String) -> Result<(), CmdError> {
    let ws_id = crate::ws_of(&window)?;
    let state = app.state::<SessionsWsState>();
    let conns = state.connections.lock().map_err(|e| e.to_string())?;
    if let Some(conn) = conns.get(&ws_id) {
        conn.outbox.cancel(&id);
    }
    Ok(())
}

async fn run_connection_loop(
    app: AppHandle,
    ws_id: String,
    generation: u64,
    outbox: Arc<Outbox>,
) {
    let mut backoff_ms = MIN_BACKOFF_MS;
    loop {
        if !is_current_generation(&app, &ws_id, generation) {
            return;
        }

        let (port, token) = match crate::sidecar_port_and_token(&app, &ws_id) {
            Ok(pt) => pt,
            Err(e) => {
                warn!("sessions_connect[{ws_id}]: {e}");
                emit_connection_status(&app, &ws_id, "reconnecting");
                if !sleep_unless_superseded(&app, &ws_id, generation, backoff_ms).await {
                    return;
                }
                backoff_ms = next_backoff_ms(backoff_ms);
                continue;
            }
        };

        let url = format!("ws://127.0.0.1:{port}/sessions/ws");
        let mut request = match url.into_client_request() {
            Ok(r) => r,
            Err(e) => {
                warn!("sessions_connect[{ws_id}]: bad url: {e}");
                return;
            }
        };
        let headers = request.headers_mut();
        match HeaderValue::from_str(&format!("Bearer {token}")) {
            Ok(v) => {
                headers.insert("Authorization", v);
            }
            Err(e) => {
                warn!("sessions_connect[{ws_id}]: bad token header: {e}");
                return;
            }
        }
        headers.insert("Origin", HeaderValue::from_static("tauri://localhost"));
        // Same proof api_request attaches (#213): the upgrade originates in
        // this Tauri host, so the socket's mutating frames (message, answer,
        // interrupt, close, continue) are accepted; an external process that
        // opens the same socket with the bearer alone can only watch.
        if let Some(secret) = crate::webview_proxy_secret(&app, &ws_id) {
            match HeaderValue::from_str(&secret) {
                Ok(v) => {
                    headers.insert("X-Portuni-Webview-Proxy", v);
                }
                Err(e) => warn!("sessions_connect[{ws_id}]: bad proxy secret header: {e}"),
            }
        }

        match tokio_tungstenite::connect_async(request).await {
            Ok((stream, _response)) => {
                backoff_ms = MIN_BACKOFF_MS;
                emit_connection_status(&app, &ws_id, "open");
                info!("sessions_connect[{ws_id}]: connected");

                let (mut write, mut read) = stream.split();
                let mut disconnected = false;
                'socket: loop {
                    if outbox.is_closed() {
                        let _ = write.close().await;
                        disconnected = true;
                        break;
                    }
                    while let Some(frame) = outbox.pop() {
                        if write.send(Message::Text(frame.into())).await.is_err() {
                            break 'socket;
                        }
                    }
                    tokio::select! {
                        // A push or a close since the last drain; Notify keeps
                        // one permit, so a push between the drain and this
                        // await is not lost.
                        _ = outbox.notify.notified() => {}
                        incoming = read.next() => {
                            match incoming {
                                Some(Ok(Message::Text(text))) => {
                                    match decode_server_frame(&text) {
                                        Ok(frame) => {
                                            let _ = app.emit_to(
                                                format!("ws:{ws_id}"),
                                                "session-event",
                                                encode_session_event(frame),
                                            );
                                        }
                                        Err(e) => warn!("sessions_connect[{ws_id}]: malformed frame: {e}"),
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None => break,
                                // Ping/Pong/Binary/Frame -- tungstenite answers
                                // Ping with Pong on its own; nothing else to do.
                                Some(Ok(_)) => {}
                                Some(Err(e)) => {
                                    warn!("sessions_connect[{ws_id}]: read error: {e}");
                                    break;
                                }
                            }
                        }
                    }
                }

                if disconnected || !is_current_generation(&app, &ws_id, generation) {
                    return;
                }
                emit_connection_status(&app, &ws_id, "reconnecting");
            }
            Err(e) => {
                warn!("sessions_connect[{ws_id}]: connect failed: {e}");
                emit_connection_status(&app, &ws_id, "reconnecting");
            }
        }

        if !sleep_unless_superseded(&app, &ws_id, generation, backoff_ms).await {
            return;
        }
        backoff_ms = next_backoff_ms(backoff_ms);
    }
}

// Sleeps out the current backoff delay, but wakes early (returning false,
// meaning "stop, do not reconnect") the moment a newer generation
// supersedes this one -- otherwise a disconnect during a long backoff sleep
// would only be noticed after the full delay elapsed.
async fn sleep_unless_superseded(app: &AppHandle, ws_id: &str, generation: u64, delay_ms: u64) -> bool {
    const POLL_MS: u64 = 200;
    let mut waited_ms = 0u64;
    while waited_ms < delay_ms {
        if !is_current_generation(app, ws_id, generation) {
            return false;
        }
        let step = POLL_MS.min(delay_ms - waited_ms);
        tokio::time::sleep(Duration::from_millis(step)).await;
        waited_ms += step;
    }
    is_current_generation(app, ws_id, generation)
}

#[cfg(test)]
mod backoff_tests {
    use super::*;

    #[test]
    fn starts_at_one_second_and_doubles() {
        let mut delay = MIN_BACKOFF_MS;
        assert_eq!(delay, 1_000);
        delay = next_backoff_ms(delay);
        assert_eq!(delay, 2_000);
        delay = next_backoff_ms(delay);
        assert_eq!(delay, 4_000);
    }

    #[test]
    fn caps_at_thirty_seconds() {
        let mut delay = MIN_BACKOFF_MS;
        for _ in 0..10 {
            delay = next_backoff_ms(delay);
        }
        assert_eq!(delay, MAX_BACKOFF_MS);
        // One more step must not overflow or exceed the cap.
        assert_eq!(next_backoff_ms(delay), MAX_BACKOFF_MS);
    }

    #[test]
    fn never_overflows_from_a_pathological_starting_value() {
        assert_eq!(next_backoff_ms(u64::MAX), MAX_BACKOFF_MS);
    }
}

#[cfg(test)]
mod frame_codec_tests {
    use super::*;

    #[test]
    fn decodes_a_canonical_event_frame_without_losing_fields() {
        let text = r#"{"type":"event","payload":{"session_id":"S1","event":{"kind":"assistant_message","payload":{"text":"hi"},"seq":3}}}"#;
        let frame = decode_server_frame(text).expect("valid frame decodes");
        assert_eq!(frame["type"], "event");
        assert_eq!(frame["payload"]["event"]["seq"], 3);
        assert_eq!(frame["payload"]["event"]["payload"]["text"], "hi");
    }

    #[test]
    fn decodes_a_delta_frame() {
        let text = r#"{"type":"delta","payload":{"session_id":"S1","run_id":"R1","text":"partial"}}"#;
        let frame = decode_server_frame(text).expect("valid frame decodes");
        assert_eq!(frame["type"], "delta");
        assert_eq!(frame["payload"]["run_id"], "R1");
    }

    #[test]
    fn rejects_malformed_json_instead_of_panicking() {
        assert!(decode_server_frame("{not json").is_err());
    }

    #[test]
    fn encode_session_event_wraps_the_frame_verbatim_for_the_webview() {
        let frame = serde_json::json!({"type": "session_state", "payload": {"session_id": "S1"}});
        let payload = encode_session_event(frame.clone());
        let round_tripped = serde_json::to_value(&payload).expect("serializes");
        assert_eq!(round_tripped["frame"], frame);
    }
}

#[cfg(test)]
mod outbox_tests {
    use super::*;

    #[test]
    fn a_cancelled_frame_is_never_popped_and_the_rest_keep_their_order() {
        let outbox = Outbox::default();
        outbox.push(r#"{"id":"a","type":"subscribe","payload":{}}"#.to_string());
        outbox.push(r#"{"id":"b","type":"message","payload":{}}"#.to_string());
        outbox.push(r#"{"id":"c","type":"interrupt","payload":{}}"#.to_string());
        outbox.cancel("b");
        assert_eq!(frame_id(&outbox.pop().expect("a")).as_deref(), Some("a"));
        assert_eq!(frame_id(&outbox.pop().expect("c")).as_deref(), Some("c"));
        assert!(outbox.pop().is_none());
    }

    #[test]
    fn cancelling_a_frame_already_popped_or_unknown_is_a_no_op() {
        let outbox = Outbox::default();
        outbox.push(r#"{"id":"a","type":"message","payload":{}}"#.to_string());
        assert!(outbox.pop().is_some());
        outbox.cancel("a");
        outbox.cancel("nope");
        outbox.push(r#"{"type":"unsubscribe","payload":{}}"#.to_string());
        assert!(outbox.pop().is_some());
    }

    #[test]
    fn frame_id_reads_the_request_id_and_nothing_else() {
        assert_eq!(frame_id(r#"{"id":"x1","type":"message"}"#).as_deref(), Some("x1"));
        assert_eq!(frame_id(r#"{"type":"unsubscribe"}"#), None);
        assert_eq!(frame_id("{not json"), None);
    }

    #[test]
    fn close_marks_the_outbox_closed() {
        let outbox = Outbox::default();
        assert!(!outbox.is_closed());
        outbox.close();
        assert!(outbox.is_closed());
    }
}
