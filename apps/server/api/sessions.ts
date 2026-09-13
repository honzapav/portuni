// REST endpoints for persistent sessions and, since the runner batch
// (docs/superpowers/specs/2026-09-12-runner-and-session-design.md), for
// tasks: starting one, driving its live run, and reading its event log.
//
//   GET   /nodes/:id/sessions              read    -> node's sessions, newest-active first
//   GET   /sessions/:id                    read    -> single session record
//   PATCH /sessions/:id                    write   -> rename, or (central record half, #323)
//                                                      state/waiting_since/handoff_* (owner only)
//   POST  /sessions/:id/state              write   -> state transition (owner or manage)
//   GET   /sessions/:id/resume-info        read    -> conversation-resumable? handoff changed?
//   GET   /sessions/:id/signals            read    -> restart indicator (run age, read/write set)
//   POST  /sessions                        write   -> start a task (session + first run)
//   POST  /sessions/record                 write   -> central record half (#323): create the row
//                                                      only, no run -- the agent-mode sidecar's own
//                                                      CentralSessionStore is the only caller
//   POST  /sessions/:id/messages           write   -> send a chat message (owner only)
//   POST  /sessions/:id/questions/:req_id  write   -> answer an open question (owner only)
//   POST  /sessions/:id/interrupt          write   -> interrupt the live run (owner or manage)
//   POST  /sessions/:id/suspend            write   -> suspend, up to a 30s poll (owner or manage)
//   POST  /sessions/:id/resume             write   -> start a new run from handoff/conversation (owner only)
//   POST  /sessions/:id/close              write   -> close the session (owner or manage)
//   GET   /sessions/:id/events             read    -> canonical event log
//   POST  /sessions/:id/events             write   -> central record half (#323): batch-append
//                                                      events, returns the assigned seqs
//   POST  /sessions/:id/runs               write   -> central record half (#323): create a run record
//   PATCH /sessions/:id/runs/:run_id       write   -> central record half (#323): patch a run record
//   GET   /sessions/:id/runs               read    -> central record half (#323): list a session's runs
//
// The "central record half" routes exist so the SAME SessionStore interface
// (domain/runner/store.ts) that DbSessionStore implements over this
// server's own db can ALSO be implemented as CentralSessionStore
// (domain/runner/store-central.ts) over these REST endpoints -- "one
// implementation" (spec rule 1): the session runtime itself never changes
// between local and central/agent mode, only which SessionStore backs it.
// They're served here unconditionally (also reachable in env/local mode,
// harmless) rather than gated to google/central mode specifically.
//
// Who may do what beyond the list route is auth/session-access.ts's
// sessionAccess table (docs/superpowers/specs/2026-09-12-remote-hosts-and-
// task-queue-design.md, "Visibility and control"): read is anyone who can
// see the anchor node, message/resume are owner-only, stop (interrupt/
// suspend/close) is the owner or manage scope. The list route itself keeps
// following the anchor node's own read gate (handleListNodeSessions).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DbClient } from "../infra/db.js";
import { z } from "zod";
import { getDb } from "../infra/db.js";
import {
  parseJsonBody,
  respondError,
  respondJson,
  type RequestIdentity,
} from "../http/middleware.js";
import { nodeVisibleTo } from "../auth/node-access.js";
import { sessionAccess, SessionAccessError, type SessionAccessAction } from "../auth/session-access.js";
import {
  closeSessionsByTerminalId,
  getSession,
  getSessionWriteCount,
  listSessions,
  renameSession,
  transitionSessionState,
} from "../domain/sessions.js";
import { getResumeInfo } from "../domain/session-handoff.js";
import { getMirrorPath } from "../domain/sync/mirror-registry.js";
import { logAudit } from "../infra/audit.js";
import { getSessionRuntime } from "../boot/session-runtime.js";
import { getAdapter } from "../domain/runner/registry.js";
import { getInstanceEnv } from "../domain/runner/instances.js";
import { DbSessionStore } from "../domain/runner/store.js";
import type { CanonicalEvent, QuestionDecision } from "../domain/runner/types.js";
import { SESSION_STATES, type SessionRow, type SessionState } from "../shared/types.js";
import type { SessionResumeInfo, SessionRunRow, SessionSummary } from "../shared/api-types.js";

