// Typed client for the session live channel (#341,
// docs/superpowers/specs/2026-09-12-runner-and-session-design.md, "Model:
// Live channel; Desktop"). Two transports behind the same interface:
//
// - Tauri mode: the webview never opens the socket itself (security rule
//   3, root CLAUDE.md) -- it invokes `sessions_connect`/`sessions_send`/
//   `sessions_disconnect` (apps/desktop/src/sessions_ws.rs) and listens
//   for the `session-event`/`session-connection` window events those
//   commands re-emit. Reconnect-with-backoff of the socket lives in Rust;
//   a command that fails (the window and the sidecar racing at start-up,
//   #590) is retried here with the same backoff, never dropped.
// - Browser/Vite dev mode: opens a real WebSocket directly against the
//   `/api` dev proxy (ws: true, vite.config.ts), which injects the bearer
//   server-side on the upgrade request the same way it already does for
//   ordinary REST calls -- the token never reaches this module. Reconnect-
//   with-backoff is implemented here in TS since there is no Rust bridge
//   in this mode.
//
// Frame shapes mirror apps/server/api/sessions-ws.ts exactly (client:
// subscribe/unsubscribe/message/answer/interrupt/continue/close; server:
// reply/error/event/delta/session_state) -- see that file's own header
// comment for the canonical protocol description.

import { isTauri } from "./backend-url.js";
import { ApiError, ClientError } from "./api-error.js";
import { requestLocale } from "./locale.js";
import type { Locale } from "../../../server/shared/i18n/config";
import type { ErrorParams } from "../../../server/shared/error-codes";
import type { SessionSummary, SessionRunRow } from "../types";
import type { QuestionAnswer } from "./session-chat.js";
import { invoke } from "./tauri-invoke.js";

export type SessionState = "running" | "suspended" | "closed" | "archived";
export type ConnectionStatus = "open" | "reconnecting" | "closed";

export interface CanonicalEventEnvelope {
  kind: string;
  payload: unknown;
  seq: number;
}

export interface SessionDeltaMessage {
  session_id: string;
  run_id: string;
  channel: "text" | "reasoning";
  text: string;
}

export interface SessionStateMessage {
  session_id: string;
  state: SessionState;
  waiting_since: string | null;
  node_id: string | null;
  // The row's current name -- carried so a rename anywhere (Relace tab,
  // chat header, another window) lands in every list without a refetch.
  // Optional only for a server older than this field.
  name?: string;
}

interface ReplyFrame {
  id?: string;
  type: "reply";
  payload: unknown;
}
interface ErrorFrame {
  id?: string;
  type: "error";
  payload: { code: string; message: string; params?: ErrorParams };
}
interface EventFrame {
  type: "event";
  payload: { session_id: string; event: CanonicalEventEnvelope };
}
// A page of the persisted log a subscribe replays, in seq order.
interface EventsFrame {
  type: "events";
  payload: { session_id: string; events: CanonicalEventEnvelope[] };
}
interface DeltaFrame {
  type: "delta";
  payload: SessionDeltaMessage;
}
interface SessionStateFrame {
  type: "session_state";
  payload: SessionStateMessage;
}
// The snapshot sent once on connect: every running or suspended session the
// caller can see, in one frame.
interface SessionStatesFrame {
  type: "session_states";
  payload: { sessions: SessionStateMessage[] };
}
type ServerFrame =
  | ReplyFrame
  | ErrorFrame
  | EventFrame
  | EventsFrame
  | DeltaFrame
  | SessionStateFrame
  | SessionStatesFrame;

type ClientFrame =
  | { id: string; type: "subscribe"; payload: { session_id: string; after?: number } }
  | { id: string; type: "unsubscribe"; payload: { session_id: string } }
  | { id: string; type: "message"; payload: { session_id: string; text: string; locale?: Locale } }
  | {
      id: string;
      type: "answer";
      payload: { session_id: string; request_id: string; decision: { value: QuestionAnswer } };
    }
  | { id: string; type: "interrupt"; payload: { session_id: string } }
  | { id: string; type: "continue"; payload: { session_id: string; locale?: Locale } }
  | { id: string; type: "close"; payload: { session_id: string } };

