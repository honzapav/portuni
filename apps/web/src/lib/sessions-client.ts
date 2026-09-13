// Typed client for the session live channel (#341,
// docs/superpowers/specs/2026-09-12-runner-and-session-design.md, "Model:
// Live channel; Desktop"). Two transports behind the same interface:
//
// - Tauri mode: the webview never opens the socket itself (security rule
//   3, root CLAUDE.md) -- it invokes `sessions_connect`/`sessions_send`/
//   `sessions_disconnect` (apps/desktop/src/sessions_ws.rs) and listens
//   for the `session-event`/`session-connection` window events those
//   commands re-emit. Reconnect-with-backoff lives in Rust.
// - Browser/Vite dev mode: opens a real WebSocket directly against the
//   `/api` dev proxy (ws: true, vite.config.ts), which injects the bearer
//   server-side on the upgrade request the same way it already does for
//   ordinary REST calls -- the token never reaches this module. Reconnect-
//   with-backoff is implemented here in TS since there is no Rust bridge
//   in this mode.
//
// Frame shapes mirror apps/server/api/sessions-ws.ts exactly (client:
// subscribe/unsubscribe/message/answer/interrupt/suspend/close; server:
// reply/error/event/delta/session_state) -- see that file's own header
// comment for the canonical protocol description.

import { isTauri } from "./backend-url.js";

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
  text: string;
}

export interface SessionStateMessage {
  session_id: string;
  state: SessionState;
  waiting_since: string | null;
  node_id: string | null;
}

interface ReplyFrame {
  id?: string;
  type: "reply";
  payload: unknown;
}
interface ErrorFrame {
  id?: string;
  type: "error";
  payload: { code: string; message: string };
}
interface EventFrame {
  type: "event";
  payload: { session_id: string; event: CanonicalEventEnvelope };
}
interface DeltaFrame {
  type: "delta";
  payload: SessionDeltaMessage;
}
interface SessionStateFrame {
  type: "session_state";
  payload: SessionStateMessage;
}
type ServerFrame = ReplyFrame | ErrorFrame | EventFrame | DeltaFrame | SessionStateFrame;

type ClientFrame =
  | { id: string; type: "subscribe"; payload: { session_id: string; after?: number } }
  | { id: string; type: "unsubscribe"; payload: { session_id: string } }
  | { id: string; type: "message"; payload: { session_id: string; text: string } }
  | {
      id: string;
      type: "answer";
      payload: { session_id: string; request_id: string; decision: { value: string | boolean } };
    }
  | { id: string; type: "interrupt"; payload: { session_id: string } }
  | { id: string; type: "suspend"; payload: { session_id: string } }
  | { id: string; type: "close"; payload: { session_id: string } };

// 1s -> 30s, doubling, same schedule as the Rust bridge's own
// next_backoff_ms (apps/desktop/src/sessions_ws.rs) -- kept in sync
// deliberately so a user sees the same reconnect cadence regardless of
// which transport is live.
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function nextBackoffMs(currentMs: number): number {
  return Math.min(currentMs * 2, MAX_BACKOFF_MS);
}

function randomFrameId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface Transport {
  send(frame: ClientFrame): void;
  onFrame(cb: (frame: ServerFrame) => void): () => void;
  onStatus(cb: (status: ConnectionStatus) => void): () => void;
  connect(): void;
  disconnect(): void;
}

export interface DirectWsTransportOptions {
  // Overridable purely for test/sessions-client.test.ts, so a reconnect
  // scenario doesn't have to wait out a real 1s-30s schedule.
  minBackoffMs?: number;
  maxBackoffMs?: number;
  // The WebSocket constructor to use; defaults to the global one. The
  // server-side test runner (CI is Node 20, which has no global WebSocket)
  // passes the `ws` package's class instead.
  WebSocket?: WebSocketLike;
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
  const frameListeners = new Set<(frame: ServerFrame) => void>();
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  let socket: WebSocketInstance | null = null;
  let backoffMs = minBackoffMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // A caller (createSessionsClient's own subscribe/message/etc.) can send
  // before the just-opened socket finishes its handshake -- WebSocket's
  // own `send()` throws in CONNECTING state, and this is the common case
  // right after `connect()`, not a rare race. Queued here and flushed in
  // FIFO order once onopen fires.
  const sendQueue: string[] = [];

  function emitStatus(status: ConnectionStatus): void {
    for (const cb of statusListeners) cb(status);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    emitStatus("reconnecting");
    reconnectTimer = setTimeout(() => {
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      open();
    }, backoffMs);
  }

  function open(): void {
    if (stopped) return;
    const ws = new WebSocketCtor(url);
    socket = ws;
    ws.onopen = () => {
      backoffMs = minBackoffMs;
      while (sendQueue.length > 0 && socket === ws) {
        ws.send(sendQueue.shift() as string);
      }
      emitStatus("open");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const frame = JSON.parse(ev.data) as ServerFrame;
        for (const cb of frameListeners) cb(frame);
      } catch {
        // Malformed frame -- drop it, matching the server's own
        // safeParse-fails-silently behavior for client->server frames.
      }
    };
    ws.onclose = () => {
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
        sendQueue.push(text);
      }
    },
    onFrame(cb) {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    connect() {
      stopped = false;
      open();
    },
    disconnect() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      sendQueue.length = 0;
      socket?.close();
      socket = null;
      emitStatus("closed");
    },
  };
}

