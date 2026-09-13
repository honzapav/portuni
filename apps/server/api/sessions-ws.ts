// One WebSocket per window (spec: docs/superpowers/specs/2026-09-12-
// runner-and-session-design.md, "Model: Live channel"). GET /sessions/ws
// carries every session event, delta, state update and action in both
// directions -- REST (api/sessions.ts) stays for scripts and tests, but the
// window itself uses this socket so the chat, Relace tab, Práce sidebar and
// Přehled never poll.
//
// Frames are JSON `{ id?, type, payload }`. A frame carrying `id` gets a
// `{ id, type: "reply", payload }` on success or `{ id, type: "error",
// payload: { code, message } }` on failure; a refused action is always an
// error frame, never a closed socket -- the same sessionAccess codes the
// REST routes answer with (auth/session-access.ts).
//
// Auth happens once, at the "upgrade" event, before this module ever sees
// the connection (http/server.ts's checkUpgradeAuth) -- every frame on an
// open socket is already scoped to that one resolved identity for the life
// of the connection.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { getDb } from "../infra/db.js";
import { getSessionRuntime } from "../boot/session-runtime.js";
import { sessionAccess, SessionAccessError } from "../auth/session-access.js";
import { getSession, listSessions } from "../domain/sessions.js";
import { nodeVisibleTo } from "../auth/node-access.js";
import { logAudit } from "../infra/audit.js";
import type { RequestIdentity } from "../auth/request-identity.js";
import type { DeltaFrame, QuestionDecision } from "../domain/runner/types.js";
import type { PublishedEvent } from "../domain/runner/session-runtime.js";
import type { SessionRow } from "../shared/types.js";

const PING_INTERVAL_MS = 15_000;
const MAX_MISSED_PONGS = 2;
const REPLAY_PAGE_SIZE = 200;

const ClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().optional(),
    type: z.literal("subscribe"),
    payload: z.object({ session_id: z.string(), after: z.number().optional() }),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("unsubscribe"),
    payload: z.object({ session_id: z.string() }),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("message"),
    payload: z.object({ session_id: z.string(), text: z.string() }),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("answer"),
    payload: z.object({
      session_id: z.string(),
      request_id: z.string(),
      decision: z.object({ value: z.union([z.string(), z.boolean()]) }),
    }),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("interrupt"),
    payload: z.object({ session_id: z.string() }),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("suspend"),
    payload: z.object({ session_id: z.string() }),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("close"),
    payload: z.object({ session_id: z.string() }),
  }),
]);
type ClientFrame = z.infer<typeof ClientFrameSchema>;

interface Connection {
  ws: WebSocket;
  identity: RequestIdentity;
  // session_id -> the runtime's own unsubscribe callback for that target.
  subscriptions: Map<string, () => void>;
  missedPongs: number;
}

function send(ws: WebSocket, frame: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function sendReply(ws: WebSocket, id: string | undefined, payload: unknown): void {
  if (id) send(ws, { id, type: "reply", payload });
}

function sendErrorReply(ws: WebSocket, id: string | undefined, code: string, message: string): void {
  if (id) send(ws, { id, type: "error", payload: { code, message } });
}

// Same visibility rule api/overview.ts's filterSessions applies: a node-
// anchored session is visible iff the node is; a node-less session
// (interactive_chat) has nothing to check against, so only its own owner
// sees it.
async function canSeeSession(identity: RequestIdentity, row: Pick<SessionRow, "node_id" | "user_id">): Promise<boolean> {
  if (row.node_id === null) return row.user_id === identity.userId;
  return nodeVisibleTo(getDb(), identity, row.node_id);
}

function sessionStateFrame(row: SessionRow): { type: "session_state"; payload: unknown } {
  return {
    type: "session_state",
    payload: { session_id: row.id, state: row.state, waiting_since: row.waiting_since, node_id: row.node_id },
  };
}

function isDeltaFrame(event: PublishedEvent): event is DeltaFrame {
  return "type" in event && event.type === "delta";
}

// A live-published event that reached us via the runtime's own subscribe()
// -- canonical events carry the seq appendAndPublish attached; a delta
// never persists and never carries one.
function eventFrame(sessionId: string, event: PublishedEvent): { type: string; payload: unknown } {
  if (isDeltaFrame(event)) {
    return { type: "delta", payload: { session_id: sessionId, run_id: event.run_id, text: event.text } };
  }
  const { seq, kind, payload } = event;
  return { type: "event", payload: { session_id: sessionId, event: { kind, payload, seq } } };
}

export interface SessionsWsServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, identity: RequestIdentity): void;
  closeAll(): void;
}

