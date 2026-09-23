// Domain: persistent sessions + session_scope (phase 2 of
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md,
// "Persistent sessions"). Pure functions over a libsql DbClient. No MCP / HTTP
// coupling -- the live wiring that keeps a session's in-memory SessionScope
// (mcp/scope.ts) synced with these rows lives in mcp/session-persistence.ts.

import { z } from "zod";
import { ulid } from "ulid";
import type { DbClient, InValue } from "../infra/db.js";
import {
  SessionRow,
  SessionScopeRow,
  SESSION_STATES,
  type SessionScopeAddedVia,
  type SessionState,
} from "../shared/types.js";
import { writeAudit } from "../infra/audit.js";
import { handoffEnrichedName, suspendSessionServerSide, type ServerHandoffReason } from "./session-handoff.js";
import { sessionContentStoreForProcess } from "./runner/store-content.js";
import { isCentralServer } from "../infra/server-config.js";

const SESSION_TYPES = ["interactive_task", "interactive_chat", "headless", "env"] as const;

// A spawn/session id as minted by ulid(): 26 chars of Crockford base32. The
// X-Portuni-Spawn-Id request header is client-supplied, so it is accepted
// only in this exact shape, never as an arbitrary string -- a fresh run's
// own MCP connection (session-runtime.ts's startTask) sets it to the
// session row it already created, and the transport (mcp/transport.ts,
// mcp/agent-transport.ts) looks that id up (lookupSpawnSessionForBind) to
// decide whether to bind to the existing row instead of minting a new one.
const SPAWN_SESSION_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isSpawnSessionId(value: string): boolean {
  return SPAWN_SESSION_ID_RE.test(value);
}

// Parse the X-Portuni-Spawn-Id request header: the relayed spawn id when it
// is well-formed, null otherwise (absent, empty, or not a ULID).
export function spawnSessionIdFromHeader(header: string | string[] | undefined): string | null {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim() || null;
  return raw && isSpawnSessionId(raw) ? raw : null;
}

const CreateSessionInput = z.object({
  node_id: z.string().nullable().describe("Anchor node (ULID). Null for interactive_chat, which has no anchor."),
  session_type: z.enum(SESSION_TYPES).describe("Derived by the server from the auth path -- never self-declared."),
  cli: z.string().nullable().optional().describe("CLI the session runs under (claude|codex|vibe|...), when known."),
  instance_id: z.string().nullable().optional().describe("Runner provider instance used (apps/server/domain/runner/instances.ts) -- renamed from profile_id."),
  agent_session_id: z.string().nullable().optional().describe("The underlying agent CLI's own conversation id, for --resume."),
  terminal_id: z.string().nullable().optional().describe("Historical: the desktop PTY that spawned this session's CLI, back when one existed (#218). Nothing writes a non-null value anymore since the embedded terminal was removed (#345/#346); the column stays for old rows until a later migration drops it."),
  brief: z.string().nullable().optional().describe("The task as given (runner batch): the first user message on a fresh run."),
  runner: z.string().nullable().optional().describe("Runner adapter id (e.g. 'claude') this session's task runs under."),
  host_id: z.string().nullable().optional().describe("The device/workspace running this session's task."),
  // #375: the thread's own model/effort override. Resolution (session ->
  // instance defaults -> unset) happens once at run start, in
  // session-runtime.ts -- never here.
  model: z.string().nullable().optional().describe("The thread's own model override, or null to use the instance/runner default."),
  effort: z.string().nullable().optional().describe("The thread's own reasoning-effort override, or null to use the instance/runner default."),
});
type CreateSessionInput = z.infer<typeof CreateSessionInput>;

const ListSessionsInput = z.object({
  node_id: z.string().optional().describe("Filter: sessions anchored to this node."),
  user_id: z.string().optional().describe("Filter: sessions owned by this user."),
  state: z.enum(SESSION_STATES).optional().describe("Filter: sessions in this state."),
});
type ListSessionsInput = z.infer<typeof ListSessionsInput>;

