// Domain: persistent sessions + session_scope (phase 2 of
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md,
// "Persistent sessions"). Pure functions over a libsql Client. No MCP / HTTP
// coupling -- the live wiring that keeps a session's in-memory SessionScope
// (mcp/scope.ts) synced with these rows lives in mcp/session-persistence.ts.

import { z } from "zod";
import { ulid } from "ulid";
import type { Client, InValue } from "@libsql/client";
import {
  SessionRow,
  SessionScopeRow,
  SESSION_STATES,
  type SessionScopeAddedVia,
  type SessionState,
} from "../shared/types.js";
import { writeAudit } from "../infra/audit.js";

const SESSION_TYPES = ["interactive_task", "interactive_chat", "headless", "env"] as const;

const CreateSessionInput = z.object({
  node_id: z.string().nullable().describe("Anchor node (ULID). Null for interactive_chat, which has no anchor."),
  session_type: z.enum(SESSION_TYPES).describe("Derived by the server from the auth path -- never self-declared."),
  cli: z.string().nullable().optional().describe("CLI the session runs under (claude|codex|vibe|...), when known."),
  profile_id: z.string().nullable().optional().describe("Spawn profile used (phase 3 -- CLI profiles registry)."),
  agent_session_id: z.string().nullable().optional().describe("The underlying agent CLI's own conversation id, for --resume."),
});
type CreateSessionInput = z.infer<typeof CreateSessionInput>;

const ListSessionsInput = z.object({
  node_id: z.string().optional().describe("Filter: sessions anchored to this node."),
  user_id: z.string().optional().describe("Filter: sessions owned by this user."),
  state: z.enum(SESSION_STATES).optional().describe("Filter: sessions in this state."),
});
type ListSessionsInput = z.infer<typeof ListSessionsInput>;

async function loadSession(db: Client, id: string): Promise<SessionRow | null> {
  const res = await db.execute({ sql: "SELECT * FROM sessions WHERE id = ?", args: [id] });
  if (res.rows.length === 0) return null;
  return SessionRow.parse(res.rows[0]);
}

export async function createSession(
  db: Client,
  userId: string,
  input: CreateSessionInput,
): Promise<SessionRow> {
  const parsed = CreateSessionInput.parse(input);
  const id = ulid();
  const now = new Date().toISOString();

  await db.execute({
    sql: `INSERT INTO sessions (id, node_id, user_id, session_type, cli, profile_id, agent_session_id, state, created_at, last_active_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    args: [
      id,
      parsed.node_id,
      userId,
      parsed.session_type,
      parsed.cli ?? null,
      parsed.profile_id ?? null,
      parsed.agent_session_id ?? null,
      now,
      now,
    ],
  });

  await writeAudit(db, userId, "session_create", "session", id, {
    node_id: parsed.node_id,
    session_type: parsed.session_type,
  });

  const row = await loadSession(db, id);
  if (!row) throw new Error(`createSession: inserted row ${id} not found`);
  return row;
}

export async function getSession(db: Client, id: string): Promise<SessionRow | null> {
  return loadSession(db, id);
}

export async function listSessions(
  db: Client,
  filters: ListSessionsInput = {},
): Promise<SessionRow[]> {
  const parsed = ListSessionsInput.parse(filters);

  const conds: string[] = [];
  const args: InValue[] = [];
  if (parsed.node_id !== undefined) {
    conds.push("node_id = ?");
    args.push(parsed.node_id);
  }
  if (parsed.user_id !== undefined) {
    conds.push("user_id = ?");
    args.push(parsed.user_id);
  }
  if (parsed.state !== undefined) {
    conds.push("state = ?");
    args.push(parsed.state);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";

  const res = await db.execute({
    sql: `SELECT * FROM sessions ${where} ORDER BY last_active_at DESC`,
    args,
  });
  return res.rows.map((r) => SessionRow.parse(r));
}

// Bump last_active_at without changing state -- called on every tool call
// (or at minimum on scope changes) so an idle-but-open session doesn't look
// abandoned next to one still doing work.
export async function touchSession(db: Client, id: string): Promise<void> {
  await db.execute({
    sql: "UPDATE sessions SET last_active_at = ? WHERE id = ?",
    args: [new Date().toISOString(), id],
  });
}

// State machine. running/suspended are the live states (a session can
// bounce between them via suspend/resume, #190); closed is terminal from the
// user's point of view but auto-archives (a view filter, never a delete) as
// the only way out of closed. archived itself is terminal.
const ALLOWED_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  running: ["suspended", "closed"],
  suspended: ["running", "closed"],
  closed: ["archived"],
  archived: [],
};

export async function transitionSessionState(
  db: Client,
  actorUserId: string,
  sessionId: string,
  toState: SessionState,
): Promise<SessionRow> {
  const existing = await loadSession(db, sessionId);
  if (!existing) throw new Error(`transitionSessionState: ${sessionId} not found`);
  if (existing.state === toState) return existing;
  if (!ALLOWED_TRANSITIONS[existing.state].includes(toState)) {
    throw new Error(
      `transitionSessionState: ${existing.state} -> ${toState} is not a valid transition`,
    );
  }

  const now = new Date().toISOString();
  const closedAt = toState === "closed" ? now : existing.closed_at;

  await db.execute({
    sql: "UPDATE sessions SET state = ?, last_active_at = ?, closed_at = ? WHERE id = ?",
    args: [toState, now, closedAt, sessionId],
  });

  await writeAudit(db, actorUserId, "session_state_transition", "session", sessionId, {
    from: existing.state,
    to: toState,
  });

  const row = await loadSession(db, sessionId);
  if (!row) throw new Error(`transitionSessionState: row ${sessionId} disappeared after UPDATE`);
  return row;
}

// Auto-archive closed sessions older than the given age -- a view filter
// (list/UI default to hiding archived), never a delete: the durable record,
// audit trail, and handoff outlive any CLI's own transcript retention by
// design. No per-row audit entry -- this is a housekeeping sweep, not a user
// action, so it would just add audit-log noise proportional to session
// volume without a corresponding actor to attribute it to.
const DEFAULT_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function autoArchiveClosedSessions(
  db: Client,
  olderThanMs: number = DEFAULT_ARCHIVE_AFTER_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const res = await db.execute({
    sql: "UPDATE sessions SET state = 'archived' WHERE state = 'closed' AND closed_at IS NOT NULL AND closed_at < ?",
    args: [cutoff],
  });
  return res.rowsAffected;
}

// --- session_scope: the persisted cache of a session's read/write scope ---

// Upsert a node's read-scope membership. Idempotent re-adds (e.g. a node
// already in scope reached again via a different path) update added_via/
// reason to the latest classification without touching `writable` -- that
// dimension is set independently via setSessionScopeWritable, matching
// SessionScope.add() vs .addWritable() in mcp/scope.ts.
export async function upsertSessionScopeRead(
  db: Client,
  sessionId: string,
  nodeId: string,
  addedVia: SessionScopeAddedVia,
  reason: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO session_scope (session_id, node_id, added_via, reason, writable, added_at)
          VALUES (?, ?, ?, ?, 0, ?)
          ON CONFLICT (session_id, node_id) DO UPDATE SET added_via = excluded.added_via, reason = excluded.reason`,
    args: [sessionId, nodeId, addedVia, reason, now],
  });
}

