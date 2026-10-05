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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
// How long one connect (TCP plus the WebSocket upgrade) may take. A sidecar
// that accepts the TCP connection and never answers the upgrade otherwise
// parks the loop for good: no `reconnecting`, no retry (#590). Same bound as
// the direct transport's CONNECT_TIMEOUT_MS in apps/web.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

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
//
// A frame sessions_send took is never dropped by a later sessions_connect:
// the connection that replaces this one starts with every frame still
// waiting here (SessionsWsState::register), so the webview has nothing to
// mirror or resend across a reconnect.
#[derive(Default)]
struct Outbox {
    queue: Mutex<VecDeque<(Option<String>, String)>>,
    notify: Notify,
    closed: AtomicBool,
}

impl Outbox {
    fn with_frames(frames: VecDeque<(Option<String>, String)>) -> Self {
        Outbox {
            queue: Mutex::new(frames),
            notify: Notify::new(),
            closed: AtomicBool::new(false),
        }
    }

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

    // Closes the outbox and takes every frame still waiting in it, for the
    // connection that replaces this one. Both happen under the queue lock,
    // so the old loop finds the outbox closed or empty, never a frame it
    // could still write to the socket being retired: a frame that is
    // carried over goes out once, on the new socket.
    fn close_and_take(&self) -> VecDeque<(Option<String>, String)> {
        let taken = match self.queue.lock() {
            Ok(mut queue) => {
                self.closed.store(true, Ordering::SeqCst);
                std::mem::take(&mut *queue)
            }
            Err(_) => {
                self.closed.store(true, Ordering::SeqCst);
                VecDeque::new()
            }
        };
        self.notify.notify_one();
        taken
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
    // A fresh value from SessionsWsState::next_generation on every
    // sessions_connect, so a background task from a PRIOR connect (e.g.
    // sleeping out a reconnect backoff when a fresh connect or a disconnect
    // supersedes it) recognizes it no longer owns the registry entry and
    // exits instead of resurrecting a connection nothing wants anymore.
    generation: u64,
}

#[derive(Default)]
pub struct SessionsWsState {
    connections: Mutex<HashMap<String, Connection>>,
    // Never reset, not even by a disconnect that removes the entry: a loop
    // from before the disconnect must never match the next connect's
    // generation.
    next_generation: AtomicU64,
}

// What SessionsWsState::register hands the connection loop a
// sessions_connect starts.
struct Registered {
    outbox: Arc<Outbox>,
    generation: u64,
    // An entry for the window existed and was replaced: the socket that went
    // with it is gone, which the webview has to hear as `reconnecting`.
    replaced: bool,
}

// The registry behind the commands, kept free of the AppHandle so its
// bookkeeping is testable without a Tauri runtime (state_tests below).
impl SessionsWsState {
    // Registers the connection a sessions_connect creates for `ws_id`.
    // Replacing an existing entry (a second sessions_connect for the same
    // window: a remount, the chat's Reconnect button) closes its outbox,
    // which is exactly the signal the old background task needs to close its
    // socket and stop instead of running alongside the new one -- and moves
    // every frame still waiting in that outbox to the new one, ahead of
    // anything sent later. A frame the webview handed to sessions_send while
    // the socket was down is therefore never dropped by the reconnect that
    // is meant to deliver it (#580 review).
    fn register(&self, ws_id: &str) -> Result<Registered, String> {
        let mut conns = self.connections.lock().map_err(|e| e.to_string())?;
        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst);
        let carried = conns
            .get(ws_id)
            .map(|old| old.outbox.close_and_take())
            .unwrap_or_default();
        let replaced = conns.contains_key(ws_id);
        let outbox = Arc::new(Outbox::with_frames(carried));
        conns.insert(
            ws_id.to_string(),
            Connection {
                outbox: outbox.clone(),
                generation,
            },
        );
        Ok(Registered {
            outbox,
            generation,
            replaced,
        })
    }