async function loadSession(db: DbClient, id: string): Promise<SessionRow | null> {
  const res = await db.execute({ sql: "SELECT * FROM sessions WHERE id = ?", args: [id] });
  if (res.rows.length === 0) return null;
  return SessionRow.parse(res.rows[0]);
}

// Default session name -- spec ("Naming & UI"): "Default name `node · date`",
// extended with a time-of-day component (#272) so two sessions opened on the
// same node on the same day are still distinguishable at a glance in the
// Relace list -- the date-only format made every same-day row on a node
// literally identical text. `node` is the anchor's name, or 'Chat' for the
// anchor-less interactive_chat type. `createdAtIso` is sliced into its date
// (chars 0-10) and HH:MM (chars 11-16) parts.
//
// migration 028's SQL backfill predates this and stays date-only by design
// (existing rows are never rewritten) -- an old row's default-shaped name
// (no time component) and a new row's (with time) are both valid, just from
// different eras; do not "fix" old rows to match.
export function computeDefaultSessionName(nodeName: string | null, createdAtIso: string): string {
  const date = createdAtIso.slice(0, 10);
  const time = createdAtIso.slice(11, 16);
  return `${nodeName ?? "Chat"} · ${date} ${time}`;
}

const THREAD_NAME_MAX_LENGTH = 60;

// A thread names itself from its first message (#374, "Naming"): first
// line, trimmed, whitespace collapsed, cut at ~60 characters on a word
// boundary with an ellipsis. Mirrors apps/web/src/lib/session-chat.ts's
// threadNameFromFirstMessage exactly -- duplicated rather than imported
// across the server/web boundary, same reason that file's CanonicalEvent
// mirrors domain/runner/types.ts's own. Used only when promoting a draft
// (session-runtime.ts's promoteDraftAndStart); computeDefaultSessionName
// above stays the name for anything with no first message to derive one
// from (interactive_chat).
export function threadNameFromFirstMessage(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  const collapsed = firstLine.trim().replace(/\s+/g, " ");
  if (collapsed.length <= THREAD_NAME_MAX_LENGTH) return collapsed;
  const truncated = collapsed.slice(0, THREAD_NAME_MAX_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut}…`;
}

// preassignedId (#208 follow-up, runner batch Rule 2 "the session exists
// before the runner"): when the caller already minted this session's id
// before the row existed -- session-runtime.ts's startTask creates the row
// first, then starts a run whose own MCP connection carries that id via
// X-Portuni-Spawn-Id -- pass it here so the domain id matches instead of
// minting a second, unrelated one. Not part of CreateSessionInput's zod
// schema: that type also shapes any future MCP-exposed session-creation
// input, and a self-declared id there would violate "derived by the server,
// never self-declared". Only bindSessionPersistence (mcp/session-
// persistence.ts) supplies it, sourced from a header the server itself
// threads through, never from raw client input.
export async function createSession(
  db: DbClient,
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
    sql: `INSERT INTO sessions (id, node_id, user_id, session_type, cli, instance_id, agent_session_id, terminal_id, brief, runner, host_id, model, effort, state, name, created_at, last_active_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    args: [
      id,
      parsed.node_id,
      userId,
      parsed.session_type,
      parsed.cli ?? null,
      parsed.instance_id ?? null,
      parsed.agent_session_id ?? null,
      parsed.terminal_id ?? null,
      parsed.brief ?? null,
      parsed.runner ?? null,
      parsed.host_id ?? null,
      parsed.model ?? null,
      parsed.effort ?? null,
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

// A thread is a session row from the moment it opens (#374, "the session
// row exists from the moment the thread opens"): no brief, no runner, no
// run -- just a name, a node, an owner. The first message (session-
// runtime.ts's sendMessage) promotes it to 'running' and starts the run.
export async function createDraftSession(
  db: DbClient,
  userId: string,
  nodeId: string,
  overrides: { model?: string | null; effort?: string | null; runner?: string | null; instance_id?: string | null } = {},
): Promise<SessionRow> {
  const id = ulid();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO sessions (id, node_id, user_id, session_type, state, name, model, effort, runner, instance_id, created_at, last_active_at)
          VALUES (?, ?, ?, 'interactive_task', 'draft', ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      nodeId,
      userId,
      "Nový úkol",
      overrides.model ?? null,
      overrides.effort ?? null,
      overrides.runner ?? null,
      overrides.instance_id ?? null,
      now,
      now,
    ],
  });

  await writeAudit(db, userId, "session_create", "session", id, { node_id: nodeId, draft: true });

  const row = await loadSession(db, id);
  if (!row) throw new Error(`createDraftSession: inserted row ${id} not found`);
  return row;
}

// Prune (#374, "Storage: Prune"): a draft has no runs, no events and no
// handoff, so removing it is a single DELETE, not an archive -- unlike
// every other terminal state, which is a view filter. Refuses a
// non-draft: closing a real thread goes through transitionSessionState,
// never this.
export async function deleteDraftSession(db: DbClient, actorUserId: string, sessionId: string): Promise<void> {
  const existing = await loadSession(db, sessionId);
  if (!existing) throw new Error(`deleteDraftSession: ${sessionId} not found`);
  if (existing.state !== "draft") {
    throw new Error(`deleteDraftSession: session ${sessionId} is not a draft (state: ${existing.state})`);
  }
  await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [sessionId] });
  await writeAudit(db, actorUserId, "session_delete", "session", sessionId, { was_draft: true });
}