// 1s -> 30s, doubling, same schedule as the Rust bridge's own
// next_backoff_ms (apps/desktop/src/sessions_ws.rs) -- kept in sync
// deliberately so a user sees the same reconnect cadence regardless of
// which transport is live.
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// A socket that never leaves CONNECTING within this is abandoned and
// retried (see DirectWsTransportOptions.connectTimeoutMs).
const CONNECT_TIMEOUT_MS = 10_000;
// How long a request frame waits for its own reply before rejecting.
const REQUEST_TIMEOUT_MS = 30_000;

export function nextBackoffMs(currentMs: number): number {
  return Math.min(currentMs * 2, MAX_BACKOFF_MS);
}

function randomFrameId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Why the channel is not open, when the transport knows: the rejection of
// the Tauri command that failed (a DesktopError), else undefined.
export type ConnectionError = unknown;

// A transport's listener registry: `add` returns its own removal.
function listeners<A extends unknown[]>() {
  const set = new Set<(...args: A) => void>();
  return {
    add(cb: (...args: A) => void): () => void {
      set.add(cb);
      return () => set.delete(cb);
    },
    emit(...args: A): void {
      for (const cb of set) cb(...args);
    },
  };
}

export interface Transport {
  send(frame: ClientFrame): void;
  // Drops a frame that is still queued for the next open (the socket was
  // not open when it was sent). A frame already on the wire is out of
  // reach; cancelling it is a no-op. The client cancels every request it
  // reports as failed, so a failed request is never delivered later.
  cancel(id: string): void;
  onFrame(cb: (frame: ServerFrame) => void): () => void;
  onStatus(cb: (status: ConnectionStatus, error?: ConnectionError) => void): () => void;
  connect(): void;
  // Retries now instead of waiting out the backoff (the chat's Reconnect
  // button). A no-op while disconnected or open.
  reconnect(): void;
  disconnect(): void;
}

export interface DirectWsTransportOptions {
  // Overridable purely for test/sessions-client.test.ts, so a reconnect
  // scenario doesn't have to wait out a real 1s-30s schedule.
  minBackoffMs?: number;
  maxBackoffMs?: number;
  // The WebSocket constructor to use; defaults to the global one. The
  // server-side test runner passes the `ws` package's class instead.
  WebSocket?: WebSocketLike;
  // How long a socket may sit in CONNECTING before this transport gives up
  // on it and schedules a reconnect. A TCP connect to a host that accepts
  // the packet but never completes the upgrade (a sidecar mid-restart, a
  // laptop that just woke) otherwise leaves the transport "reconnecting"
  // forever with no further attempt, since onclose never fires.
  connectTimeoutMs?: number;
}

// The subset of the WHATWG WebSocket surface this transport uses; the `ws`
// package's class satisfies it too.
export interface WebSocketLike {
  new (url: string): WebSocketInstance;
  readonly OPEN: number;
}
export interface WebSocketInstance {
  readyState: number;
  send(data: string): void;
  close(): void;
  // `ws`'s own hard close (no handshake); absent on the browser class, in
  // which case close() is all there is.
  terminate?: () => void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

// Browser/Vite dev-mode transport: a real WebSocket with its own
// reconnect-with-backoff loop (no Rust host in this mode to do it).
// Exported (not just used internally) so test/sessions-client.test.ts can
// point one at a fake `ws` server's own address instead of the real dev
// proxy URL.
export function createDirectWsTransport(url: string, options: DirectWsTransportOptions = {}): Transport {
  const minBackoffMs = options.minBackoffMs ?? MIN_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;
  const WebSocketCtor: WebSocketLike = options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketLike);
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const frameListeners = listeners<[ServerFrame]>();
  const statusListeners = listeners<[ConnectionStatus]>();
  let socket: WebSocketInstance | null = null;
  let backoffMs = minBackoffMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // A caller (createSessionsClient's own subscribe/message/etc.) can send
  // before the just-opened socket finishes its handshake -- WebSocket's
  // own `send()` throws in CONNECTING state, and this is the common case
  // right after `connect()`, not a rare race. Queued here and flushed in
  // FIFO order once onopen fires; `cancel(id)` takes one back out.
  const sendQueue: Array<{ id: string; text: string }> = [];

