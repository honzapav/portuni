// REST endpoints for persistent sessions and, since the runner batch
// (docs/superpowers/specs/2026-09-12-runner-and-session-design.md), for
// tasks: starting one, driving its live run, and reading its event log.
//
//   GET   /nodes/:id/sessions              read    -> node's sessions, newest-active first
//   GET   /sessions/:id                    read    -> single session record
//   PATCH /sessions/:id                    write   -> rename, or (central record half, #323)
//                                                      state/waiting_since/handoff_* (owner only)
//   POST  /sessions/:id/state              write   -> state transition (owner or manage)
//   POST  /sessions/:id/rename             write   -> rename through the runtime (owner only);
//                                                      publishes the change to the live channel
//   GET   /sessions/:id/resume-info        read    -> conversation-resumable? handoff changed?
//   GET   /sessions/:id/signals            read    -> restart indicator (run age, read/write set)
//   GET   /sessions/:id/scope              read    -> central record half (#427): the session's
//                                                      read/write set by node id, for the sync
//                                                      agent's own suspend fallback
//   POST  /sessions                        write   -> start a task (session + first run)
//   POST  /sessions/record                 write   -> central record half (#323): create the row
//                                                      only, no run -- the agent-mode sidecar's own
//                                                      CentralSessionStore is the only caller
//   POST  /sessions/:id/messages           write   -> send a chat message (owner only) --
//                                                      also what promotes a draft or resumes
//                                                      a suspended thread; there is no
//                                                      separate resume call (#378)
//   POST  /sessions/:id/questions/:req_id  write   -> answer an open question (owner only)
//   POST  /sessions/:id/interrupt          write   -> cancel the current turn only (owner or
//                                                      manage) -- the run stays live (#378)
//   POST  /sessions/:id/continue           write   -> close this session, start a new one on
//                                                      the same node seeded with its summary
//                                                      (owner only; #378)
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
  deleteDraftSession,
  getLatestRunHostId,
  getSession,
  getSessionScope,
  getSessionWriteCount,
  listSessions,
  renameSession,
  transitionSessionState,
} from "../domain/sessions.js";
import { getResumeInfo } from "../domain/session-handoff.js";
import { getMirrorPath } from "../domain/sync/mirror-registry.js";
import { logAudit } from "../infra/audit.js";
import { getSessionRuntime } from "../boot/session-runtime.js";
import { NoRunnerAvailableError } from "../domain/runner/session-runtime.js";
import { getAdapter } from "../domain/runner/registry.js";
import { getInstanceEnv } from "../domain/runner/instances.js";
import { resolveHostLabel } from "../domain/runner/hosts.js";
import { DbSessionStore } from "../domain/runner/store.js";
import { EFFORT_LEVELS, type CanonicalEvent, type QuestionDecision } from "../domain/runner/types.js";
import { SESSION_STATES, type SessionRow, type SessionState } from "../shared/types.js";
import type { SessionResumeInfo, SessionScopeRecord, SessionSummary } from "../shared/api-types.js";