const DEFAULT_DRAFT_PRUNE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

// Boot sweep (#374): a draft abandoned without ever sending a first message
// (the thread's tab/window closed without an explicit Uzavřít, or simply
// forgotten) has no other cleanup path -- Uzavřít-while-empty is the other
// one, handled at the call site that already knows the thread is empty.
export async function pruneStaleDraftSessions(
  db: DbClient,
  olderThanMs: number = DEFAULT_DRAFT_PRUNE_AFTER_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const res = await db.execute({
    sql: "DELETE FROM sessions WHERE state = 'draft' AND created_at < ?",
    args: [cutoff],
  });
  return res.rowsAffected;
}

// Rename a session -- spec: "always renamable". Marks name_is_custom so a
// later suspend (session-handoff.ts's title enrichment) never overwrites a
// deliberate human choice.
export async function renameSession(
  db: DbClient,
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

export async function getSession(db: DbClient, id: string): Promise<SessionRow | null> {
  return loadSession(db, id);
}

// Authorization gate for resume (#204: "resume_session_id has no ownership/
// anchor check"). A caller-supplied resume_session_id must never be trusted
// on its own: it must belong to the caller, be anchored to the node the
// caller is actually resuming into, and be in the one state resume is valid
// from. Used by the graph-plane resume (mcp/session-persistence.ts). Mirrors
// api/sessions.ts's loadOwnSession plus the anchor/state checks resume
// specifically needs.
export async function loadResumableSession(
  db: DbClient,
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
  db: DbClient,
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
export async function touchSession(db: DbClient, id: string): Promise<void> {
  await db.execute({
    sql: "UPDATE sessions SET last_active_at = ? WHERE id = ?",
    args: [new Date().toISOString(), id],
  });
}

// Rule 2 (runner-and-session-design spec): a fresh MCP connection whose
// X-Portuni-Spawn-Id names an existing, running, own session BINDS to that
// row instead of creating a new one (mcp/session-persistence.ts's
// bindExistingSessionPersistence). The row was created by the session
// runtime (domain/runner/store.ts's createSession, via startTask) without a
// CLI attached -- this fills it in once the handshake's own clientInfo.name
// is known, same as createSession would have done for a fresh row.
export async function setSessionCli(db: DbClient, id: string, cli: string): Promise<void> {
  await db.execute({
    sql: "UPDATE sessions SET cli = ? WHERE id = ?",
    args: [cli, id],
  });
}

// State machine. running/suspended are the live states (a session can
// bounce between them via suspend/resume, #190); closed is terminal from the
// user's point of view but auto-archives (a view filter, never a delete) as
// the only way out of closed. archived itself is terminal. draft (#374) is
// a thread before its first message: its only transition is to running (the
// first message, session-runtime.ts's sendMessage), and its only other exit
// is deletion (deleteDraftSession/pruneStaleDraftSessions), never a state
// transition -- so draft has no terminal state to transition into here.
const ALLOWED_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  draft: ["running"],
  running: ["suspended", "closed"],
  suspended: ["running", "closed"],
  closed: ["archived"],
  archived: [],
};

export async function transitionSessionState(
  db: DbClient,
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

// Where the two suspends below run. On the central server (#458) there is
// no content to summarise and no run to end: a task thread's run lives on
// the device that drives it, and only that device's own run end or boot
// sweep suspends it. Overridable for tests; defaults to the process's role.
export interface ServerSideSuspendOptions {
  central?: boolean;
}

// A thread some device drives: a runner task (runner set) or one with a run
// still open. Neither the central server nor the device itself ends such a
// thread on an MCP transport closing -- a dropped connection, or the
// central server restarting, says nothing about the run on the device.
// What is left is a hand-opened CLI or a connector session whose only life
// was its MCP connection to this process.
async function isDeviceDrivenSession(db: DbClient, row: { id: string; runner: string | null }): Promise<boolean> {
  if (row.runner !== null) return true;
  const open = await db.execute({
    sql: "SELECT 1 FROM session_runs WHERE session_id = ? AND ended_at IS NULL LIMIT 1",
    args: [row.id],
  });
  return open.rows.length > 0;
}

// The central server's suspend: record only, no summary (#458: it holds no
// transcript to build one from, and never opens a content.db), and never
// for a thread a device drives. Returns whether the row was suspended.
async function suspendRecordOnCentral(db: DbClient, sessionId: string): Promise<boolean> {
  const row = await loadSession(db, sessionId);
  if (row?.state !== "running") return false;
  if (await isDeviceDrivenSession(db, row)) return false;
  await transitionSessionState(db, row.user_id, sessionId, "suspended");
  return true;
}

// GC backstop (#218): called from mcp/transport.ts's onclose, for a crash
// that never reaches a graceful close, a genuine client disconnect, or the
// transport's own 30-minute idle GC force-closing it. Suspends (#329;
// previously closed) the session iff it is still 'running' -- an
// already-suspended session (the agent's own portuni_session_suspend
// already ran) is untouched either way, since suspendSessionServerSide only
// acts on 'running'. On a device a thin wrapper around
// suspendSessionServerSide (domain/session-handoff.ts); on the central
// server suspendRecordOnCentral above. Neither branch touches a thread a
// device drives (isDeviceDrivenSession) -- #487.
export async function closeSessionIfRunning(
  db: DbClient,
  sessionId: string,
  reason: ServerHandoffReason,
  opts: ServerSideSuspendOptions = {},
): Promise<void> {
  if (opts.central ?? isCentralServer()) {
    await suspendRecordOnCentral(db, sessionId);
    return;
  }
  // #487: the same rule the central branch has always had, on the device
  // too. A transport closing -- the client dropping, or the transport's own
  // 30-minute idle GC reaping a connection the agent simply had not called a
  // Portuni tool over -- says nothing about a thread the runner drives: the
  // agent process is alive, its run is open, and the user is still working
  // in it. Only the runtime ends such a thread (idle with no turn in flight,
  // a provider error or limit, a restart's boot sweep). Leaving the row
  // 'running' is also what lets the agent's MCP client reconnect to it:
  // mcp/session-persistence.ts's lookupSpawnSessionForBind refuses a spawn
  // id whose row is no longer running (SESSION_BIND_REFUSED), so suspending
  // here used to cost a live agent its Portuni tools for good.
  const row = await loadSession(db, sessionId);
  if (row?.state !== "running") return;
  if (await isDeviceDrivenSession(db, row)) return;
  await suspendSessionServerSide(db, sessionContentStoreForProcess(), sessionId, reason);
}

// Boot sweep (#272): a 'running' row can survive a process restart (app
// quit, crash, central redeploy) that never reached the graceful close path
// (mcp/transport.ts's onclose / closeSessionIfRunning) -- at process start
// there is no live transport that could possibly own any of these
// connections anymore, so every 'running' row left over from a previous
// life is stale by definition. Suspends (#329; previously closed) each one
// with a server-generated handoff, so a session interrupted only by a
// restart stays resumable. Not scoped to a single user: this is a
// process-wide maintenance sweep, same as autoArchiveClosedSessions above.
// On the central server (#458) it is record maintenance only: the rows it
// suspends are the MCP-connection sessions that died with the process, with
// no summary, and a thread a device drives stays `running` until that
// device's own boot sweep ends it.
export async function suspendStaleRunningSessionsOnBoot(
  db: DbClient,
  opts: ServerSideSuspendOptions = {},
): Promise<number> {
  const res = await db.execute({ sql: "SELECT id, user_id FROM sessions WHERE state = 'running'" });
  if (opts.central ?? isCentralServer()) {
    let suspended = 0;
    for (const row of res.rows) {
      if (await suspendRecordOnCentral(db, String(row.id))) suspended++;
    }
    return suspended;
  }
  for (const row of res.rows) {
    await suspendSessionServerSide(db, sessionContentStoreForProcess(), String(row.id), "boot_sweep");
  }
  return res.rows.length;
}

// Auto-archive closed sessions older than the given age -- a view filter
// (list/UI default to hiding archived), never a delete: the durable record,
// audit trail, and handoff outlive any CLI's own transcript retention by
// design. No per-row audit entry -- this is a housekeeping sweep, not a user
// action, so it would just add audit-log noise proportional to session
// volume without a corresponding actor to attribute it to.
const DEFAULT_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Retention for session_events (runner batch, #317): the event log of an
// archived session is dropped once closed_at is older than this -- the
// session row, its runs, audit trail and handoff file all stay.
const DEFAULT_EVENTS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export async function autoArchiveClosedSessions(
  db: DbClient,
  olderThanMs: number = DEFAULT_ARCHIVE_AFTER_MS,
  eventsRetentionMs: number = DEFAULT_EVENTS_RETENTION_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const res = await db.execute({
    sql: "UPDATE sessions SET state = 'archived' WHERE state = 'closed' AND closed_at IS NOT NULL AND closed_at < ?",
    args: [cutoff],
  });
  const eventsCutoff = new Date(Date.now() - eventsRetentionMs).toISOString();
  await db.execute({
    sql: `DELETE FROM session_events
           WHERE session_id IN (
             SELECT id FROM sessions WHERE state = 'archived' AND closed_at IS NOT NULL AND closed_at < ?
           )`,
    args: [eventsCutoff],
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
  db: DbClient,
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
  db: DbClient,
  sessionId: string,
  nodeId: string,
): Promise<void> {
  await db.execute({
    sql: "UPDATE session_scope SET writable = 1 WHERE session_id = ? AND node_id = ?",
    args: [sessionId, nodeId],
  });
}

export async function getSessionScope(db: DbClient, sessionId: string): Promise<SessionScopeRow[]> {
  const res = await db.execute({
    sql: "SELECT * FROM session_scope WHERE session_id = ? ORDER BY added_at",
    args: [sessionId],
  });
  return res.rows.map((r) => SessionScopeRow.parse(r));
}

// Nodes this user's connector (interactive_chat) sessions created, i.e.
// session_scope rows a connector session persisted as added_via='created'
// AND writable=1 -- the durable form of "a node created by the session
// enters its write set" (spec, "Read scope") for the one session type that
// has no anchor and no resume path. A connector client (claude.ai web /
// mobile) reopens its MCP session constantly (every reconnect, the 30-min
// idle GC in mcp/transport.ts, a server restart), so an in-memory-only
// grant was gone by the time the user asked to attach a file to the node
// they had just created -- and the fallback, portuni_expand_scope with
// writable: true, is refused on such a client (no elicitation capability).
// Consumed by mcp/session-persistence.ts's rehydrateConnectorWriteGrants,
// which re-persists the grant under the new session as 'created' again, so
// the chain survives any number of reconnects. Joined on nodes so a node
// deleted since simply drops out; visibility is the caller's job (the
// creating user could since have lost access via a visibility change).
export async function listConnectorCreatedWritableNodes(db: DbClient, userId: string): Promise<string[]> {
  const res = await db.execute({
    // GROUP BY rather than SELECT DISTINCT: Postgres refuses to order a
    // DISTINCT projection by a column that is not itself selected, and the
    // node must appear once even when several connector sessions created
    // it. MIN(added_at) is then the first time any of them did.
    sql: `SELECT ss.node_id
          FROM session_scope ss
          JOIN sessions s ON s.id = ss.session_id
          JOIN nodes n ON n.id = ss.node_id
          WHERE s.user_id = ? AND s.session_type = 'interactive_chat'
            AND ss.added_via = 'created' AND ss.writable = 1
          GROUP BY ss.node_id
          ORDER BY MIN(ss.added_at)`,
    args: [userId],
  });
  return res.rows.map((r) => r.node_id as string);
}

// "Write count" for the node-detail sessions row (spec, "Naming & UI": "Row
// shows state, last activity, CLI + profile, write count") -- the size of
// the session's write set (session_scope rows with writable=1), not a count
// of write operations: no per-write audit trail keyed by session exists yet,
// while the write set itself is already tracked here and is a reasonable,
// honest proxy ("how much can/did this session write to").
export async function getSessionWriteCount(db: DbClient, sessionId: string): Promise<number> {
  const res = await db.execute({
    sql: "SELECT COUNT(*) AS c FROM session_scope WHERE session_id = ? AND writable = 1",
    args: [sessionId],
  });
  return Number(res.rows[0].c);
}

// The host of the session's latest run that names one (#428). The session
// row carries a host too, but it is the host the session was *created* for;
// a thread resumed on another machine has its truth on the run. Null when no
// run names a host -- an old row, a draft, or a hand-opened CLI session.
export async function getLatestRunHostId(db: DbClient, sessionId: string): Promise<string | null> {
  const res = await db.execute({
    sql: `SELECT host_id FROM session_runs
          WHERE session_id = ? AND host_id IS NOT NULL
          ORDER BY started_at DESC, id DESC
          LIMIT 1`,
    args: [sessionId],
  });
  if (res.rows.length === 0) return null;
  const host = res.rows[0].host_id;
  return typeof host === "string" && host.length > 0 ? host : null;
}

// --- Suspend (phase 2, "Lifecycle" / "Handoff") ---

export interface SuspendSessionInput {
  // Null when there is nowhere on this device to write a file (#329:
  // suspendSessionServerSide on a session with no local mirror) -- the
  // handoff text then goes into the device content store's
  // handoff_inline instead (#456), never onto the record.
  handoffPath: string | null;
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
  db: DbClient,
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
  const enrichedName = handoffEnrichedName(existing, input.handoffTitle ?? null);
  await db.execute({
    sql: `UPDATE sessions
             SET state = 'suspended', handoff_path = ?, handoff_hash = ?, handoff_inline = NULL,
                 agent_session_id = COALESCE(?, agent_session_id), last_active_at = ?, name = ?
           WHERE id = ?`,
    // handoff_inline is content and lives on the device now (#456); the
    // column stays on the record until the central migration (#462) and is
    // cleared here so no stale copy survives a re-suspend.
    args: [
      input.handoffPath,
      input.handoffHash,
      input.agentSessionId ?? null,
      now,
      enrichedName,
      sessionId,
    ],
  });

  await writeAudit(db, actorUserId, "session_suspend", "session", sessionId, {
    handoff_path: input.handoffPath,
    handoff_hash: input.handoffHash,
  });

  const row = await loadSession(db, sessionId);
  if (!row) throw new Error(`suspendSession: row ${sessionId} disappeared after UPDATE`);
  return row;
}