// Tauri transport: sessions_connect/sessions_send/sessions_disconnect plus
// the session-event/session-connection window events those commands
// re-emit (apps/desktop/src/sessions_ws.rs). Reconnect-with-backoff lives
// entirely in Rust; this side just relays.
function createTauriTransport(): Transport {
  const frameListeners = new Set<(frame: ServerFrame) => void>();
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  let unlistenEvent: (() => void) | null = null;
  let unlistenStatus: (() => void) | null = null;

  return {
    send(frame) {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("sessions_send", { frame: JSON.stringify(frame) }),
      );
    },
    onFrame(cb) {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    connect() {
      void (async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        const { listen } = await import("@tauri-apps/api/event");
        unlistenEvent = await listen<{ frame: ServerFrame }>("session-event", (ev) => {
          for (const cb of frameListeners) cb(ev.payload.frame);
        });
        unlistenStatus = await listen<{ status: ConnectionStatus }>("session-connection", (ev) => {
          for (const cb of statusListeners) cb(ev.payload.status);
        });
        await invoke("sessions_connect");
      })();
    },
    disconnect() {
      unlistenEvent?.();
      unlistenStatus?.();
      unlistenEvent = null;
      unlistenStatus = null;
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("sessions_disconnect"));
    },
  };
}

export interface SessionsClient {
  subscribe(sessionId: string, afterSeq?: number): Promise<void>;
  unsubscribe(sessionId: string): void;
  message(sessionId: string, text: string): Promise<void>;
  answer(sessionId: string, requestId: string, value: string | boolean): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  suspend(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  onEvent(sessionId: string, cb: (event: CanonicalEventEnvelope) => void): () => void;
  onDelta(sessionId: string, cb: (delta: SessionDeltaMessage) => void): () => void;
  onSessionState(cb: (state: SessionStateMessage) => void): () => void;
  onConnectionStatus(cb: (status: ConnectionStatus) => void): () => void;
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
}

export function createSessionsClient(options: CreateSessionsClientOptions = {}): SessionsClient {
  const transport = options.transport ?? (isTauri() ? createTauriTransport() : createDirectWsTransport(defaultDevWsUrl()));

  const eventListeners = new Map<string, Set<(event: CanonicalEventEnvelope) => void>>();
  const deltaListeners = new Map<string, Set<(delta: SessionDeltaMessage) => void>>();
  const sessionStateListeners = new Set<(state: SessionStateMessage) => void>();
  const connectionStatusListeners = new Set<(status: ConnectionStatus) => void>();
  const pendingReplies = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  // The subscribed set, and the highest seq observed per session -- what a
  // reconnect resubscribes with. Deltas never touch this (they carry no
  // seq and are not part of the persisted, replayable event log).
  const subscribedSessions = new Set<string>();
  const lastSeq = new Map<string, number>();
  let wasOpen = false;

  function send<T>(frame: Omit<ClientFrame, "id">): Promise<T> {
    const id = randomFrameId();
    const full = { ...frame, id } as ClientFrame;
    return new Promise<T>((resolve, reject) => {
      pendingReplies.set(id, { resolve: resolve as (v: unknown) => void, reject });
      transport.send(full);
    });
  }

  transport.onFrame((frame) => {
    if (frame.type === "reply" || frame.type === "error") {
      if (!frame.id) return;
      const pending = pendingReplies.get(frame.id);
      if (!pending) return;
      pendingReplies.delete(frame.id);
      if (frame.type === "error") {
        pending.reject(new Error(`${frame.payload.code}: ${frame.payload.message}`));
      } else {
        pending.resolve(frame.payload);
      }
      return;
    }
    if (frame.type === "event") {
      const { session_id, event } = frame.payload;
      lastSeq.set(session_id, event.seq);
      for (const cb of eventListeners.get(session_id) ?? []) cb(event);
      return;
    }
    if (frame.type === "delta") {
      // Never stored/tracked -- streamed text only, not part of the
      // replayable log (session-runtime.ts never persists a delta either).
      for (const cb of deltaListeners.get(frame.payload.session_id) ?? []) cb(frame.payload);
      return;
    }
    if (frame.type === "session_state") {
      for (const cb of sessionStateListeners) cb(frame.payload);
    }
  });

  transport.onStatus((status) => {
    for (const cb of connectionStatusListeners) cb(status);
    if (status === "open") {
      // A fresh connect (first time) has nothing to resubscribe yet; a
      // RE-connect after a drop resubscribes every still-wanted session
      // with the last seq this client itself observed, so nothing is
      // re-delivered and nothing is missed -- the server's own replay
      // (sessions-ws.ts) fills exactly that gap.
      if (wasOpen) {
        for (const sessionId of subscribedSessions) {
          void send({ type: "subscribe", payload: { session_id: sessionId, after: lastSeq.get(sessionId) } });
        }
      }
      wasOpen = true;
    } else if (status === "closed") {
      wasOpen = false;
    }
  });

  transport.connect();

  return {
    async subscribe(sessionId, afterSeq) {
      subscribedSessions.add(sessionId);
      const after = afterSeq ?? lastSeq.get(sessionId);
      await send({ type: "subscribe", payload: { session_id: sessionId, after } });
    },
    unsubscribe(sessionId) {
      subscribedSessions.delete(sessionId);
      lastSeq.delete(sessionId);
      transport.send({ id: randomFrameId(), type: "unsubscribe", payload: { session_id: sessionId } });
    },
    async message(sessionId, text) {
      await send({ type: "message", payload: { session_id: sessionId, text } });
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
    async suspend(sessionId) {
      await send({ type: "suspend", payload: { session_id: sessionId } });
    },
    async close(sessionId) {
      await send({ type: "close", payload: { session_id: sessionId } });
    },
    onEvent(sessionId, cb) {
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
    onSessionState(cb) {
      sessionStateListeners.add(cb);
      return () => sessionStateListeners.delete(cb);
    },
    onConnectionStatus(cb) {
      connectionStatusListeners.add(cb);
      return () => connectionStatusListeners.delete(cb);
    },
    disconnect() {
      transport.disconnect();
    },
  };
}
