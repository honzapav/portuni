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
// of the connection. Two more facts are fixed there too and carried on the
// connection: the identity's global scope (a `read`-scope caller may
// subscribe but never send a mutating frame -- the same minScopeForRoute
// tier the REST twins of these frames carry), and whether the upgrade
// request proved it came from the desktop webview / dev proxy under the
// hardened posture (PORTUNI_WEBVIEW_PROXY_SECRET, #213) -- a spawned
// terminal holding the same loopback bearer can open the socket and
// watch, but its message/answer/interrupt/close/continue/handoff frames are
// refused, exactly as its REST calls are.
//
// Everything that touches storage goes through `SessionsWsDeps`: local mode
// (http/server.ts's default) resolves access and the initial snapshot
// against the graph db; the central-mode sync agent (desktop.ts, which has
// no graph db) plugs in its CentralClient-backed runtime and lets central
// answer the same questions over REST (createAgentSessionsWsDeps).

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { getDb } from "../infra/db.js";
import { getSessionRuntime } from "../boot/session-runtime.js";
import { sessionAccess, SessionAccessError, type SessionAccessAction } from "../auth/session-access.js";
import { listSessions } from "../domain/sessions.js";
import { scopeAtLeast } from "../auth/roles.js";
import { handoffRefusal } from "./session-handoff-errors.js";
import { RunnerMcpTokenMissingError } from "../domain/write-scope.js";
import type { SessionRuntime } from "../domain/runner/session-runtime.js";
import type { CentralClient } from "../domain/sync/central/client.js";
import { logAudit } from "../infra/audit.js";
import { toSummary } from "./sessions.js";
import type { RequestIdentity } from "../auth/request-identity.js";
import type { DeltaFrame, QuestionDecision } from "../domain/runner/types.js";
import type { PublishedEvent, SessionChangedFrame } from "../domain/runner/session-runtime.js";
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
      decision: z.object({ value: z.union([z.string(), z.boolean(), z.record(z.string(), z.string())]) }),
    }),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("interrupt"),
    payload: z.object({ session_id: z.string() }),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("close"),
    payload: z.object({ session_id: z.string() }),
  }),
  // #378: "Pokračovat v nové session" / "Navázat" -- closes this session
  // and starts a new one on the same node, seeded with its summary.
  z.object({
    id: z.string().optional(),
    type: z.literal("continue"),
    payload: z.object({ session_id: z.string() }),
  }),
  // #459: "Předat" -- ends the turn and the run and writes the thread's
  // handoff file, so another machine can pick the work up from it.
  z.object({
    id: z.string().optional(),
    type: z.literal("handoff"),
    payload: z.object({ session_id: z.string() }),
  }),
]);
type ClientFrame = z.infer<typeof ClientFrameSchema>;

export interface UpgradeContext {
  identity: RequestIdentity;
  // False when the hardened posture is on and the upgrade request did not
  // prove it came from the webview proxy -- mutating frames are refused.
  webviewProven: boolean;
}

interface Connection {
  ws: WebSocket;
  identity: RequestIdentity;
  webviewProven: boolean;
  // session_id -> the runtime's own unsubscribe callback for that target.
  subscriptions: Map<string, () => void>;
  missedPongs: number;
}

// What the socket needs from its environment. `access` resolves a session
// for an action or throws SessionAccessError (the same codes REST answers
// with); `snapshot` lists the sessions the initial session_state burst
// covers; `canSee` gates every later broadcast.
export interface SessionsWsDeps {
  runtime(): SessionRuntime;
  access(identity: RequestIdentity, sessionId: string, action: SessionAccessAction): Promise<SessionRow>;
  snapshot(identity: RequestIdentity): Promise<SessionRow[]>;
  canSee(identity: RequestIdentity, row: SessionRow): Promise<boolean>;
  // Records a performed action. Local mode writes audit_log; the agent has
  // no graph db, and central already audits the record calls the runtime
  // makes on its behalf.
  audit(identity: RequestIdentity, action: string, sessionId: string, detail: Record<string, unknown>): Promise<void>;
}

