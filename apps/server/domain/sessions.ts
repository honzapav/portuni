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
  terminal_id: z.string().nullable().optional().describe("Desktop PTY that spawned this session's CLI (#218, phase 0 of the multi-window design), when known."),
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

// Default session name -- spec ("Naming & UI"): "Default name `node · date`".
// `node` is the anchor's name, or 'Chat' for the anchor-less
// interactive_chat type. `createdAtIso` is truncated to its date part
// (matches migration 028's SQL backfill exactly, so old and new rows are
// indistinguishable). Exported so session-handoff.ts's suspend-time
// enrichment can compare a session's current name against this to decide
// whether the user has since renamed it (see name_is_custom).
export function computeDefaultSessionName(nodeName: string | null, createdAtIso: string): string {
  return `${nodeName ?? "Chat"} · ${createdAtIso.slice(0, 10)}`;
}

// preassignedId (#208 follow-up, "kernel-level isolation between concurrent
// sessions on the same node"): when the caller already minted this session's
// id before the row existed -- the Seatbelt profile is frozen at spawn time,
// before an MCP connection is even attempted, and its projection grant is
// narrowed to that id (domain/sandbox-profile.ts) -- pass it here so the
// domain id matches what the kernel already granted, instead of minting a
// second, unrelated id. Not part of CreateSessionInput's zod schema: that
// type also shapes any future MCP-exposed session-creation input, and a
// self-declared id there would violate "derived by the server, never
// self-declared". Only bindSessionPersistence (mcp/session-persistence.ts)
// supplies it, sourced from a header the server itself put in the per-mirror
// .mcp.json, never from raw client input.
export async function createSession(
  db: Client,
  userId: string,
  input: CreateSessionInput,
  preassignedId?: string | null,
): Promise<SessionRow> {
  const parsed = CreateSessionInput.parse(input);
  const id = preassignedId ?? ulid();
  const now = new Date().toISOString();

  let nodeName: string | null = null;
  if (parsed.node_id !== null) {
    const nodeRow = await db.execute({ sql: "SELECT name FROM nodes WHERE id = ?", args: [parsed.node_id] });
    nodeName = nodeRow.rows.length > 0 ? String(nodeRow.rows[0].name) : null;
  }
  const name = computeDefaultSessionName(nodeName, now);

  await db.execute({
    sql: `INSERT INTO sessions (id, node_id, user_id, session_type, cli, profile_id, agent_session_id, terminal_id, state, name, created_at, last_active_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    args: [
      id,
      parsed.node_id,
      userId,
      parsed.session_type,
      parsed.cli ?? null,
      parsed.profile_id ?? null,
      parsed.agent_session_id ?? null,
      parsed.terminal_id ?? null,
      name,
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

// Rename a session -- spec: "always renamable". Marks name_is_custom so a
// later suspend (session-handoff.ts's title enrichment) never overwrites a
// deliberate human choice.
export async function renameSession(
  db: Client,
  actorUserId: string,
  sessionId: string,
  name: string,
): Promise<SessionRow> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("renameSession: name must not be empty");
  const existing = await loadSession(db, sessionId);
  if (!existing) throw new Error(`renameSession: ${sessionId} not found`);

  await db.execute({
    sql: "UPDATE sessions SET name = ?, name_is_custom = 1 WHERE id = ?",
    args: [trimmed, sessionId],
  });

  await writeAudit(db, actorUserId, "session_rename", "session", sessionId, {
    from: existing.name,
    to: trimmed,
  });

  const row = await loadSession(db, sessionId);
  if (!row) throw new Error(`renameSession: row ${sessionId} disappeared after UPDATE`);
  return row;
}

export async function getSession(db: Client, id: string): Promise<SessionRow | null> {
  return loadSession(db, id);
}

// Authorization gate for resume (#204: "resume_session_id has no ownership/
// anchor check"). A caller-supplied resume_session_id must never be trusted
// on its own: it must belong to the caller, be anchored to the node the
// caller is actually resuming into, and be in the one state resume is valid
// from. Shared by both the disk-plane resume (api/nodes.ts,
// api/write-scope.ts sandbox-profile endpoints, via
// domain/sandbox-profile.ts) and the graph-plane resume
// (mcp/session-persistence.ts) so a bypass in one cannot happen without
// bypassing the other. Mirrors api/sessions.ts's loadOwnSession plus the
// anchor/state checks resume specifically needs.
export async function loadResumableSession(
  db: Client,
  userId: string,
  nodeId: string,
  sessionId: string,
): Promise<SessionRow | null> {
  const row = await loadSession(db, sessionId);
  if (!row) return null;
  if (row.user_id !== userId) return null;
  if (row.node_id !== nodeId) return null;
  if (row.state !== "suspended") return null;
  return row;
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

// PTY exit (#218, "Sessions follow PTY exit"): closes every 'running'
// session sharing this terminal_id -- desktop's pty.rs calls this via
// POST /terminals/:terminal_id/exit whenever the PTY that spawned a CLI
// exits, for any reason (pty_kill, the user typing `exit`, a crash).
// Scoped to actorUserId, matching the owner-scoped pattern the rest of this
// module uses (a session is a personal work record) -- a terminal_id from
// one user's PTY must never be able to close another user's session.
// Idempotent: a terminal_id with no running session (already closed, or
// never bound to one) is a no-op. Returns the number of sessions closed.
export async function closeSessionsByTerminalId(
  db: Client,
  actorUserId: string,
  terminalId: string,
): Promise<number> {
  const res = await db.execute({
    sql: "SELECT id FROM sessions WHERE terminal_id = ? AND user_id = ? AND state = 'running'",
    args: [terminalId, actorUserId],
  });
  for (const row of res.rows) {
    await transitionSessionState(db, actorUserId, String(row.id), "closed");
  }
  return res.rows.length;
}

// GC backstop (#218): called from mcp/transport.ts's onclose, for a CLI
// whose config format cannot carry X-Portuni-Terminal (Codex, Vibe) or a
// crash that never reaches the exit endpoint above. Closes the session iff
// it is still 'running' -- deliberately does NOT use transitionSessionState's
// general state machine here, because that machine also allows
// suspended -> closed, and a session an agent has explicitly suspended
// (portuni_session_suspend) must stay resumable even though its MCP
// connection is gone.
export async function closeSessionIfRunning(db: Client, sessionId: string): Promise<void> {
  const row = await loadSession(db, sessionId);
  if (row?.state !== "running") return;
  await transitionSessionState(db, row.user_id, sessionId, "closed");
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

// Privilege rank for added_via, used by upsertSessionScopeRead's conflict
// resolution below (#208): a node's classification must never be
// downgraded on a re-add, or the audit signal for "repeated disconnected
// jumps to the same node -- a missing edge in the graph" (spec, "Read
// scope") is lost the moment the node is later reached normally.
// disconnected/elicited (an agent had to justify or the user had to
// confirm the reach) outrank edge/created/seed (routine, automatic
// reaches).
const ADDED_VIA_RANK: Record<SessionScopeAddedVia, number> = {
  seed: 0,
  edge: 1,
  created: 1,
  disconnected: 2,
  elicited: 2,
};

function rankExpr(column: string): string {
  const cases = (Object.entries(ADDED_VIA_RANK) as [SessionScopeAddedVia, number][])
    .map(([via, rank]) => `WHEN '${via}' THEN ${rank}`)
    .join(" ");
  return `(CASE ${column} ${cases} ELSE 0 END)`;
}

// Upsert a node's read-scope membership. Idempotent re-adds (e.g. a node
// already in scope reached again via a different path) update added_via/
// reason to the new classification only when it outranks (never downgrades)
// the existing one -- see ADDED_VIA_RANK. `writable` is untouched here --
// that dimension is set independently via setSessionScopeWritable, matching
// SessionScope.add() vs .addWritable() in mcp/scope.ts.
export async function upsertSessionScopeRead(
  db: Client,
  sessionId: string,
  nodeId: string,
  addedVia: SessionScopeAddedVia,
  reason: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const newOutranksExisting = `${rankExpr("excluded.added_via")} > ${rankExpr("session_scope.added_via")}`;
  await db.execute({
    sql: `INSERT INTO session_scope (session_id, node_id, added_via, reason, writable, added_at)
          VALUES (?, ?, ?, ?, 0, ?)
          ON CONFLICT (session_id, node_id) DO UPDATE SET
            added_via = CASE WHEN ${newOutranksExisting} THEN excluded.added_via ELSE session_scope.added_via END,
            reason = CASE WHEN ${newOutranksExisting} THEN excluded.reason ELSE session_scope.reason END`,
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

// "Write count" for the node-detail sessions row (spec, "Naming & UI": "Row
// shows state, last activity, CLI + profile, write count") -- the size of
// the session's write set (session_scope rows with writable=1), not a count
// of write operations: no per-write audit trail keyed by session exists yet,
// while the write set itself is already tracked here and is a reasonable,
// honest proxy ("how much can/did this session write to").
export async function getSessionWriteCount(db: Client, sessionId: string): Promise<number> {
  const res = await db.execute({
    sql: "SELECT COUNT(*) AS c FROM session_scope WHERE session_id = ? AND writable = 1",
    args: [sessionId],
  });
  return Number(res.rows[0].c);
}

// --- Suspend (phase 2, "Lifecycle" / "Handoff") ---

export interface SuspendSessionInput {
  handoffPath: string;
  handoffHash: string;
  agentSessionId?: string | null;
  // Title extracted from the handoff content (session-handoff.ts's
  // extractHandoffTitle). Spec: "enriched from the handoff title at
  // suspend" -- applied only when the session hasn't been manually renamed
  // (name_is_custom = 0); a custom name is never overwritten.
  handoffTitle?: string | null;
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
  const enrichedName =
    !existing.name_is_custom && input.handoffTitle && input.handoffTitle.trim().length > 0
      ? input.handoffTitle.trim()
      : existing.name;
  await db.execute({
    sql: `UPDATE sessions
             SET state = 'suspended', handoff_path = ?, handoff_hash = ?,
                 agent_session_id = COALESCE(?, agent_session_id), last_active_at = ?, name = ?
           WHERE id = ?`,
    args: [input.handoffPath, input.handoffHash, input.agentSessionId ?? null, now, enrichedName, sessionId],
  });

  await writeAudit(db, actorUserId, "session_suspend", "session", sessionId, {
    handoff_path: input.handoffPath,
    handoff_hash: input.handoffHash,
  });

  const row = await loadSession(db, sessionId);
  if (!row) throw new Error(`suspendSession: row ${sessionId} disappeared after UPDATE`);
  return row;
}