    // Removes the window's entry; its outbox closes, which wakes the
    // background task to close the socket and exit for good rather than
    // reconnect. The frames still waiting go with it: a disconnect is the
    // webview saying it wants nothing delivered anymore.
    fn remove(&self, ws_id: &str) {
        if let Ok(mut conns) = self.connections.lock() {
            if let Some(conn) = conns.remove(ws_id) {
                conn.outbox.close();
            }
        }
    }

    fn push(&self, ws_id: &str, frame: String) -> Result<(), String> {
        let conns = self.connections.lock().map_err(|e| e.to_string())?;
        let conn = conns
            .get(ws_id)
            .ok_or_else(|| "sessions_send: not connected".to_string())?;
        conn.outbox.push(frame);
        Ok(())
    }

    fn cancel(&self, ws_id: &str, id: &str) -> Result<(), String> {
        let conns = self.connections.lock().map_err(|e| e.to_string())?;
        if let Some(conn) = conns.get(ws_id) {
            conn.outbox.cancel(id);
        }
        Ok(())
    }

    fn current_generation(&self, ws_id: &str) -> Option<u64> {
        let conns = self.connections.lock().ok()?;
        conns.get(ws_id).map(|c| c.generation)
    }
}

fn is_current_generation(app: &AppHandle, ws_id: &str, generation: u64) -> bool {
    let Some(state) = app.try_state::<SessionsWsState>() else {
        return false;
    };
    state.current_generation(ws_id) == Some(generation)
}

// A loop that a newer sessions_connect or a disconnect superseded says
// nothing more: its `open` or `reconnecting` would land after the new
// loop's own and leave the webview with a status for a socket that is gone.
fn emit_if_current(app: &AppHandle, ws_id: &str, generation: u64, status: &'static str) {
    if is_current_generation(app, ws_id, generation) {
        emit_connection_status(app, ws_id, status);
    }
}

// One connect attempt, bounded by `timeout`. An upgrade that never comes is
// an error like any other, so the loop backs off and tries again.
async fn connect_with_timeout(
    request: tokio_tungstenite::tungstenite::handshake::client::Request,
    timeout: Duration,
) -> Result<WsStream, String> {
    match tokio::time::timeout(timeout, tokio_tungstenite::connect_async(request)).await {
        Ok(Ok((stream, _response))) => Ok(stream),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!("no WebSocket upgrade within {} s", timeout.as_secs())),
    }
}

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn emit_connection_status(app: &AppHandle, ws_id: &str, status: &'static str) {
    let _ = app.emit_to(
        format!("ws:{ws_id}"),
        "session-connection",
        SessionConnectionPayload { status },
    );
}

// A failed command is logged here with the window and the code before it
// goes back to the webview (#590): the webview retries, but the app log is
// where a start-up race between the window and the sidecar shows up.
fn log_command_error(command: &str, window: &tauri::Window, ws_id: Option<&str>, err: &CmdError) {
    warn!(
        "{command}[{}]: window {} failed: {} ({err})",
        ws_id.unwrap_or("-"),
        window.label(),
        err.code()
    );
}

#[tauri::command]
pub(crate) async fn sessions_connect(app: AppHandle, window: tauri::Window) -> Result<(), CmdError> {
    let ws_id = crate::ws_of(&window).inspect_err(|e| log_command_error("sessions_connect", &window, None, e))?;
    connect_for_ws(&app, &ws_id).inspect_err(|e| log_command_error("sessions_connect", &window, Some(&ws_id), e))?;
    info!("sessions_connect[{ws_id}]: window {} connecting", window.label());
    Ok(())
}