async function toSummary(row: SessionRow): Promise<SessionSummary> {
  return {
    id: row.id,
    node_id: row.node_id,
    user_id: row.user_id,
    session_type: row.session_type,
    cli: row.cli,
    instance_id: row.instance_id,
    terminal_id: row.terminal_id,
    brief: row.brief,
    runner: row.runner,
    waiting_since: row.waiting_since,
    state: row.state,
    name: row.name,
    name_is_custom: row.name_is_custom === 1,
    handoff_path: row.handoff_path,
    write_count: await getSessionWriteCount(getDb(), row.id),
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    closed_at: row.closed_at,
  };
}

// GET /sessions?state=running,suspended&limit=500 -- every session the
// caller can see in the given states, raw rows (the consumer is
// CentralClient.listSessionRecords feeding the agent-mode live channel's
// initial session_state burst, which needs state/waiting_since/node_id and
// nothing curated). Visibility is the same rule sessionAccess("read")
// applies: a node-anchored session iff its node is visible, a node-less
// one only to its owner.
const ListSessionsQuery = z.object({
  state: z
    .string()
    .transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(SESSION_STATES)).min(1)),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export async function handleListSessions(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  url: URL,
): Promise<void> {
  try {
    const parsed = ListSessionsQuery.safeParse({
      state: url.searchParams.get("state") ?? "running,suspended",
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      respondJson(res, 400, { error: "invalid query", code: "INVALID_QUERY", issues: parsed.error.issues });
      return;
    }
    const db = getDb();
    const rows: SessionRow[] = [];
    for (const state of parsed.data.state) rows.push(...(await listSessions(db, { state })));
    rows.sort((a, b) => (a.last_active_at < b.last_active_at ? 1 : a.last_active_at > b.last_active_at ? -1 : 0));
    const sessions: SessionRow[] = [];
    // One visibility answer per node, not per row.
    const nodeVerdicts = new Map<string, Promise<boolean>>();
    for (const row of rows) {
      if (sessions.length >= parsed.data.limit) break;
      if (row.user_id === identity.userId) {
        sessions.push(row);
        continue;
      }
      if (row.node_id === null) continue;
      let verdict = nodeVerdicts.get(row.node_id);
      if (!verdict) {
        verdict = nodeVisibleTo(db, identity, row.node_id);
        nodeVerdicts.set(row.node_id, verdict);
      }
      if (await verdict) sessions.push(row);
    }
    respondJson(res, 200, { sessions });
  } catch (err) {
    respondError(res, `${req.method} /sessions`, err);
  }
}

export async function handleListNodeSessions(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
  url: URL,
): Promise<void> {
  try {
    const db = getDb();
    const nodeRow = await db.execute({ sql: "SELECT id FROM nodes WHERE id = ?", args: [nodeId] });
    if (nodeRow.rows.length === 0 || !(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }

    const includeArchived = url.searchParams.get("include_archived") === "1";
    let rows = await listSessions(db, { node_id: nodeId });
    if (!includeArchived) {
      rows = rows.filter((r) => r.state !== "archived");
    }
    const sessions = await Promise.all(rows.map(toSummary));
    respondJson(res, 200, { sessions });
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/sessions`, err);
  }
}

// Shared guard for the single-session routes below: resolves sessionAccess
// and, on denial, writes the response itself (404 for SESSION_NOT_FOUND, 403
// for SESSION_FORBIDDEN) and returns null so the caller can just `return`.
async function guardSessionAccess(
  res: ServerResponse,
  db: DbClient,
  identity: RequestIdentity,
  sessionId: string,
  action: SessionAccessAction,
): Promise<SessionRow | null> {
  try {
    return await sessionAccess(db, identity, sessionId, action);
  } catch (err) {
    if (err instanceof SessionAccessError) {
      respondJson(res, err.code === "SESSION_NOT_FOUND" ? 404 : 403, { error: err.message, code: err.code });
      return null;
    }
    throw err;
  }
}

// Access-table stop actions (interrupt/suspend/close) performed by someone
// other than the session's owner append a state_changed event naming the
// actor -- "the chat shows who stopped it" (remote-hosts-and-task-queue-
// design spec, "Visibility and control").
async function noteIfNotOwner(existing: SessionRow, identity: RequestIdentity, sessionId: string): Promise<void> {
  if (existing.user_id !== identity.userId) {
    await getSessionRuntime().recordStoppedBy(sessionId, identity.userId);
  }
}

// Raw SessionRow, not the curated SessionSummary other routes return: this
// is a brand new route with no web consumer yet, and CentralSessionStore's
// getSessionRecord needs every column (host_id, handoff_hash,
// agent_session_id, handoff_inline) -- session-runtime.ts's own
// suspend()/resume() read session.handoff_hash/host_id off exactly this
// call, so a lossy summary would silently corrupt agent-mode's own
// suspend/resume behaviour.
export async function handleGetSession(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "read");
    if (!existing) return;
    respondJson(res, 200, existing);
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}`, err);
  }
}

// Rename (the original, terminal-era shape of this route) is its own
// dedicated case below -- a plain-rename call keeps renameSession's own
// audit action and name_is_custom flag, rather than the generic
// DbSessionStore.patchSession path the central record half (#323) added
// alongside it for state/waiting_since/handoff_* -- those are the fields
// CentralSessionStore.patchSession forwards here from the runtime, never
// something a human would type into a rename box.
const PatchSessionBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    state: z.enum(SESSION_STATES).optional(),
    waiting_since: z.string().nullable().optional(),
    handoff_path: z.string().nullable().optional(),
    handoff_hash: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "at least one field is required");