// Bounds the initial session_state burst: running + suspended sessions,
// newest activity first, never more than this many. Terminal states
// (closed/archived) are what the Relace tab pages through REST for.
const SNAPSHOT_LIMIT = 500;

export function createLocalSessionsWsDeps(): SessionsWsDeps {
  return {
    runtime: () => getSessionRuntime(),
    access: (identity, sessionId, action) => sessionAccess(getDb(), identity, sessionId, action),
    async snapshot(identity) {
      const db = getDb();
      const [running, suspended] = await Promise.all([
        listSessions(db, { state: "running", user_id: identity.userId }),
        listSessions(db, { state: "suspended", user_id: identity.userId }),
      ]);
      return [...running, ...suspended].slice(0, SNAPSHOT_LIMIT);
    },
    canSee: async (identity, row) => canSeeSession(identity, row),
    audit: (identity, action, sessionId, detail) => logAudit(identity.userId, action, "session", sessionId, detail),
  };
}

// Central-mode counterpart: the sidecar has no graph db, so "may this
// identity read/act on this session" is answered by central on every store
// call the runtime makes (each is a device-token REST round trip that runs
// sessionAccess there -- owner-only since #457). Locally the only thing to
// establish is that the session exists for this device's user: a central
// 404 is SESSION_NOT_FOUND, and central hands this device its own user's
// records only, so anything the store lets through is the owner's.
export function createAgentSessionsWsDeps(client: CentralClient, runtime: SessionRuntime): SessionsWsDeps {
  return {
    runtime: () => runtime,
    async access(_identity, sessionId) {
      const row = await runtime.getSession(sessionId);
      if (!row) throw new SessionAccessError("SESSION_NOT_FOUND", `session ${sessionId} not found`);
      return row;
    },
    async snapshot() {
      return client.listSessionRecords({ states: ["running", "suspended"], limit: SNAPSHOT_LIMIT });
    },
    // Central lists this device's own user's records only (#457) and a
    // broadcast here is for a session this runtime itself is running or
    // just touched, so the owner check is the same one, re-stated on the
    // row the frame carries.
    canSee: async (identity, row) => row.user_id === identity.userId,
    audit: async () => undefined,
  };
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

// The one-line session rule (#457, auth/session-access.ts): a thread is its
// owner's, so a frame about it reaches that socket only. The anchor node's
// own ACL says nothing about its threads any more.
function canSeeSession(identity: RequestIdentity, row: Pick<SessionRow, "user_id">): boolean {
  return row.user_id === identity.userId;
}

function sessionStatePayload(row: SessionRow) {
  return {
    session_id: row.id,
    state: row.state,
    waiting_since: row.waiting_since,
    node_id: row.node_id,
    name: row.name,
  };
}

function sessionStateFrame(row: SessionRow): { type: "session_state"; payload: unknown } {
  return { type: "session_state", payload: sessionStatePayload(row) };
}

function isDeltaFrame(event: PublishedEvent): event is DeltaFrame {
  return "type" in event && event.type === "delta";
}

function isSessionChangedFrame(event: PublishedEvent): event is SessionChangedFrame {
  return "type" in event && event.type === "session_changed";
}

// A live-published event that reached us via the runtime's own subscribe()
// -- canonical events carry the seq appendAndPublish attached; a delta
// never persists and never carries one.
function eventFrame(
  sessionId: string,
  event: Exclude<PublishedEvent, SessionChangedFrame>,
): { type: string; payload: unknown } {
  if (isDeltaFrame(event)) {
    return {
      type: "delta",
      payload: { session_id: sessionId, run_id: event.run_id, channel: event.channel, text: event.text },
    };
  }
  const { seq, kind, payload } = event;
  return { type: "event", payload: { session_id: sessionId, event: { kind, payload, seq } } };
}

export interface SessionsWsServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: UpgradeContext): void;
  closeAll(): void;
}