  const emitStatus = statusListeners.emit;

  // Detaches every handler and hard-closes a socket this transport is done
  // with, so a late handshake or close event from it can never re-enter the
  // reconnect loop (or, in a test process, keep a half-open connect handle
  // alive after the last assertion).
  function abandon(ws: WebSocketInstance): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      if (ws.terminate) ws.terminate();
      else ws.close();
    } catch {
      // Already closing/closed -- nothing left to do.
    }
  }

  function clearConnectTimer(): void {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    emitStatus("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      open();
    }, backoffMs);
  }

  function open(): void {
    if (stopped) return;
    const ws = new WebSocketCtor(url);
    socket = ws;
    connectTimer = setTimeout(() => {
      if (socket !== ws) return;
      socket = null;
      abandon(ws);
      scheduleReconnect();
    }, connectTimeoutMs);
    ws.onopen = () => {
      clearConnectTimer();
      backoffMs = minBackoffMs;
      while (sendQueue.length > 0 && socket === ws) {
        ws.send((sendQueue.shift() as { text: string }).text);
      }
      emitStatus("open");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const frame = JSON.parse(ev.data) as ServerFrame;
        frameListeners.emit(frame);
      } catch {
        // Malformed frame -- drop it, matching the server's own
        // safeParse-fails-silently behavior for client->server frames.
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      clearConnectTimer();
      socket = null;
      scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose always follows onerror for a WebSocket; nothing extra to
      // do here beyond letting onclose's own reconnect scheduling run.
    };
  }

  return {
    send(frame) {
      const text = JSON.stringify(frame);
      if (socket?.readyState === WebSocketCtor.OPEN) {
        socket.send(text);
      } else {
        sendQueue.push({ id: frame.id, text });
      }
    },
    cancel(id) {
      const index = sendQueue.findIndex((queued) => queued.id === id);
      if (index !== -1) sendQueue.splice(index, 1);
    },
    onFrame: frameListeners.add,
    onStatus: statusListeners.add,
    connect() {
      stopped = false;
      open();
    },
    reconnect() {
      if (stopped || socket?.readyState === WebSocketCtor.OPEN) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearConnectTimer();
      if (socket) abandon(socket);
      socket = null;
      backoffMs = minBackoffMs;
      open();
    },
    disconnect() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearConnectTimer();
      sendQueue.length = 0;
      if (socket) abandon(socket);
      socket = null;
      emitStatus("closed");
    },
  };
}