export async function handlePatchSession(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "message");
    if (!existing) return;
    const body = await parseJsonBody(req, res, PatchSessionBody);
    if (!body) return;

    const isPlainRename = body.name !== undefined && Object.keys(body).length === 1;
    if (isPlainRename) {
      // Historical shape (#192): a curated SessionSummary, not the raw row.
      const updated = await renameSession(db, identity.userId, sessionId, body.name!);
      respondJson(res, 200, await toSummary(updated));
      return;
    }
    // Central record half (#323): raw SessionRow, same reasoning as
    // handleGetSession above -- the caller is CentralSessionStore, which
    // needs every column back, not the curated summary.
    const updated = await new DbSessionStore(db).patchSession(sessionId, {
      name: body.name,
      state: body.state,
      waiting_since: body.waiting_since,
      handoff_path: body.handoff_path,
      handoff_hash: body.handoff_hash,
    });
    respondJson(res, 200, updated);
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}`, err);
  }
}

const StateBody = z.object({
  state: z.enum(SESSION_STATES),
});

export async function handleTransitionSessionState(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "stop");
    if (!existing) return;
    const body = await parseJsonBody(req, res, StateBody);
    if (!body) return;
    const target: SessionState = body.state;
    try {
      const updated = await transitionSessionState(db, identity.userId, sessionId, target);
      respondJson(res, 200, await toSummary(updated));
    } catch (transitionErr) {
      respondJson(res, 409, { error: "invalid_transition", detail: String(transitionErr) });
    }
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/state`, err);
  }
}

// PTY exit (#218, "Sessions follow PTY exit"): desktop's pty.rs reader
// thread calls this whenever the PTY that spawned a CLI exits (pty_kill,
// the user typing `exit`, a crash). Closes every 'running' session sharing
// this terminal_id and owned by the caller; idempotent (a terminal_id with
// no running session is a no-op, so a retry after a transient failure is
// safe). No request body -- the terminal_id is the whole input.
export async function handleTerminalExit(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  terminalId: string,
): Promise<void> {
  try {
    const closed = await closeSessionsByTerminalId(getDb(), identity.userId, terminalId);
    respondJson(res, 200, { closed });
  } catch (err) {
    respondError(res, `${req.method} /terminals/${terminalId}/exit`, err);
  }
}