export async function toSummary(row: SessionRow): Promise<SessionSummary> {
  // #428: the host is the latest run's, not the session row's -- the row's
  // own is where the thread started, the run's is where it last ran. Both
  // Relace rows and the chat header read it off the summary, so neither
  // needs a per-row GET /sessions/:id/runs.
  const db = getDb();
  const hostId = (await getLatestRunHostId(db, row.id)) ?? row.host_id;
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
    host_id: hostId,
    host_label: resolveHostLabel(hostId),
    waiting_since: row.waiting_since,
    state: row.state,
    name: row.name,
    name_is_custom: row.name_is_custom === 1,
    handoff_path: row.handoff_path,
    write_count: await getSessionWriteCount(db, row.id),
    model: row.model,
    effort: row.effort,
    context_used_tokens: row.context_used_tokens,
    context_max_tokens: row.context_max_tokens,
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
      // A draft is visible only to its owner, regardless of node
      // visibility (#463): it is not a thread yet, just another window's
      // in-progress compose.
      if (row.state === "draft") continue;
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
    // A draft (#374) is visible only to the caller who is composing it
    // (#463): another window of the same user sees it too, but it never
    // leaks into another user's sidebar.
    rows = rows.filter((r) => r.state !== "draft" || r.user_id === identity.userId);
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
    // #434: the suspend fallback's summary when this device had no mirror
    // to write a handoff file into -- the same column the local half
    // (suspendSession) writes, so a team-workspace suspend without a
    // mirror resumes from the summary exactly as a personal one does.
    handoff_inline: z.string().nullable().optional(),
    // Set together with state: "running" when a draft is promoted by its
    // first message (#374's CentralSessionStore.patchSession, in agent
    // mode, forwards these here).
    brief: z.string().optional(),
    runner: z.string().optional(),
    instance_id: z.string().nullable().optional(),
    name_is_custom: z.boolean().optional(),
    // #375: the thread's own model/effort override.
    model: z.string().nullable().optional(),
    effort: z.enum(EFFORT_LEVELS).nullable().optional(),
    // v2 context ring: the runtime folds each context_usage event here
    // (CentralSessionStore.patchSession in a team workspace).
    context_used_tokens: z.number().int().nullable().optional(),
    context_max_tokens: z.number().int().nullable().optional(),
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
    // v2 rule 5: runner and instance are the thread's, chosen while it is
    // a draft. The promotion patch sets them together with state:
    // "running" and passes; a bare change on any other state is refused.
    const touchesRunner = body.runner !== undefined || body.instance_id !== undefined;
    if (touchesRunner && existing.state !== "draft" && body.state === undefined) {
      respondJson(res, 409, { error: "runner and instance can only change on a draft", code: "SESSION_NOT_DRAFT" });
      return;
    }
    // #426: the live half of a model change (session-runtime.ts's in-memory
    // liveRuns) belongs to POST /sessions/:id/model, which the desktop
    // routes to the device driving the run; this route is the record half
    // only -- in sync-agent mode it IS central, where no run ever lives, so
    // calling setModel here could never reach one.
    // Central record half (#323): raw SessionRow, same reasoning as
    // handleGetSession above -- the caller is CentralSessionStore, which
    // needs every column back, not the curated summary.
    const updated = await new DbSessionStore(db).patchSession(sessionId, {
      name: body.name,
      state: body.state,
      waiting_since: body.waiting_since,
      handoff_path: body.handoff_path,
      handoff_hash: body.handoff_hash,
      handoff_inline: body.handoff_inline,
      brief: body.brief,
      runner: body.runner,
      instance_id: body.instance_id,
      name_is_custom: body.name_is_custom,
      model: body.model,
      effort: body.effort,
      context_used_tokens: body.context_used_tokens,
      context_max_tokens: body.context_max_tokens,
    });
    respondJson(res, 200, updated);
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}`, err);
  }
}

// #426: the thread's model/effort override. A device-local route
// (apps/server/shared/device-local-routes.json): the live half of a model
// change only exists in the process that drives the run, which in a team
// workspace is this device's sync agent, never the central server -- so the
// desktop sends it here and the record half rides along through the
// runtime's own store (DbSessionStore locally, CentralSessionStore in
// sync-agent mode). `effort` carries the same way but has no live setter,
// so for it this is a plain column write that the next run reads.
export const SetSessionModelBody = z
  .object({
    model: z.string().nullable().optional(),
    effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "model or effort is required");

export async function handleSetSessionModel(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "message");
    if (!existing) return;
    const body = await parseJsonBody(req, res, SetSessionModelBody);
    if (!body) return;
    const updated = await getSessionRuntime().setModelAndEffort(sessionId, body);
    respondJson(res, 200, updated);
  } catch (err) {
    respondError(res, `POST /sessions/${sessionId}/model`, err);
  }
}

// The thread's rename. A device-local route (device-local-routes.json) so
// it goes through the session runtime, which publishes the change to the
// live channel; a bare PATCH /sessions/:id writes the row and nothing else
// learns of it. Owner-only, same tier the PATCH rename has.
export const RenameSessionBody = z.object({
  name: z.string().trim().min(1, "name is required"),
});

export async function handleRenameSession(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "message");
    if (!existing) return;
    const body = await parseJsonBody(req, res, RenameSessionBody);
    if (!body) return;
    const updated = await getSessionRuntime().renameSession(sessionId, body.name);
    await logAudit(identity.userId, "session_rename", "session", sessionId, { from: existing.name, to: updated.name });
    respondJson(res, 200, await toSummary(updated));
  } catch (err) {
    respondError(res, `POST /sessions/${sessionId}/rename`, err);
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

// #427: the session's persisted scope, by node id, plus the anchor node's
// name -- everything domain/session-handoff.ts's local suspend path reads
// off the graph db to fill a summary's "Zápisový rozsah" / "Čtecí rozsah"
// sections. A sync agent has neither table, so its suspend fallback
// (domain/runner/suspend-fallback-central.ts) reads them here instead of
// writing an empty-scope summary. A pure read of the record half, so it
// follows the same read-tier gate resume-info and signals do.
export async function handleGetSessionScope(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "read");
    if (!existing) return;
    const scope = await getSessionScope(db, sessionId);
    const payload: SessionScopeRecord = {
      session_id: existing.id,
      node_name: existing.node_id ? await sessionNodeName(db, existing.node_id) : null,
      write_set: scope.filter((s) => s.writable === 1).map((s) => s.node_id),
      read_set: scope.map((s) => s.node_id),
    };
    respondJson(res, 200, payload);
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/scope`, err);
  }
}