export function createSessionsWsServer(deps: SessionsWsDeps = createLocalSessionsWsDeps()): SessionsWsServer {
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
    globalUnsubscribe = deps.runtime().subscribe("*", (sessionId, event) => {
      if (isSessionChangedFrame(event)) {
        void broadcastSessionState(sessionId);
        return;
      }
      if (isDeltaFrame(event)) return;
      if (event.kind === "state_changed" || event.kind === "question" || event.kind === "run_ended") {
        void broadcastSessionState(sessionId);
      }
    });
  }

  // #494: every broadcast reads the row afresh, and two in flight at once
  // (a run_ended and the suspend right after it) can finish out of order --
  // a slow read against the central server landing last -- and leave every
  // window on the older state. So the newest broadcast wins: each takes a
  // number when its event fires, and a frame goes out only while no later
  // broadcast of the same session has claimed the send. The reads still run
  // side by side, so one stuck read never holds back the frames after it,
  // and a failed read is logged, not swallowed.
  const broadcastTurns = new Map<string, { issued: number; claimed: number; inFlight: number }>();
  async function broadcastSessionState(sessionId: string): Promise<void> {
    let turns = broadcastTurns.get(sessionId);
    if (!turns) {
      turns = { issued: 0, claimed: 0, inFlight: 0 };
      broadcastTurns.set(sessionId, turns);
    }
    const mine = ++turns.issued;
    turns.inFlight++;
    try {
      const row = await deps.runtime().getSession(sessionId);
      if (!row || mine < turns.claimed) return;
      turns.claimed = mine;
      // One visibility answer per distinct identity, not per connection: a
      // user with three windows open costs one node-access query, not three.
      const verdicts = new Map<string, Promise<boolean>>();
      for (const conn of connections) {
        let verdict = verdicts.get(conn.identity.userId);
        if (!verdict) {
          verdict = deps.canSee(conn.identity, row);
          verdicts.set(conn.identity.userId, verdict);
        }
        const visible = await verdict;
        // A later broadcast took over while this one waited: its row is the
        // newer one, and it sends to every connection itself.
        if (turns.claimed !== mine) return;
        if (visible) send(conn.ws, sessionStateFrame(row));
      }
    } catch (err) {
      console.warn(`[portuni:sessions-ws] session_state for ${sessionId} was not sent:`, err);
    } finally {
      turns.inFlight--;
      if (turns.inFlight === 0 && broadcastTurns.get(sessionId) === turns) broadcastTurns.delete(sessionId);
    }
  }

  // One frame for the whole snapshot, never one per session: the client
  // folds a frame into its store and re-renders, so a frame per session was
  // as many renders in a row (React gave up after 50, #185).
  async function sendInitialSnapshot(conn: Connection): Promise<void> {
    const rows = await deps.snapshot(conn.identity);
    send(conn.ws, { type: "session_states", payload: { sessions: rows.map(sessionStatePayload) } });
  }

  // Mutating frames carry the same `write` tier their REST twins do
  // (auth/min-scopes.ts), and under the hardened posture only a connection
  // that proved itself at upgrade may send them at all.
  function refuseUnlessMutationAllowed(conn: Connection, frame: { id?: string; type: string }): boolean {
    if (!conn.webviewProven) {
      sendErrorReply(
        conn.ws,
        frame.id,
        "WEBVIEW_PROXY_REQUIRED",
        "session actions over the socket are reserved for the desktop app; use the Portuni MCP tools from a terminal",
      );
      return false;
    }
    if (!scopeAtLeast(conn.identity.globalScope, "write")) {
      sendErrorReply(conn.ws, frame.id, "FORBIDDEN", `${frame.type} requires write scope`);
      return false;
    }
    return true;
  }

  async function handleSubscribe(conn: Connection, frame: Extract<ClientFrame, { type: "subscribe" }>): Promise<void> {
    const { session_id: sessionId, after } = frame.payload;
    try {
      await deps.access(conn.identity, sessionId, "read");
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

    const runtime = deps.runtime();
    // Subscribe to the runtime FIRST, buffering everything it emits, before
    // replaying the persisted log -- otherwise an event published between
    // the replay's last page and this subscribe call would be lost.
    let buffering = true;
    const buffer: PublishedEvent[] = [];
    const unsubscribe = runtime.subscribe(sessionId, (_sid, event) => {
      // A rename is not part of the conversation; it reaches every socket
      // as session_state through the global subscription instead.
      if (isSessionChangedFrame(event)) return;
      if (buffering) buffer.push(event);
      else send(conn.ws, eventFrame(sessionId, event));
    });
    conn.subscriptions.set(sessionId, unsubscribe);

    // One `events` frame per page, never a frame per event: the client
    // renders per frame, and a long thread's history is thousands of events.
    let cursor = after;
    let lastReplayedSeq = after ?? 0;
    for (;;) {
      const page = await runtime.listEvents(sessionId, { after: cursor, limit: REPLAY_PAGE_SIZE });
      if (page.length > 0) {
        const events = page.map((row) => ({ kind: row.kind, payload: JSON.parse(row.payload) as unknown, seq: row.seq }));
        send(conn.ws, { type: "events", payload: { session_id: sessionId, events } });
        lastReplayedSeq = page[page.length - 1].seq;
      }
      if (page.length < REPLAY_PAGE_SIZE) break;
      cursor = lastReplayedSeq;
    }

    buffering = false;
    for (const event of buffer) {
      if (isSessionChangedFrame(event)) continue;
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
    if (!refuseUnlessMutationAllowed(conn, frame)) return;
    try {
      await deps.access(conn.identity, sessionId, "message");
    } catch (err) {
      if (err instanceof SessionAccessError) {
        sendErrorReply(conn.ws, frame.id, err.code, err.message);
        return;
      }
      throw err;
    }
    try {
      await deps.runtime().sendMessage(sessionId, text);
    } catch (err) {
      if (err instanceof Error && err.message.includes("has no live run")) {
        sendErrorReply(conn.ws, frame.id, "NO_LIVE_RUN", err.message);
        return;
      }
      // #497: a resume with nothing to continue from on this device.
      const refusal = handoffRefusal(err);
      if (refusal) {
        sendErrorReply(conn.ws, frame.id, refusal.code, refusal.message);
        return;
      }
      throw err;
    }
    await deps.audit(conn.identity, "session_message", sessionId, {});
    sendReply(conn.ws, frame.id, { ok: true });
  }

  async function handleAnswer(conn: Connection, frame: Extract<ClientFrame, { type: "answer" }>): Promise<void> {
    const { session_id: sessionId, request_id: requestId } = frame.payload;
    if (!refuseUnlessMutationAllowed(conn, frame)) return;
    try {
      await deps.access(conn.identity, sessionId, "message");
    } catch (err) {
      if (err instanceof SessionAccessError) {
        sendErrorReply(conn.ws, frame.id, err.code, err.message);
        return;
      }
      throw err;
    }
    const runtime = deps.runtime();
    const pending = runtime.pendingQuestion(sessionId);
    if (!pending || pending.request_id !== requestId) {
      sendErrorReply(conn.ws, frame.id, "NO_PENDING_QUESTION", "no pending question with this request_id");
      return;
    }
    const decision: QuestionDecision = { by: conn.identity.userId, value: frame.payload.decision.value, at: new Date().toISOString() };
    await runtime.answer(sessionId, requestId, decision);
    await deps.audit(conn.identity, "session_answer", sessionId, { request_id: requestId });
    sendReply(conn.ws, frame.id, { ok: true });
  }

  // interrupt / close: the "stop" tier, shared shape (REST's api/sessions.ts
  // has the same two handlers over HTTP; this is the socket's version of
  // the same runtime calls, gated the same way). interrupt (#378) only ever
  // cancels the current turn now -- the run stays live either way.
  async function handleStop(
    conn: Connection,
    frame: Extract<ClientFrame, { type: "interrupt" | "close" }>,
  ): Promise<void> {
    const sessionId = frame.payload.session_id;
    if (!refuseUnlessMutationAllowed(conn, frame)) return;
    try {
      await deps.access(conn.identity, sessionId, "stop");
    } catch (err) {
      if (err instanceof SessionAccessError) {
        sendErrorReply(conn.ws, frame.id, err.code, err.message);
        return;
      }
      throw err;
    }
    const runtime = deps.runtime();
    if (frame.type === "interrupt") await runtime.interrupt(sessionId);
    else await runtime.closeSession(sessionId);
    await deps.audit(conn.identity, `session_${frame.type}`, sessionId, {});
    sendReply(conn.ws, frame.id, { ok: true });
  }

  // #378: owner-only, same tier the old resume frame used -- unlike
  // interrupt/close, the reply carries the new session so the client can
  // switch the active thread to it without a second round trip.
  async function handleContinue(conn: Connection, frame: Extract<ClientFrame, { type: "continue" }>): Promise<void> {
    const sessionId = frame.payload.session_id;
    if (!refuseUnlessMutationAllowed(conn, frame)) return;
    try {
      await deps.access(conn.identity, sessionId, "resume");
    } catch (err) {
      if (err instanceof SessionAccessError) {
        sendErrorReply(conn.ws, frame.id, err.code, err.message);
        return;
      }
      throw err;
    }
    const runtime = deps.runtime();
    const { session, run } = await runtime.continueSession(sessionId);
    await deps.audit(conn.identity, "session_continue", sessionId, { new_session_id: session.id });
    sendReply(conn.ws, frame.id, { session: await toSummary(session), run });
  }

  // #459: "Předat" -- the same runtime operation and the same answer
  // (`{ session, handoff_path }`) its REST twin gives, so a client with a
  // live channel needs no second transport for it. The "stop" tier:
  // this ends the run, exactly what interrupt/close do.
  async function handleHandoff(conn: Connection, frame: Extract<ClientFrame, { type: "handoff" }>): Promise<void> {
    const sessionId = frame.payload.session_id;
    if (!refuseUnlessMutationAllowed(conn, frame)) return;
    try {
      await deps.access(conn.identity, sessionId, "stop");
    } catch (err) {
      if (err instanceof SessionAccessError) {
        sendErrorReply(conn.ws, frame.id, err.code, err.message);
        return;
      }
      throw err;
    }
    try {
      const { session, handoff_path } = await deps.runtime().handoff(sessionId);
      await deps.audit(conn.identity, "session_handoff", sessionId, { handoff_path });
      sendReply(conn.ws, frame.id, { session: await toSummary(session), handoff_path });
    } catch (err) {
      const refusal = handoffRefusal(err);
      if (refusal) {
        sendErrorReply(conn.ws, frame.id, refusal.code, refusal.message);
        return;
      }
      throw err;
    }
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
        case "close":
          await handleStop(conn, frame);
          break;
        case "continue":
          await handleContinue(conn, frame);
          break;
        case "handoff":
          await handleHandoff(conn, frame);
          break;
      }
    } catch (err) {
      console.error("[portuni:sessions-ws] frame handling failed:", err);
      // #507: a run that cannot start says why, the way REST's 503 does.
      if (err instanceof RunnerMcpTokenMissingError) {
        sendErrorReply(conn.ws, frame.id, err.code, err.message);
        return;
      }
      sendErrorReply(conn.ws, frame.id, "INTERNAL_ERROR", "internal error");
    }
  }

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, ctx: UpgradeContext) => {
    ensureGlobalSubscription();
    const conn: Connection = {
      ws,
      identity: ctx.identity,
      webviewProven: ctx.webviewProven,
      subscriptions: new Map(),
      missedPongs: 0,
    };
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

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: UpgradeContext): void {
    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit("connection", client, req, ctx);
    });
  }

  function closeAll(): void {
    globalUnsubscribe?.();
    for (const conn of connections) conn.ws.terminate();
    wss.close();
  }

  return { handleUpgrade, closeAll };
}