fn connect_for_ws(app: &AppHandle, ws_id: &str) -> Result<(), CmdError> {
    let registered = app.state::<SessionsWsState>().register(ws_id)?;
    // The webview hears `reconnecting` for the replaced socket here, before
    // the new loop can say `open`: the old socket's subscriptions are gone
    // with it, and the next `open` is what makes the webview subscribe again.
    // The frames that waited for the old socket are in the new outbox already
    // and go out with that open.
    if registered.replaced {
        emit_connection_status(app, ws_id, "reconnecting");
    }
    tauri::async_runtime::spawn(run_connection_loop(
        app.clone(),
        ws_id.to_string(),
        registered.generation,
        registered.outbox,
    ));
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
        state.remove(ws_id);
    }
    emit_connection_status(app, ws_id, "closed");
}

#[tauri::command]
pub(crate) fn sessions_send(app: AppHandle, window: tauri::Window, frame: String) -> Result<(), CmdError> {
    let ws_id = crate::ws_of(&window).inspect_err(|e| log_command_error("sessions_send", &window, None, e))?;
    push_for_ws(&app, &ws_id, frame).inspect_err(|e| log_command_error("sessions_send", &window, Some(&ws_id), e))
}

fn push_for_ws(app: &AppHandle, ws_id: &str, frame: String) -> Result<(), CmdError> {
    app.state::<SessionsWsState>().push(ws_id, frame)?;
    Ok(())
}