// Marks a node writable. The row must already exist (a node cannot be
// writable without being readable -- see SessionScope.addWritable).
export async function setSessionScopeWritable(
  db: Client,
  sessionId: string,
  nodeId: string,
): Promise<void> {
  await db.execute({
    sql: "UPDATE session_scope SET writable = 1 WHERE session_id = ? AND node_id = ?",
    args: [sessionId, nodeId],
  });
}

export async function getSessionScope(db: Client, sessionId: string): Promise<SessionScopeRow[]> {
  const res = await db.execute({
    sql: "SELECT * FROM session_scope WHERE session_id = ? ORDER BY added_at",
    args: [sessionId],
  });
  return res.rows.map((r) => SessionScopeRow.parse(r));
}

// --- Suspend (phase 2, "Lifecycle" / "Handoff") ---

export interface SuspendSessionInput {
  handoffPath: string;
  handoffHash: string;
  agentSessionId?: string | null;
}

// Unlike transitionSessionState (which treats a same-state call as a no-op),
// suspend always writes the handoff columns -- a session can be suspended
// more than once with an updated handoff (e.g. RALPH re-suspending between
// loop iterations, spec: "Handoff" -- "written by the agent at suspend (and
// by the RALPH loop between iterations -- same mechanism)"). Only refuses
// from a terminal state (closed/archived): those have no live terminal left
// to have produced a fresh handoff from.
export async function suspendSession(
  db: Client,
  actorUserId: string,
  sessionId: string,
  input: SuspendSessionInput,
): Promise<SessionRow> {
  const existing = await loadSession(db, sessionId);
  if (!existing) throw new Error(`suspendSession: ${sessionId} not found`);
  if (existing.state !== "running" && existing.state !== "suspended") {
    throw new Error(`suspendSession: cannot suspend a session in state '${existing.state}'`);
  }

  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE sessions
             SET state = 'suspended', handoff_path = ?, handoff_hash = ?,
                 agent_session_id = COALESCE(?, agent_session_id), last_active_at = ?
           WHERE id = ?`,
    args: [input.handoffPath, input.handoffHash, input.agentSessionId ?? null, now, sessionId],
  });

  await writeAudit(db, actorUserId, "session_suspend", "session", sessionId, {
    handoff_path: input.handoffPath,
    handoff_hash: input.handoffHash,
  });

  const row = await loadSession(db, sessionId);
  if (!row) throw new Error(`suspendSession: row ${sessionId} disappeared after UPDATE`);
  return row;
}