async function sessionNodeName(db: DbClient, nodeId: string): Promise<string | null> {
  const res = await db.execute({ sql: "SELECT name FROM nodes WHERE id = ?", args: [nodeId] });
  return res.rows.length > 0 ? String(res.rows[0].name) : null;
}

// --- Tasks (runner batch): starting a session's task and driving its run --

// Shared with api/agent-router.ts's POST /sessions: one schema, both routers.
// brief/runner optional (#374): a thread opens empty (spec rule 5, "no
// modal, no required field") -- omitting brief creates a draft instead of
// starting a task; runner is validated as required only in that case
// (a plain zod .optional() cannot express "required together").
export const StartSessionBody = z.object({
  node_id: z.string().min(1),
  brief: z.string().trim().min(1).optional(),
  runner: z.string().min(1).optional(),
  instance_id: z.string().min(1).nullable().optional(),
  policy: z.enum(["default", "auto"]).optional(),
  // #375: the thread's own model/effort override.
  model: z.string().nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
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

    if (body.brief === undefined) {
      // No brief yet: a draft, not a task -- the first message
      // (POST /sessions/:id/messages) promotes it. Through the runtime, not
      // createDraftSession directly, because the runtime is what resolves
      // the organisation's default runner/instance onto the row (v2 rule
      // 5); its store here is DbSessionStore, so the row still lands in
      // this db.
      const session = await getSessionRuntime().createDraft({
        userId: identity.userId,
        nodeId: body.node_id,
        model: body.model,
        effort: body.effort,
      });
      await logAudit(identity.userId, "session_start", "session", session.id, {
        node_id: body.node_id,
        draft: true,
      });
      respondJson(res, 201, { session: await toSummary(session), run: null });
      return;
    }
    if (!body.runner) {
      respondJson(res, 400, { error: "runner is required when brief is given", code: "RUNNER_REQUIRED" });
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
      model: body.model,
      effort: body.effort,
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

export async function handleDeleteSession(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "message");
    if (!existing) return;
    if (existing.state !== "draft") {
      respondJson(res, 409, { error: "only a draft session can be deleted", code: "NOT_A_DRAFT" });
      return;
    }
    await deleteDraftSession(db, identity.userId, sessionId);
    respondJson(res, 200, { deleted: true });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}`, err);
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
      if (err instanceof NoRunnerAvailableError) {
        respondJson(res, 400, { error: err.message, code: "NO_RUNNER_AVAILABLE" });
        return;
      }
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

// #378: "Pokračovat v nové session" (offered any time, beside the context
// ring) and "Navázat" (a closed thread, same call minus the prior close)
// both call this -- closes the current session (its summary is what seeds
// the new one, not the auto-summary/suspend path: this session ends up
// closed, never suspended) and starts a fresh one, running, on the same
// node. Owner-only, same tier resume used to be.
export async function handleContinueSession(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const db = getDb();
    const existing = await guardSessionAccess(res, db, identity, sessionId, "resume");
    if (!existing) return;
    const { session, run } = await getSessionRuntime().continueSession(sessionId);
    await logAudit(identity.userId, "session_continue", "session", sessionId, { new_session_id: session.id });
    respondJson(res, 200, { session: await toSummary(session), run });
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/continue`, err);
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

// Two shapes, one route: a task's record (runner known) and #374's draft
// (nothing known yet but the anchor node). A draft in central/agent mode
// has to be created here rather than device-side -- the row IS the thread,
// and central is where every other device reads it from.
const RecordSessionBody = z.union([
  z.object({
    draft: z.literal(true),
    node_id: z.string().min(1),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    // v2 rule 5: resolved on the device, recorded here.
    runner: z.string().nullable().optional(),
    instance_id: z.string().nullable().optional(),
  }),
  z.object({
    draft: z.literal(false).optional(),
    node_id: z.string().min(1),
    brief: z.string().nullable().optional(),
    runner: z.string().min(1),
    instance_id: z.string().nullable().optional(),
    host_id: z.string().nullable().optional(),
  }),
]);

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

    const store = new DbSessionStore(db);
    const session =
      body.draft === true
        ? await store.createDraft({
            node_id: body.node_id,
            user_id: identity.userId,
            model: body.model,
            effort: body.effort,
            runner: body.runner ?? null,
            instance_id: body.instance_id ?? null,
          })
        : await store.createSession({
            node_id: body.node_id,
            user_id: identity.userId,
            brief: body.brief ?? null,
            runner: body.runner,
            instance_id: body.instance_id ?? null,
            host_id: body.host_id ?? null,
          });
    await logAudit(identity.userId, "session_record", "session", session.id, {
      node_id: body.node_id,
      ...(body.draft === true ? { draft: true } : { runner: body.runner }),
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