// Takes a frame the webview gave up on out of the outbox, if it is still
// queued (#496).
#[tauri::command]
pub(crate) fn sessions_cancel(app: AppHandle, window: tauri::Window, id: String) -> Result<(), CmdError> {
    let ws_id = crate::ws_of(&window)?;
    app.state::<SessionsWsState>().cancel(&ws_id, &id)?;
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
                warn!(
                    "sessions_connect[{ws_id}]: sidecar not reachable ({}), reconnecting in {backoff_ms} ms: {e}",
                    e.code()
                );
                emit_if_current(&app, &ws_id, generation, "reconnecting");
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

        match connect_with_timeout(request, CONNECT_TIMEOUT).await {
            Ok(mut stream) => {
                if !is_current_generation(&app, &ws_id, generation) {
                    let _ = stream.close(None).await;
                    return;
                }
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
                    info!("sessions_connect[{ws_id}]: closed");
                    return;
                }
                warn!("sessions_connect[{ws_id}]: connection lost, reconnecting in {backoff_ms} ms");
                emit_if_current(&app, &ws_id, generation, "reconnecting");
            }
            Err(e) => {
                warn!("sessions_connect[{ws_id}]: connect failed, reconnecting in {backoff_ms} ms: {e}");
                emit_if_current(&app, &ws_id, generation, "reconnecting");
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
mod connect_timeout_tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;

    // A peer that accepts the TCP connection and never answers the upgrade
    // (#590): each attempt gives up by the timeout, so the loop's next one
    // reaches the listener again.
    #[tokio::test]
    async fn an_upgrade_that_never_comes_fails_by_the_timeout_and_the_next_attempt_connects_again() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (accepted_tx, accepted_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for stream in listener.incoming().take(2).flatten() {
                held.push(stream);
                let _ = accepted_tx.send(());
            }
            // Keep both open, unanswered, until the test is done with them.
            let _ = accepted_tx.send(());
            std::thread::park();
        });

        let url = format!("ws://127.0.0.1:{port}/sessions/ws");
        for _ in 0..2 {
            let started = std::time::Instant::now();
            let request = url.as_str().into_client_request().expect("request");
            let err = connect_with_timeout(request, Duration::from_millis(200))
                .await
                .expect_err("no upgrade, no stream");
            assert!(err.contains("no WebSocket upgrade"), "{err}");
            assert!(started.elapsed() < Duration::from_secs(5));
        }
        accepted_rx.recv().expect("first attempt reached the listener");
        accepted_rx.recv().expect("second attempt reached the listener");
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

    #[test]
    fn close_and_take_leaves_the_outbox_closed_and_empty() {
        let outbox = Outbox::default();
        outbox.push(r#"{"id":"a","type":"message","payload":{}}"#.to_string());
        outbox.push(r#"{"type":"unsubscribe","payload":{}}"#.to_string());
        let taken = outbox.close_and_take();
        assert_eq!(taken.len(), 2);
        assert_eq!(taken[0].0.as_deref(), Some("a"));
        assert!(outbox.is_closed());
        assert!(outbox.pop().is_none(), "the retired loop finds nothing left to write");
    }
}

// The registry a sessions_connect/send/cancel/disconnect goes through,
// exercised without a Tauri runtime: what the webview handed to sessions_send
// survives the sessions_connect that replaces the connection (#580 review).
#[cfg(test)]
mod state_tests {
    use super::*;

    fn frame(id: &str) -> String {
        format!(r#"{{"id":"{id}","type":"message","payload":{{}}}}"#)
    }

    fn ids(outbox: &Outbox) -> Vec<String> {
        let mut out = Vec::new();
        while let Some(f) = outbox.pop() {
            out.push(frame_id(&f).expect("test frames carry an id"));
        }
        out
    }

    #[test]
    fn the_first_connect_for_a_window_replaces_nothing() {
        let state = SessionsWsState::default();
        let first = state.register("w1").expect("register");
        assert!(!first.replaced);
        assert!(!first.outbox.is_closed());
        assert!(first.outbox.pop().is_none());
        assert_eq!(state.current_generation("w1"), Some(first.generation));
    }

    #[test]
    fn a_second_connect_carries_the_waiting_frames_over_in_order_and_retires_the_old_loop() {
        let state = SessionsWsState::default();
        let first = state.register("w1").expect("register");
        state.push("w1", frame("a")).expect("push");
        state.push("w1", frame("b")).expect("push");

        let second = state.register("w1").expect("register again");
        assert!(second.replaced);
        assert!(second.generation > first.generation);
        assert_eq!(state.current_generation("w1"), Some(second.generation));
        // The old loop stops and has nothing left to write.
        assert!(first.outbox.is_closed());
        assert!(first.outbox.pop().is_none());
        // The new loop delivers what waited, then what came after.
        state.push("w1", frame("c")).expect("push");
        assert!(!second.outbox.is_closed());
        assert_eq!(ids(&second.outbox), ["a", "b", "c"]);
    }

    #[test]
    fn a_cancel_after_the_carry_over_takes_the_carried_frame_out() {
        let state = SessionsWsState::default();
        let _first = state.register("w1").expect("register");
        state.push("w1", frame("a")).expect("push");
        state.push("w1", frame("b")).expect("push");
        let second = state.register("w1").expect("register again");
        state.cancel("w1", "a").expect("cancel");
        assert_eq!(ids(&second.outbox), ["b"]);
    }

    #[test]
    fn windows_do_not_share_an_outbox() {
        let state = SessionsWsState::default();
        let w1 = state.register("w1").expect("register");
        let w2 = state.register("w2").expect("register");
        state.push("w1", frame("a")).expect("push");
        let w1_again = state.register("w1").expect("register again");
        assert!(!w2.outbox.is_closed());
        assert!(w2.outbox.pop().is_none());
        assert!(w1.outbox.is_closed());
        assert_eq!(ids(&w1_again.outbox), ["a"]);
    }

    #[test]
    fn a_disconnect_drops_the_entry_and_a_send_after_it_is_refused() {
        let state = SessionsWsState::default();
        let first = state.register("w1").expect("register");
        state.push("w1", frame("a")).expect("push");
        state.remove("w1");
        assert!(first.outbox.is_closed());
        assert_eq!(state.current_generation("w1"), None);
        assert!(state.push("w1", frame("b")).is_err());
        // Cancelling for a window without an entry is a no-op, not an error.
        state.cancel("w1", "a").expect("cancel");
        // A connect after the disconnect starts clean: nothing from before it
        // is delivered.
        let next = state.register("w1").expect("register");
        assert!(!next.replaced);
        assert!(next.outbox.pop().is_none());
        assert!(next.generation > first.generation);
    }
}