export async function handleGetSessionResumeInfo(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
  url: URL,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "read");
    if (!existing) return;
    const mirrorRoot = existing.node_id ? await getMirrorPath(identity.userId, existing.node_id) : null;
    // config_dir (#204): the profiles registry lives in the desktop app's
    // config.json (Rust), unreachable from this server process -- the
    // caller resolves the session's instance_id to a CLAUDE_CONFIG_DIR (when
    // one applies) and passes it through so checkConversationResumable
    // checks the right transcript location instead of always the default.
    const configDir = url.searchParams.get("config_dir") || null;
    const info = await getResumeInfo(existing, mirrorRoot, undefined, configDir);
    const payload: SessionResumeInfo = {
      session_id: existing.id,
      handoff_path: info.handoffPath,
      handoff_changed: info.handoffChanged,
      handoff_checkable: info.handoffCheckable,
      conversation_resumable: info.conversationResumable,
      generated_by: info.generatedBy,
      reason: info.reason,
    };
    respondJson(res, 200, payload);
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/resume-info`, err);
  }
}

// The restart indicator (SessionChat header, #342): run age, write/read-set
// size, and read-set growth since the live run started -- purely a signals
// read, no session-runtime mutation, so it follows the same read-tier gate
// resume-info does rather than needing its own action in session-access.ts.
export async function handleGetSessionSignals(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "read");
    if (!existing) return;
    const signals = await getSessionRuntime().sessionSignals(sessionId);
    respondJson(res, 200, signals);
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/signals`, err);
  }
}

// --- Tasks (runner batch): starting a session's task and driving its run --

const StartSessionBody = z.object({
  node_id: z.string().min(1),
  brief: z.string().trim().min(1),
  runner: z.string().min(1),
  instance_id: z.string().min(1).nullable().optional(),
  policy: z.enum(["default", "auto"]).optional(),
});

export async function handleStartSession(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    const db = getDb();
    const body = await parseJsonBody(req, res, StartSessionBody);
    if (!body) return;

    const nodeRow = await db.execute({ sql: "SELECT id FROM nodes WHERE id = ?", args: [body.node_id] });
    if (nodeRow.rows.length === 0 || !(await nodeVisibleTo(db, identity, body.node_id))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    if (!getAdapter(body.runner)) {
      respondJson(res, 400, { error: `unknown runner '${body.runner}'`, code: "UNKNOWN_RUNNER" });
      return;
    }
    if (body.instance_id != null && (await getInstanceEnv(body.instance_id)) === null) {
      respondJson(res, 400, { error: `unknown instance '${body.instance_id}'`, code: "UNKNOWN_INSTANCE" });
      return;
    }

    const { session, run } = await getSessionRuntime().startTask({
      userId: identity.userId,
      nodeId: body.node_id,
      brief: body.brief,
      runner: body.runner,
      instanceId: body.instance_id ?? null,
      policy: body.policy,
    });
    await logAudit(identity.userId, "session_start", "session", session.id, {
      node_id: body.node_id,
      runner: body.runner,
    });
    // startTask's own return value is the session row as of creation --
    // by the time it resolves, the run may already have opened a question
    // (waiting_since) or even completed, so re-fetch rather than serve a
    // stale snapshot (same reason the other task routes re-fetch below).
    const updated = await getSession(db, session.id);
    respondJson(res, 201, { session: await toSummary(updated ?? session), run });
  } catch (err) {
    respondError(res, `${req.method} /sessions`, err);
  }
}

const MessageBody = z.object({
  text: z.string().trim().min(1),
});

export async function handleSendSessionMessage(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "message");
    if (!existing) return;
    const body = await parseJsonBody(req, res, MessageBody);
    if (!body) return;

    try {
      await getSessionRuntime().sendMessage(sessionId, body.text);
    } catch (err) {
      if (err instanceof Error && err.message.includes("has no live run")) {
        respondJson(res, 409, { error: err.message, code: "NO_LIVE_RUN" });
        return;
      }
      throw err;
    }
    await logAudit(identity.userId, "session_message", "session", sessionId, {});
    respondJson(res, 202, { ok: true });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/messages`, err);
  }
}

const AnswerBody = z.object({
  decision: z.object({ value: z.union([z.string(), z.boolean()]) }),
});

export async function handleAnswerSessionQuestion(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
  requestId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "message");
    if (!existing) return;
    const body = await parseJsonBody(req, res, AnswerBody);
    if (!body) return;

    const runtime = getSessionRuntime();
    const pending = runtime.pendingQuestion(sessionId);
    if (!pending || pending.request_id !== requestId) {
      respondJson(res, 409, { error: "no pending question with this request_id", code: "NO_PENDING_QUESTION" });
      return;
    }
    const decision: QuestionDecision = { by: identity.userId, value: body.decision.value, at: new Date().toISOString() };
    await runtime.answer(sessionId, requestId, decision);
    await logAudit(identity.userId, "session_answer", "session", sessionId, { request_id: requestId });
    respondJson(res, 202, { ok: true });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/questions/${requestId}`, err);
  }
}