export function createSessionsWsServer(): SessionsWsServer {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<Connection>();

  // Server-lifetime subscription (not per connection): fans a session_state
  // update out to every open connection that can see it whenever a
  // state_changed / question / run_ended event fires anywhere -- this is
  // what lets the Relace tab, sidebar and Přehled update without polling.
  // Lazy: constructed on first connection so tests can install a fake
  // runtime (setSessionRuntimeForTesting) before any socket ever opens.
  let globalUnsubscribe: (() => void) | null = null;
  function ensureGlobalSubscription(): void {
    if (globalUnsubscribe) return;
    globalUnsubscribe = getSessionRuntime().subscribe("*", (sessionId, event) => {
      if (isDeltaFrame(event)) return;
      if (event.kind === "state_changed" || event.kind === "question" || event.kind === "run_ended") {
        void broadcastSessionState(sessionId);
      }
    });
  }

  async function broadcastSessionState(sessionId: string): Promise<void> {
    const row = await getSession(getDb(), sessionId);
    if (!row) return;
    for (const conn of connections) {
      if (await canSeeSession(conn.identity, row)) send(conn.ws, sessionStateFrame(row));
    }
  }

  async function sendInitialSnapshot(conn: Connection): Promise<void> {
    const db = getDb();
    const [running, suspended] = await Promise.all([
      listSessions(db, { state: "running" }),
      listSessions(db, { state: "suspended" }),
    ]);
    for (const row of [...running, ...suspended]) {
      if (await canSeeSession(conn.identity, row)) send(conn.ws, sessionStateFrame(row));
    }
  }

  async function handleSubscribe(conn: Connection, frame: Extract<ClientFrame, { type: "subscribe" }>): Promise<void> {
    const { session_id: sessionId, after } = frame.payload;
    try {
      await sessionAccess(getDb(), conn.identity, sessionId, "read");
    } catch (err) {
      if (err instanceof SessionAccessError) {
        sendErrorReply(conn.ws, frame.id, err.code, err.message);
        return;
      }
      throw err;
    }

    // Existing subscription on this target (a re-subscribe with a new
    // `after`) is dropped first so the old listener never double-delivers.
    conn.subscriptions.get(sessionId)?.();

    const runtime = getSessionRuntime();
    // Subscribe to the runtime FIRST, buffering everything it emits, before
    // replaying the persisted log -- otherwise an event published between
    // the replay's last page and this subscribe call would be lost.
    let buffering = true;
    const buffer: PublishedEvent[] = [];
    const unsubscribe = runtime.subscribe(sessionId, (_sid, event) => {
      if (buffering) buffer.push(event);
      else send(conn.ws, eventFrame(sessionId, event));
    });
    conn.subscriptions.set(sessionId, unsubscribe);

    let cursor = after;
    let lastReplayedSeq = after ?? 0;
    for (;;) {
      const page = await runtime.listEvents(sessionId, { after: cursor, limit: REPLAY_PAGE_SIZE });
      for (const row of page) {
        send(conn.ws, { type: "event", payload: { session_id: sessionId, event: { kind: row.kind, payload: JSON.parse(row.payload) as unknown, seq: row.seq } } });
        lastReplayedSeq = row.seq;
      }
      if (page.length < REPLAY_PAGE_SIZE) break;
      cursor = lastReplayedSeq;
    }

    buffering = false;
    for (const event of buffer) {
      if ("seq" in event && event.seq <= lastReplayedSeq) continue;
      send(conn.ws, eventFrame(sessionId, event));
    }

    sendReply(conn.ws, frame.id, { ok: true });
  }

  function handleUnsubscribe(conn: Connection, frame: Extract<ClientFrame, { type: "unsubscribe" }>): void {
    conn.subscriptions.get(frame.payload.session_id)?.();
    conn.subscriptions.delete(frame.payload.session_id);
    sendReply(conn.ws, frame.id, { ok: true });
  }

  async function handleMessage(conn: Connection, frame: Extract<ClientFrame, { type: "message" }>): Promise<void> {
    const { session_id: sessionId, text } = frame.payload;
    try {
      await sessionAccess(getDb(), conn.identity, sessionId, "message");
    } catch (err) {
      if (err instanceof SessionAccessError) {
        sendErrorReply(conn.ws, frame.id, err.code, err.message);
        return;
      }
      throw err;
    }
    try {
      await getSessionRuntime().sendMessage(sessionId, text);
    } catch (err) {
      if (err instanceof Error && err.message.includes("has no live run")) {
        sendErrorReply(conn.ws, frame.id, "NO_LIVE_RUN", err.message);
        return;
      }
      throw err;
    }
    await logAudit(conn.identity.userId, "session_message", "session", sessionId, {});
    sendReply(conn.ws, frame.id, { ok: true });
  }

  async function handleAnswer(conn: Connection, frame: Extract<ClientFrame, { type: "answer" }>): Promise<void> {
    const { session_id: sessionId, request_id: requestId } = frame.payload;
    try {
      await sessionAccess(getDb(), conn.identity, sessionId, "message");
    } catch (err) {
      if (err instanceof SessionAccessError) {
        sendErrorReply(conn.ws, frame.id, err.code, err.message);
        return;
      }
      throw err;
    }
    const runtime = getSessionRuntime();
    const pending = runtime.pendingQuestion(sessionId);
    if (!pending || pending.request_id !== requestId) {
      sendErrorReply(conn.ws, frame.id, "NO_PENDING_QUESTION", "no pending question with this request_id");
      return;
    }
    const decision: QuestionDecision = { by: conn.identity.userId, value: frame.payload.decision.value, at: new Date().toISOString() };
    await runtime.answer(sessionId, requestId, decision);
    await logAudit(conn.identity.userId, "session_answer", "session", sessionId, { request_id: requestId });
    sendReply(conn.ws, frame.id, { ok: true });
  }

  // interrupt / suspend / close: the "stop" tier, shared shape (REST's
  // api/sessions.ts has the same three handlers over HTTP; this is the
  // socket's version of the same runtime calls, gated the same way).
  async function handleStop(
    conn: Connection,
    frame: Extract<ClientFrame, { type: "interrupt" | "suspend" | "close" }>,
  ): Promise<void> {
    const sessionId = frame.payload.session_id;
    let existing: SessionRow;
    try {
      existing = await sessionAccess(getDb(), conn.identity, sessionId, "stop");
    } catch (err) {
      if (err instanceof SessionAccessError) {
        sendErrorReply(conn.ws, frame.id, err.code, err.message);
        return;
      }
      throw err;
    }
    const runtime = getSessionRuntime();
    if (frame.type === "interrupt") await runtime.interrupt(sessionId);
    else if (frame.type === "suspend") await runtime.suspend(sessionId);
    else await runtime.closeSession(sessionId);
    await logAudit(conn.identity.userId, `session_${frame.type}`, "session", sessionId, {});
    if (existing.user_id !== conn.identity.userId) {
      await runtime.recordStoppedBy(sessionId, conn.identity.userId);
    }
    sendReply(conn.ws, frame.id, { ok: true });
  }

  async function dispatch(conn: Connection, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const result = ClientFrameSchema.safeParse(parsed);
    if (!result.success) return;
    const frame = result.data;
    try {
      switch (frame.type) {
        case "subscribe":
          await handleSubscribe(conn, frame);
          break;
        case "unsubscribe":
          handleUnsubscribe(conn, frame);
          break;
        case "message":
          await handleMessage(conn, frame);
          break;
        case "answer":
          await handleAnswer(conn, frame);
          break;
        case "interrupt":
        case "suspend":
        case "close":
          await handleStop(conn, frame);
          break;
      }
    } catch (err) {
      console.error("[portuni:sessions-ws] frame handling failed:", err);
      sendErrorReply(conn.ws, frame.id, "INTERNAL_ERROR", "internal error");
    }
  }

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, identity: RequestIdentity) => {
    ensureGlobalSubscription();
    const conn: Connection = { ws, identity, subscriptions: new Map(), missedPongs: 0 };
    connections.add(conn);

    const pingTimer = setInterval(() => {
      if (conn.missedPongs >= MAX_MISSED_PONGS) {
        ws.terminate();
        return;
      }
      conn.missedPongs += 1;
      ws.ping();
    }, PING_INTERVAL_MS);
    ws.on("pong", () => {
      conn.missedPongs = 0;
    });

    ws.on("message", (data) => {
      void dispatch(conn, data.toString("utf8"));
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      for (const unsubscribe of conn.subscriptions.values()) unsubscribe();
      conn.subscriptions.clear();
      connections.delete(conn);
    });
    ws.on("error", () => {
      // "close" always follows an "error" for a ws socket; cleanup lives
      // there, not here.
    });

    void sendInitialSnapshot(conn);
  });

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, identity: RequestIdentity): void {
    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit("connection", client, req, identity);
    });
  }

  function closeAll(): void {
    globalUnsubscribe?.();
    for (const conn of connections) conn.ws.terminate();
    wss.close();
  }

  return { handleUpgrade, closeAll };
}