// Tauri transport: sessions_connect/sessions_send/sessions_disconnect plus
// the session-event/session-connection window events those commands
// re-emit (apps/desktop/src/sessions_ws.rs). Rust reconnects the socket;
// this side owns the commands themselves (#590). A command can fail -- the
// window asking before the shell knows it (DESKTOP_NOT_WORKSPACE_WINDOW,
// config not readable yet), or sessions_send finding no connection -- and a
// failure swallowed here left the client believing it was connected, every
// subscribe gone and the chat loading forever. So a failure is logged, the
// status goes to `reconnecting` with the error as its reason, and
// sessions_connect is retried with backoff until it succeeds. A frame whose
// sessions_send failed waits in `held` for that success (the client cancels
// one it reports as failed -- before or after the failure arrives -- and
// resubscribes on the next open). A send that
// fails while a sessions_connect is in flight waits for that attempt rather
// than starting another: every sessions_connect replaces Rust's socket, so
// a second one would drop the socket the first just opened.
export interface TauriTransportDeps {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen?: <T>(event: string, cb: (ev: { payload: T }) => void) => Promise<() => void>;
  // Overridable for test/sessions-client.test.ts.
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export function createTauriTransport(deps: TauriTransportDeps = {}): Transport {
  const call = deps.invoke ?? invoke;
  const minBackoffMs = deps.minBackoffMs ?? MIN_BACKOFF_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? MAX_BACKOFF_MS;
  const frameListeners = listeners<[ServerFrame]>();
  const statusListeners = listeners<[ConnectionStatus, ConnectionError?]>();
  let unlisten: (() => void) | null = null;
  // Bumped by connect and disconnect: an attempt started for an earlier
  // connect (React StrictMode mounts, connects, disconnects and connects
  // again) finds itself superseded and leaves nothing behind -- no second
  // pair of listeners, no retry.
  let generation = 0;
  let stopped = true;
  let backoffMs = minBackoffMs;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const held: Array<{ id: string; text: string }> = [];
  // Frame ids whose sessions_send is awaiting its answer. A cancel removes
  // the id, so a rejection that arrives for a frame the client already
  // settled (the first failed send took the channel down and the client
  // reported every request lost) drops the frame instead of holding it: a
  // frame held past its own failure report is delivered by the next open,
  // and the user's resend then executes the action twice.
  const inFlight = new Set<string>();
  // A sessions_connect is awaiting its answer; it flushes `held` when it
  // succeeds.
  let connecting = false;
  // Bumped on every sessions_connect that succeeded: a send that failed
  // before the latest one was asked for an outbox that exists now.
  let connectEpoch = 0;
  let lastStatus: ConnectionStatus = "closed";

  const emitStatus = statusListeners.emit;

  function fail(command: string, error: unknown): void {
    console.warn(`[portuni:sessions-ws] ${command} failed, retrying in ${backoffMs} ms`, error);
    lastStatus = "reconnecting";
    emitStatus("reconnecting", error);
    scheduleRetry();
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    const gen = generation;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attempt(gen);
    }, delay);
  }

  async function listenOnce(gen: number): Promise<boolean> {
    if (unlisten) return true;
    const listen = deps.listen ?? (await import("@tauri-apps/api/event")).listen;
    const offEvent = await listen<{ frame: ServerFrame }>("session-event", (ev) => {
      frameListeners.emit(ev.payload.frame);
    });
    const offStatus = await listen<{ status: ConnectionStatus }>("session-connection", (ev) => {
      if (ev.payload.status === "open") backoffMs = minBackoffMs;
      lastStatus = ev.payload.status;
      emitStatus(ev.payload.status);
    });
    if (gen !== generation || unlisten) {
      offEvent();
      offStatus();
      return gen === generation;
    }
    unlisten = () => {
      offEvent();
      offStatus();
    };
    return true;
  }

  async function attempt(gen: number): Promise<void> {
    if (stopped || gen !== generation) return;
    connecting = true;
    try {
      if (!(await listenOnce(gen))) return;
      await call("sessions_connect");
    } catch (err) {
      if (gen === generation) fail("sessions_connect", err);
      return;
    } finally {
      if (gen === generation) connecting = false;
    }
    if (gen !== generation) return;
    connectEpoch += 1;
    // Rust holds a live outbox again: hand it what a failed send left
    // behind, in order.
    for (const entry of held.splice(0)) sendNow(entry);
  }

  function sendNow(entry: { id: string; text: string }): void {
    const epoch = connectEpoch;
    inFlight.add(entry.id);
    call("sessions_send", { frame: entry.text }).then(
      () => {
        inFlight.delete(entry.id);
      },
      (err: unknown) => {
        // Cancelled while in flight: the client settled this request already
        // and nothing of it may reach the server later.
        const wanted = inFlight.delete(entry.id);
        if (stopped) return;
        if (wanted && connectEpoch !== epoch) {
          // A sessions_connect succeeded after this send was asked for: its
          // outbox takes the frame.
          sendNow(entry);
          return;
        }
        if (wanted) held.push(entry);
        if (connecting) return;
        fail("sessions_send", err);
      },
    );
  }

  return {
    send(frame) {
      sendNow({ id: frame.id, text: JSON.stringify(frame) });
    },
    cancel(id) {
      inFlight.delete(id);
      const index = held.findIndex((entry) => entry.id === id);
      if (index !== -1) held.splice(index, 1);
      // Same import-then-invoke chain as send (lib/tauri-invoke.ts awaits one
      // shared module promise), so a cancel issued after a send reaches Rust
      // after it: both continuations run in order. With no connection there
      // is nothing queued in Rust to take back.
      call("sessions_cancel", { id }).catch(() => undefined);
    },
    onFrame: frameListeners.add,
    onStatus: statusListeners.add,
    connect() {
      stopped = false;
      generation += 1;
      backoffMs = minBackoffMs;
      void attempt(generation);
    },
    reconnect() {
      // Rust replaces the socket on every sessions_connect: one while open
      // would drop a live channel, one in flight would drop the next.
      if (stopped || lastStatus === "open" || connecting) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      backoffMs = minBackoffMs;
      // A fresh sessions_connect replaces Rust's loop too, so a socket
      // sleeping out a 30 s backoff there tries again now.
      void attempt(generation);
    },
    disconnect() {
      stopped = true;
      generation += 1;
      connecting = false;
      lastStatus = "closed";
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      held.length = 0;
      inFlight.clear();
      unlisten?.();
      unlisten = null;
      call("sessions_disconnect").catch(() => undefined);
      emitStatus("closed");
    },
  };
}