export async function handleInterruptSession(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "stop");
    if (!existing) return;
    await getSessionRuntime().interrupt(sessionId);
    await logAudit(identity.userId, "session_interrupt", "session", sessionId, {});
    await noteIfNotOwner(existing, identity, sessionId);
    const updated = await getSession(db, sessionId);
    respondJson(res, 200, { session: await toSummary(updated ?? existing) });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/interrupt`, err);
  }
}

export async function handleSuspendSession(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "stop");
    if (!existing) return;
    // The runtime's own poll loop awaits up to 30s for the agent's
    // portuni_session_suspend before falling back to a server-generated
    // handoff -- this route's caller is expected to wait for it.
    const updated = await getSessionRuntime().suspend(sessionId);
    await logAudit(identity.userId, "session_suspend", "session", sessionId, {});
    await noteIfNotOwner(existing, identity, sessionId);
    respondJson(res, 200, { session: await toSummary(updated) });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/suspend`, err);
  }
}

const ResumeBody = z.object({
  mode: z.enum(["conversation", "handoff"]),
});

export async function handleResumeSession(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "resume");
    if (!existing) return;
    const body = await parseJsonBody(req, res, ResumeBody);
    if (!body) return;

    let run: SessionRunRow;
    try {
      run = await getSessionRuntime().resume(sessionId, body.mode);
    } catch (err) {
      if (err instanceof Error && err.message.includes("already has a live run")) {
        respondJson(res, 409, { error: err.message, code: "ALREADY_RUNNING" });
        return;
      }
      if (err instanceof Error && err.message.includes("no resumable conversation")) {
        respondJson(res, 409, { error: err.message, code: "NOT_RESUMABLE" });
        return;
      }
      throw err;
    }
    await logAudit(identity.userId, "session_resume", "session", sessionId, { mode: body.mode });
    const updated = await getSession(db, sessionId);
    respondJson(res, 200, { session: await toSummary(updated ?? existing), run });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/resume`, err);
  }
}

export async function handleCloseSession(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "stop");
    if (!existing) return;
    const updated = await getSessionRuntime().closeSession(sessionId);
    await logAudit(identity.userId, "session_close", "session", sessionId, {});
    await noteIfNotOwner(existing, identity, sessionId);
    respondJson(res, 200, { session: await toSummary(updated) });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/close`, err);
  }
}

const MAX_EVENTS_LIMIT = 1000;
const DEFAULT_EVENTS_LIMIT = 200;

