// REST endpoint for the Přehled (overview) tab (phase 4 of
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md,
// "Přehled (overview tab)"): one aggregate, permission-filtered snapshot
// of sessions, nodes needing attention, recent activity, and new nodes.
//
//   GET /overview   read   -> OverviewPayload
//
// Every section is loaded unfiltered by domain/queries/overview.ts and
// filtered here by the caller's own node visibility (filterVisibleNodeIds,
// same split as GET /graph). `access_requests` additionally requires
// "manage" scope (matching GET /access/requests) -- a lower-scoped caller
// gets an empty array for that one field rather than a 403 for the whole
// dashboard.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { respondError, respondJson, type RequestIdentity } from "../http/middleware.js";
import { filterVisibleNodeIds } from "../auth/node-access.js";
import { scopeAtLeast } from "../auth/roles.js";
import { listVisibleRequests } from "./access-requests.js";
import {
  loadOverviewAttentionNodes,
  loadOverviewDisconnectedJumps,
  loadOverviewEvents,
  loadOverviewNewNodes,
  loadOverviewSessionWrites,
  loadOverviewSessions,
  loadOverviewSyncIssues,
} from "../domain/queries/overview.js";
import type { OverviewPayload, OverviewSessionRow } from "../shared/api-types.js";

// A workspace session anchored to a node is visible iff the node is;
// interactive_chat has no anchor (node_id null) and no shared read scope of
// its own to check against, so the safe default is to only surface it to
// its own owner rather than the whole workspace.
function filterSessions(
  rows: OverviewSessionRow[],
  identity: RequestIdentity,
  visibleNodeIds: Set<string>,
): OverviewSessionRow[] {
  return rows.filter((r) =>
    r.node_id ? visibleNodeIds.has(r.node_id) : r.user_id === identity.userId,
  );
}

export async function handleGetOverview(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    const db = getDb();

    const [
      sessionRows,
      disconnectedJumps,
      attentionNodes,
      syncIssues,
      events,
      sessionWrites,
      newNodes,
      accessRequests,
    ] = await Promise.all([
      loadOverviewSessions(db),
      loadOverviewDisconnectedJumps(db),
      loadOverviewAttentionNodes(db),
      loadOverviewSyncIssues(db),
      loadOverviewEvents(db),
      loadOverviewSessionWrites(db),
      loadOverviewNewNodes(db),
      scopeAtLeast(identity.globalScope, "manage")
        ? listVisibleRequests(db, identity, "pending")
        : Promise.resolve([]),
    ]);

    const allNodeIds = new Set<string>();
    for (const r of sessionRows) if (r.node_id) allNodeIds.add(r.node_id);
    for (const r of disconnectedJumps) allNodeIds.add(r.node_id);
    for (const r of attentionNodes) allNodeIds.add(r.id);
    for (const r of syncIssues) allNodeIds.add(r.node_id);
    for (const r of events) allNodeIds.add(r.node_id);
    for (const r of sessionWrites) allNodeIds.add(r.node_id);
    for (const r of newNodes) allNodeIds.add(r.id);
    const visible = await filterVisibleNodeIds(db, identity, [...allNodeIds]);

    const visibleSessions = filterSessions(sessionRows, identity, visible);
    const payload: OverviewPayload = {
      sessions: {
        running: visibleSessions.filter((r) => r.state === "running"),
        suspended: visibleSessions.filter((r) => r.state === "suspended"),
        disconnected_jumps: disconnectedJumps.filter((r) => visible.has(r.node_id)),
      },
      attention: {
        nodes: attentionNodes.filter((r) => visible.has(r.id)),
        access_requests: accessRequests,
        sync_issues: syncIssues.filter((r) => visible.has(r.node_id)),
      },
      activity: {
        events: events.filter((r) => visible.has(r.node_id)),
        session_writes: sessionWrites.filter((r) => visible.has(r.node_id)),
      },
      new_nodes: newNodes.filter((r) => visible.has(r.id)),
    };

    respondJson(res, 200, payload);
  } catch (err) {
    respondError(res, `${req.method} /overview`, err);
  }
}