export interface SessionsClient {
  subscribe(sessionId: string, afterSeq?: number): Promise<void>;
  unsubscribe(sessionId: string): void;
  message(sessionId: string, text: string): Promise<void>;
  answer(sessionId: string, requestId: string, value: QuestionAnswer): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  // #378: "Pokračovat v nové session" / "Navázat" -- closes this session and
  // starts a fresh, running one on the same node, carrying its summary as
  // orientation. Returns the new session so the caller can switch the
  // active thread to it without a second round trip.
  continueSession(sessionId: string): Promise<{ session: SessionSummary; run: SessionRunRow }>;
  close(sessionId: string): Promise<void>;
  // Persisted events, a batch per frame in seq order: a replay page arrives
  // as one call, a live event as a call with one.
  onEvents(sessionId: string, cb: (events: CanonicalEventEnvelope[]) => void): () => void;
  onDelta(sessionId: string, cb: (delta: SessionDeltaMessage) => void): () => void;
  // Live session states, a batch per frame: the snapshot on connect arrives
  // as one call with every session, a later change as a call with one.
  onSessionStates(cb: (states: SessionStateMessage[]) => void): () => void;
  // Every status change of the live channel, with the reason it is not
  // open when the transport knows one (#590).
  onConnectionStatus(cb: (status: ConnectionStatus, error?: ConnectionError) => void): () => void;
  // The status now and since when (ms epoch), for a view mounted after the
  // last change. `reconnecting` from connect() until the first open.
  connectionState(): { status: ConnectionStatus; error: ConnectionError; since: number };
  // Retries the connection now instead of waiting out the backoff.
  reconnect(): void;
  // Opens the transport (a no-op while already connected). Called for you
  // unless the client was created with `autoConnect: false`.
  connect(): void;
  disconnect(): void;
}

// Default dev-mode target: the same /api prefix apiFetch uses for REST,
// proxied with ws: true (vite.config.ts) -- ws:// (not wss://) since the
// dev server is always plain HTTP.
function defaultDevWsUrl(): string {
  const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
  const host = typeof location !== "undefined" ? location.host : "localhost:4010";
  return `${proto}//${host}/api/sessions/ws`;
}

export interface CreateSessionsClientOptions {
  // Override the transport entirely -- test/sessions-client.test.ts uses
  // this to point a direct-WS transport at a fake `ws` server instead of
  // the real dev proxy.
  transport?: Transport;
  // false: the caller connects itself (App.tsx does so from an effect with
  // a disconnect cleanup, so React StrictMode's double mount opens exactly
  // one live transport instead of leaking the first).
  autoConnect?: boolean;
}

