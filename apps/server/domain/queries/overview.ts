// Read projections for the Přehled (overview) tab (phase 4 of
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md,
// "Přehled (overview tab)"). Pure: takes a libsql Client, no HTTP/MCP
// coupling, no permission filtering -- that happens in api/overview.ts,
// same split as loadGraph/GET /graph.
//
// Each query returns its rows unfiltered; the REST handler drops rows on
// nodes the caller cannot see via filterVisibleNodeIds. Caps below are
// generous but finite -- this is a dashboard, not an export.

import type { Client } from "@libsql/client";
import type {
  OverviewAttentionNode,
  OverviewDisconnectedJump,
  OverviewEvent,
  OverviewNewNode,
  OverviewSessionRow,
  OverviewSessionWrite,
  OverviewSyncIssue,
} from "../../shared/api-types.js";

export async function loadOverviewSessions(
  db: Client,
): Promise<OverviewSessionRow[]> {
  const res = await db.execute({
    sql: `SELECT s.*, n.name AS node_name, n.type AS node_type
            FROM sessions s
            LEFT JOIN nodes n ON n.id = s.node_id
           WHERE s.state IN ('running', 'suspended')
           ORDER BY s.last_active_at DESC
           LIMIT 100`,
  });
  return res.rows.map((row) => ({
    id: row.id as string,
    node_id: row.node_id as string | null,
    node_name: (row.node_name as string | null) ?? null,
    node_type: (row.node_type as string | null) ?? null,
    user_id: row.user_id as string,
    session_type: row.session_type as OverviewSessionRow["session_type"],
    cli: row.cli as string | null,
    profile_id: row.profile_id as string | null,
    state: row.state as OverviewSessionRow["state"],
    name: row.name as string,
    name_is_custom: row.name_is_custom === 1,
    handoff_path: row.handoff_path as string | null,
    created_at: row.created_at as string,
    last_active_at: row.last_active_at as string,
    closed_at: row.closed_at as string | null,
  }));
}

// Headless review queue: nodes a headless session reached only via search,
// no edge path -- server-classified at scope-expansion time
// (session_scope.added_via = 'disconnected'), never agent-claimed. See
// "Read scope" in the design spec.
export async function loadOverviewDisconnectedJumps(
  db: Client,
): Promise<OverviewDisconnectedJump[]> {
  const res = await db.execute({
    sql: `SELECT ss.session_id, s.name AS session_name, ss.node_id,
                 n.name AS node_name, n.type AS node_type, ss.reason, ss.added_at
            FROM session_scope ss
            JOIN sessions s ON s.id = ss.session_id
            JOIN nodes n ON n.id = ss.node_id
           WHERE ss.added_via = 'disconnected' AND s.session_type = 'headless'
           ORDER BY ss.added_at DESC
           LIMIT 50`,
  });
  return res.rows.map((row) => ({
    session_id: row.session_id as string,
    session_name: row.session_name as string,
    node_id: row.node_id as string,
    node_name: row.node_name as string,
    node_type: row.node_type as string,
    reason: row.reason as string | null,
    added_at: row.added_at as string,
  }));
}

// "Vyžaduje pozornost": processes at_risk|broken, areas needs_attention,
// projects with health != on_track (spec, "Přehled (overview tab)").
// Organization and principle carry no attention state, so they never
// appear here.
export async function loadOverviewAttentionNodes(
  db: Client,
): Promise<OverviewAttentionNode[]> {
  const res = await db.execute({
    sql: `SELECT id, type, name, lifecycle_state, health
            FROM nodes
           WHERE (type = 'process' AND lifecycle_state IN ('at_risk', 'broken'))
              OR (type = 'area' AND lifecycle_state = 'needs_attention')
              OR (type = 'project' AND health != 'on_track')
           ORDER BY updated_at DESC
           LIMIT 100`,
  });
  return res.rows.map((row) => ({
    id: row.id as string,
    type: row.type as string,
    name: row.name as string,
    lifecycle_state: row.lifecycle_state as string | null,
    health: row.health as string,
  }));
}

// Sync "issues needing attention". There is no server-persisted "conflict"
// concept: file sync state (clean/push/pull/conflict/...) is computed live
// on-device by scanning the local mirror against Turso, and lives only in
// the per-device sync.db -- never in Turso, so it cannot be aggregated
// workspace-wide from the server. pending_file_ops (a Turso table: queued
// move/rename/delete ops, retried idempotently on the next sync run) is the
// closest thing the server can see: a row with last_error set is a stuck
// op that has failed at least one retry, a genuine signal something needs a
// human look, even though it is not the "two versions conflict" sense of
// the word.
export async function loadOverviewSyncIssues(
  db: Client,
): Promise<OverviewSyncIssue[]> {
  const res = await db.execute({
    sql: `SELECT p.id, p.node_id, n.name AS node_name, p.file_id, p.last_error, p.updated_at
            FROM pending_file_ops p
            JOIN nodes n ON n.id = p.node_id
           WHERE p.last_error IS NOT NULL
           ORDER BY p.updated_at DESC
           LIMIT 50`,
  });
  return res.rows.map((row) => ({
    id: row.id as string,
    node_id: row.node_id as string,
    node_name: row.node_name as string,
    file_id: row.file_id as string,
    last_error: row.last_error as string,
    updated_at: row.updated_at as string,
  }));
}

export async function loadOverviewEvents(db: Client): Promise<OverviewEvent[]> {
  const res = await db.execute({
    sql: `SELECT e.id, e.node_id, n.name AS node_name, n.type AS node_type,
                 e.type, e.content, e.created_at
            FROM events e
            JOIN nodes n ON n.id = e.node_id
           WHERE e.status = 'active'
           ORDER BY e.created_at DESC
           LIMIT 30`,
  });
  return res.rows.map((row) => ({
    id: row.id as string,
    node_id: row.node_id as string,
    node_name: row.node_name as string,
    node_type: row.node_type as string,
    type: row.type as string,
    content: row.content as string,
    created_at: row.created_at as string,
  }));
}

// "Recent session writes": session_scope rows added to a session's write
// set, most recent first. Not a per-write-operation audit log (none exists
// yet) -- the write-set membership itself, same honest proxy as
// getSessionWriteCount in domain/sessions.ts.
export async function loadOverviewSessionWrites(
  db: Client,
): Promise<OverviewSessionWrite[]> {
  const res = await db.execute({
    sql: `SELECT ss.session_id, s.name AS session_name, ss.node_id,
                 n.name AS node_name, ss.added_at
            FROM session_scope ss
            JOIN sessions s ON s.id = ss.session_id
            JOIN nodes n ON n.id = ss.node_id
           WHERE ss.writable = 1
           ORDER BY ss.added_at DESC
           LIMIT 30`,
  });
  return res.rows.map((row) => ({
    session_id: row.session_id as string,
    session_name: row.session_name as string,
    node_id: row.node_id as string,
    node_name: row.node_name as string,
    added_at: row.added_at as string,
  }));
}

export async function loadOverviewNewNodes(db: Client): Promise<OverviewNewNode[]> {
  const res = await db.execute({
    sql: `SELECT n.id, n.type, n.name, n.created_at, u.name AS created_by_name
            FROM nodes n
            JOIN users u ON u.id = n.created_by
           ORDER BY n.created_at DESC
           LIMIT 20`,
  });
  return res.rows.map((row) => ({
    id: row.id as string,
    type: row.type as string,
    name: row.name as string,
    created_at: row.created_at as string,
    created_by_name: row.created_by_name as string,
  }));
}