export async function handleListSessionEvents(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
  url: URL,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "read");
    if (!existing) return;

    const afterParam = url.searchParams.get("after");
    const limitParam = url.searchParams.get("limit");
    const after = afterParam !== null ? Number(afterParam) : undefined;
    const limit = Math.min(limitParam !== null ? Number(limitParam) : DEFAULT_EVENTS_LIMIT, MAX_EVENTS_LIMIT);

    const rows = await getSessionRuntime().listEvents(sessionId, { after, limit });
    const events = rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
    const nextAfter = rows.length === limit ? rows[rows.length - 1].seq : null;
    respondJson(res, 200, { events, next_after: nextAfter });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/events`, err);
  }
}

// --- Central record half (#323): CentralSessionStore's REST surface -----
// Every handler below is a thin wrapper over DbSessionStore -- the SAME
// class the local runtime uses -- bound to THIS server's own db, so a
// central/google-mode deployment (or, harmlessly, an env-mode one) can
// serve as the record of truth for an agent-mode sidecar's session runtime.

const RecordSessionBody = z.object({
  node_id: z.string().min(1),
  brief: z.string().nullable().optional(),
  runner: z.string().min(1),
  instance_id: z.string().nullable().optional(),
  host_id: z.string().nullable().optional(),
});

// Record-only: creates the session row without starting a run (unlike
// POST /sessions, which is startTask's REST surface). The agent-mode
// sidecar's own session runtime starts the run itself, device-local, and
// then records it here via POST /sessions/:id/runs -- the deliberate split
// this route exists for is "one implementation" (rule 1): the runtime code
// path is identical in both modes, only the SessionStore backing it swaps.
export async function handleCreateSessionRecord(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    const db = getDb();
    const body = await parseJsonBody(req, res, RecordSessionBody);
    if (!body) return;

    const nodeRow = await db.execute({ sql: "SELECT id FROM nodes WHERE id = ?", args: [body.node_id] });
    if (nodeRow.rows.length === 0 || !(await nodeVisibleTo(db, identity, body.node_id))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }

    const session = await new DbSessionStore(db).createSession({
      node_id: body.node_id,
      user_id: identity.userId,
      brief: body.brief ?? null,
      runner: body.runner,
      instance_id: body.instance_id ?? null,
      host_id: body.host_id ?? null,
    });
    await logAudit(identity.userId, "session_record", "session", session.id, {
      node_id: body.node_id,
      runner: body.runner,
    });
    // Raw SessionRow, same reasoning as GET/PATCH /sessions/:id above.
    respondJson(res, 201, session);
  } catch (err) {
    respondError(res, `${req.method} /sessions/record`, err);
  }
}

const CreateRunBody = z.object({
  runner: z.string().min(1),
  instance_id: z.string().nullable().optional(),
  host_id: z.string().nullable().optional(),
  agent_session_id: z.string().nullable().optional(),
  resumed_from_run_id: z.string().nullable().optional(),
});

export async function handleCreateSessionRun(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "message");
    if (!existing) return;
    const body = await parseJsonBody(req, res, CreateRunBody);
    if (!body) return;

    const run = await new DbSessionStore(db).createRun({
      session_id: sessionId,
      runner: body.runner,
      instance_id: body.instance_id ?? null,
      host_id: body.host_id ?? null,
      agent_session_id: body.agent_session_id ?? null,
      resumed_from_run_id: body.resumed_from_run_id ?? null,
    });
    respondJson(res, 201, { run });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/runs`, err);
  }
}

const RUN_END_REASONS = ["completed", "interrupted", "suspended", "error", "limit", "host_lost"] as const;
const PatchRunBody = z.object({
  ended_at: z.string().optional(),
  end_reason: z.enum(RUN_END_REASONS).optional(),
  agent_session_id: z.string().nullable().optional(),
  usage: z.unknown().optional(),
});

export async function handlePatchSessionRun(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
  runId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "message");
    if (!existing) return;
    const store = new DbSessionStore(db);
    const runs = await store.listRuns(sessionId);
    if (!runs.some((r) => r.id === runId)) {
      respondJson(res, 404, { error: "run not found" });
      return;
    }
    const body = await parseJsonBody(req, res, PatchRunBody);
    if (!body) return;

    const run = await store.patchRun(runId, body);
    respondJson(res, 200, { run });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/runs/${runId}`, err);
  }
}

export async function handleListSessionRuns(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "read");
    if (!existing) return;
    const runs = await new DbSessionStore(db).listRuns(sessionId);
    respondJson(res, 200, { runs });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/runs`, err);
  }
}

// The payload's per-event shape is intentionally loose (kind + arbitrary
// payload): the wire format IS the CanonicalEvent union, but this route's
// only caller is CentralSessionStore forwarding events the local session
// runtime already constructed and validated against that union -- the
// stricter per-kind shape checking (capEventPayload's caps, etc.) lives in
// DbSessionStore.appendEvents itself, same as every other appendEvents call.
const AppendEventsBody = z.object({
  run_id: z.string().nullable(),
  events: z.array(z.object({ kind: z.string(), payload: z.unknown() })).min(1),
});

export async function handleAppendSessionEvents(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "message");
    if (!existing) return;
    const body = await parseJsonBody(req, res, AppendEventsBody);
    if (!body) return;

    const seqs = await new DbSessionStore(db).appendEvents(
      sessionId,
      body.run_id,
      body.events as CanonicalEvent[],
    );
    respondJson(res, 200, { seqs });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/events`, err);
  }
}