// #496: requests that must not be reported as failed while the server may
// still carry them out -- a resend of either repeats the action.
const SETTLED_BY_REPLY_ON_WIRE: ReadonlySet<ClientFrame["type"]> = new Set(["message", "continue"]);

interface PendingRequest {
  type: ClientFrame["type"];
  sessionId: string;
  // Null once the frame is on the wire for a request settled by its reply
  // or the connection dropping (SETTLED_BY_REPLY_ON_WIRE).
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

// A subscribe waiting for an open connection: its callers, and the `after`
// the first of them asked for.
interface ParkedSubscribe {
  after: number | undefined;
  waiters: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }>;
}

export function createSessionsClient(options: CreateSessionsClientOptions = {}): SessionsClient {
  const transport = options.transport ?? (isTauri() ? createTauriTransport() : createDirectWsTransport(defaultDevWsUrl()));

  const eventListeners = new Map<string, Set<(events: CanonicalEventEnvelope[]) => void>>();
  const deltaListeners = new Map<string, Set<(delta: SessionDeltaMessage) => void>>();
  const sessionStateListeners = new Set<(states: SessionStateMessage[]) => void>();
  const connectionStatusListeners = new Set<(status: ConnectionStatus, error?: ConnectionError) => void>();
  let connectionState: { status: ConnectionStatus; error: ConnectionError; since: number } = {
    status: "closed",
    error: undefined,
    since: Date.now(),
  };
  const pendingReplies = new Map<string, PendingRequest>();
  // The subscribed set, and the highest seq observed per session -- what a
  // reconnect resubscribes with. Deltas never touch this (they carry no
  // seq and are not part of the persisted, replayable event log).
  const subscribedSessions = new Set<string>();
  const lastSeq = new Map<string, number>();
  let isOpen = false;

  // #496: a request is delivered once, or reported as failed and never sent
  // afterwards. Every request frame carries an id the server echoes on its
  // reply, and the caller awaits that reply (the composer stays disabled
  // until `message()` resolves).
  // - An unanswered request rejects after REQUEST_TIMEOUT_MS, and its frame
  //   is cancelled out of the transport's queue: a frame that waited out a
  //   reconnect is never delivered after the caller was told it failed, so
  //   sending the text again cannot reach the agent twice.
  // - When an open connection drops, every request already sent rejects at
  //   once: its reply cannot arrive on the next connection. A request sent
  //   while the connection is down stays queued for the next open (or its
  //   timeout).
  // - A subscribe is the exception: it never goes out while the connection
  //   is down, never times out while waiting for it, and survives a drop.
  //   Each open (the first one included) sends one subscribe per wanted
  //   session and settles every caller waiting on it (`parkedSubscribes`),
  //   so a load that finishes after a reconnect shows no error.
  // - A message or a Pokračovat v nové session that is on the wire (sent on
  //   an open connection, or flushed by the open that followed) has no
  //   timeout: the server may legitimately take longer than
  //   REQUEST_TIMEOUT_MS (a start waiting for the lifecycle lock, a
  //   redelivery waiting for a run to end), and a failure reported while
  //   the server still delivers it is what makes a resend reach the agent
  //   twice. Its reply or the connection dropping settles it.
  // - `disconnect()` rejects everything still outstanding.
  const parkedSubscribes = new Map<string, ParkedSubscribe>();

  function armTimeout(id: string, type: ClientFrame["type"], reject: (e: Error) => void) {
    return setTimeout(() => {
      pendingReplies.delete(id);
      transport.cancel(id);
      reject(new ClientError("REQUEST_TIMEOUT", `request_timeout: ${type} got no reply within ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);
  }

  function send<T>(frame: Omit<ClientFrame, "id">): Promise<T> {
    const id = randomFrameId();
    const full = { ...frame, id } as ClientFrame;
    const sessionId = (frame.payload as { session_id: string }).session_id;
    return new Promise<T>((resolve, reject) => {
      const onWireSettlesByReply = isOpen && SETTLED_BY_REPLY_ON_WIRE.has(frame.type);
      const pending: PendingRequest = {
        type: frame.type,
        sessionId,
        timer: onWireSettlesByReply ? null : armTimeout(id, frame.type, reject),
        resolve: (v) => {
          if (pending.timer) clearTimeout(pending.timer);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e) => {
          if (pending.timer) clearTimeout(pending.timer);
          reject(e);
        },
      };
      pendingReplies.set(id, pending);
      transport.send(full);
    });
  }

  function park(sessionId: string, after: number | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let parked = parkedSubscribes.get(sessionId);
      if (!parked) {
        parked = { after, waiters: [] };
        parkedSubscribes.set(sessionId, parked);
      }
      parked.waiters.push({ resolve: resolve as (v: unknown) => void, reject });
    });
  }

  function sendSubscribe(sessionId: string, after: number | undefined): Promise<void> {
    return send<void>({ type: "subscribe", payload: { session_id: sessionId, after } });
  }

  // The open connection went away: sent requests fail now, sent subscribes
  // wait for the next open instead.
  function onConnectionLost(): void {
    for (const [id, pending] of pendingReplies) {
      pendingReplies.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      transport.cancel(id);
      if (pending.type === "subscribe" && subscribedSessions.has(pending.sessionId)) {
        void park(pending.sessionId, lastSeq.get(pending.sessionId)).then(pending.resolve, pending.reject);
      } else {
        pending.reject(new ClientError("DISCONNECTED", `disconnected: the session channel dropped before the ${pending.type} reply arrived`));
      }
    }
  }

  // Each open subscribes every wanted session once: the first open carries
  // the subscribes made while connecting, a reconnect resubscribes with the
  // last seq this client itself observed, so nothing is re-delivered and
  // nothing is missed -- the server's own replay (sessions-ws.ts) fills
  // exactly that gap.
  function onConnectionOpened(): void {
    // The open flushed every queued frame: a message or a continue waiting
    // in the queue is on the wire now and waits for its reply instead.
    for (const pending of pendingReplies.values()) {
      if (pending.timer && SETTLED_BY_REPLY_ON_WIRE.has(pending.type)) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
    }
    for (const sessionId of subscribedSessions) {
      const parked = parkedSubscribes.get(sessionId);
      parkedSubscribes.delete(sessionId);
      const after = lastSeq.get(sessionId) ?? parked?.after;
      // Nobody but the parked callers awaits a resubscribe, so its rejection
      // is swallowed when there are none: a disconnect() before the reply
      // rejects every outstanding request, and an unhandled one of those
      // crashes the webview's own error reporting.
      sendSubscribe(sessionId, after).then(
        () => {
          for (const w of parked?.waiters ?? []) w.resolve(undefined);
        },
        (e: Error) => {
          for (const w of parked?.waiters ?? []) w.reject(e);
        },
      );
    }
  }

  function rejectAllPending(reason: string): void {
    for (const [, pending] of pendingReplies) pending.reject(new ClientError("DISCONNECTED", reason));
    pendingReplies.clear();
    for (const [, parked] of parkedSubscribes) {
      for (const w of parked.waiters) w.reject(new ClientError("DISCONNECTED", reason));
    }
    parkedSubscribes.clear();
  }

  transport.onFrame((frame) => {
    if (frame.type === "reply" || frame.type === "error") {
      if (!frame.id) return;
      const pending = pendingReplies.get(frame.id);
      if (!pending) return;
      pendingReplies.delete(frame.id);
      if (frame.type === "error") {
        const { code, message, params } = frame.payload;
        pending.reject(new ApiError(0, code, `${code}: ${message}`, params ?? {}));
      } else {
        pending.resolve(frame.payload);
      }
      return;
    }
    if (frame.type === "event") {
      const { session_id, event } = frame.payload;
      lastSeq.set(session_id, event.seq);
      for (const cb of eventListeners.get(session_id) ?? []) cb([event]);
      return;
    }
    if (frame.type === "events") {
      const { session_id, events } = frame.payload;
      if (events.length === 0) return;
      lastSeq.set(session_id, events[events.length - 1].seq);
      for (const cb of eventListeners.get(session_id) ?? []) cb(events);
      return;
    }
    if (frame.type === "delta") {
      // Never stored/tracked -- streamed text only, not part of the
      // replayable log (session-runtime.ts never persists a delta either).
      for (const cb of deltaListeners.get(frame.payload.session_id) ?? []) cb(frame.payload);
      return;
    }
    if (frame.type === "session_state") {
      for (const cb of sessionStateListeners) cb([frame.payload]);
      return;
    }
    if (frame.type === "session_states") {
      for (const cb of sessionStateListeners) cb(frame.payload.sessions);
    }
  });

  function onStatus(status: ConnectionStatus, error?: ConnectionError): void {
    const previous = connectionState;
    connectionState = {
      status,
      // Rust's own reconnecting carries no reason: the last known one stays.
      error: status === "open" ? undefined : (error ?? (previous.status === "open" ? undefined : previous.error)),
      since: status === previous.status ? previous.since : Date.now(),
    };
    for (const cb of connectionStatusListeners) cb(status, connectionState.error);
    if (status === "open") {
      // An open while open is a new socket (the Tauri host replaced its
      // connection): the old one took its subscriptions and its unanswered
      // requests with it.
      if (isOpen) onConnectionLost();
      isOpen = true;
      onConnectionOpened();
    } else if (isOpen) {
      isOpen = false;
      onConnectionLost();
    }
  }
  transport.onStatus(onStatus);

  let connected = false;
  function connect(): void {
    if (connected) return;
    connected = true;
    onStatus("reconnecting");
    transport.connect();
  }
  if (options.autoConnect !== false) connect();

  return {
    connect,
    async subscribe(sessionId, afterSeq) {
      subscribedSessions.add(sessionId);
      const after = afterSeq ?? lastSeq.get(sessionId);
      if (!isOpen) return park(sessionId, after);
      await sendSubscribe(sessionId, after);
    },
    unsubscribe(sessionId) {
      subscribedSessions.delete(sessionId);
      lastSeq.delete(sessionId);
      // Nothing left to load for a caller still waiting on the open.
      const parked = parkedSubscribes.get(sessionId);
      parkedSubscribes.delete(sessionId);
      for (const w of parked?.waiters ?? []) w.resolve(undefined);
      transport.send({ id: randomFrameId(), type: "unsubscribe", payload: { session_id: sessionId } });
    },
    async message(sessionId, text) {
      await send({ type: "message", payload: { session_id: sessionId, text, locale: requestLocale() } });
    },
    async answer(sessionId, requestId, value) {
      await send({
        type: "answer",
        payload: { session_id: sessionId, request_id: requestId, decision: { value } },
      });
    },
    async interrupt(sessionId) {
      await send({ type: "interrupt", payload: { session_id: sessionId } });
    },
    async continueSession(sessionId) {
      return send<{ session: SessionSummary; run: SessionRunRow }>({
        type: "continue",
        payload: { session_id: sessionId, locale: requestLocale() },
      });
    },
    async close(sessionId) {
      await send({ type: "close", payload: { session_id: sessionId } });
    },
    onEvents(sessionId, cb) {
      let set = eventListeners.get(sessionId);
      if (!set) {
        set = new Set();
        eventListeners.set(sessionId, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    onDelta(sessionId, cb) {
      let set = deltaListeners.get(sessionId);
      if (!set) {
        set = new Set();
        deltaListeners.set(sessionId, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    onSessionStates(cb) {
      sessionStateListeners.add(cb);
      return () => sessionStateListeners.delete(cb);
    },
    onConnectionStatus(cb) {
      connectionStatusListeners.add(cb);
      return () => connectionStatusListeners.delete(cb);
    },
    connectionState() {
      return connectionState;
    },
    reconnect() {
      if (connected) transport.reconnect();
    },
    disconnect() {
      connected = false;
      isOpen = false;
      rejectAllPending("disconnected: the session channel was closed before the reply arrived");
      transport.disconnect();
    },
  };
}
