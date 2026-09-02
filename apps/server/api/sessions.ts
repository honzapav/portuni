// REST endpoints for persistent sessions (#192, "Naming & UI" of
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md):
// the node-detail sessions list, rename, and state transitions. The
// cross-workspace list is a later issue (Přehled tab, phase 4) -- this
// module is node-detail only, backed entirely by apps/server/domain/
// sessions.ts.
//
//   GET   /nodes/:id/sessions             read    -> node's sessions, newest-active first
//   PATCH /sessions/:id                   write   -> rename (owner only)
//   POST  /sessions/:id/state             write   -> state transition (owner only)
//   GET   /sessions/:id/resume-info       read    -> conversation-resumable? handoff changed? (owner only)
//
// Sessions have no ACL of their own: list visibility follows the anchor
// node's (nodeVisibleTo, same as events/files); the single-session mutating
// routes are scoped to the session's own user_id, matching the owner-scoped
// pattern used by device tokens (apps/server/api/auth.ts) -- a session is a
// personal work record, not a shared one.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDb } from "../infra/db.js";
import {
  parseJsonBody,
  respondError,
  respondJson,
  type RequestIdentity,
} from "../http/middleware.js";
import { nodeVisibleTo } from "../auth/node-access.js";
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
import { SESSION_STATES, type SessionRow, type SessionState } from "../shared/types.js";
import type { SessionResumeInfo, SessionSummary } from "../shared/api-types.js";

async function toSummary(row: SessionRow): Promise<SessionSummary> {
  return {
    id: row.id,
    node_id: row.node_id,
    user_id: row.user_id,
    session_type: row.session_type,
    cli: row.cli,
    profile_id: row.profile_id,
    terminal_id: row.terminal_id,
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

// Owner-only lookup shared by the single-session routes below. Returns null
// (caller responds 404) for a missing session OR one owned by someone else
// -- "not found" either way, matching handleRevokeDeviceToken's pattern:
// a session is a personal record, not something to leak the existence of.
async function loadOwnSession(identity: RequestIdentity, sessionId: string): Promise<SessionRow | null> {
  const row = await getSession(getDb(), sessionId);
  if (!row || row.user_id !== identity.userId) return null;
  return row;
}

const RenameBody = z.object({
  name: z.string().trim().min(1).max(200),
});

export async function handleRenameSession(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  sessionId: string,
): Promise<void> {
  try {
    const existing = await loadOwnSession(identity, sessionId);
    if (!existing) {
      respondJson(res, 404, { error: "session not found" });
      return;
    }
    const body = await parseJsonBody(req, res, RenameBody);
    if (!body) return;
    const updated = await renameSession(getDb(), identity.userId, sessionId, body.name);
    respondJson(res, 200, await toSummary(updated));
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
    const existing = await loadOwnSession(identity, sessionId);
    if (!existing) {
      respondJson(res, 404, { error: "session not found" });
      return;
    }
    const body = await parseJsonBody(req, res, StateBody);
    if (!body) return;
    const target: SessionState = body.state;
    try {
      const updated = await transitionSessionState(getDb(), identity.userId, sessionId, target);
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
    const existing = await loadOwnSession(identity, sessionId);
    if (!existing) {
      respondJson(res, 404, { error: "session not found" });
      return;
    }
    const mirrorRoot = existing.node_id ? await getMirrorPath(identity.userId, existing.node_id) : null;
    // config_dir (#204): the profiles registry lives in the desktop app's
    // config.json (Rust), unreachable from this server process -- the
    // caller resolves the session's profile_id to a CLAUDE_CONFIG_DIR (when
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
    };
    respondJson(res, 200, payload);
  } catch (err) {
    respondError(res, `${req.method} /sessions/${sessionId}/resume-info`, err);
  }
}
