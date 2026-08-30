// REST endpoints for the in-app "request access" flow on restricted nodes
// in `access_mode='request'` (spec: "Rezim omezeni" in
// docs/archive/specs/2026-07-04-node-sharing-design.md). A non-member who
// sees the locked chip asks for membership; a manager who can see the node
// approves (which writes a kind='user' node_access grant on the
// authoritative node of the ACL chain) or denies.
//
//   POST /nodes/:id/access/request        read    -> { id, status }
//   GET  /nodes/:id/access/requests       manage  -> pending for one node
//   GET  /access/requests?status=pending  manage  -> across visible nodes
//   GET  /access/requests/count           manage  -> { pending }
//   POST /access/requests/:id/approve     manage
//   POST /access/requests/:id/deny        manage
//
// Every manager-facing read/write is filtered by the caller's own node
// visibility (filterVisibleNodeIds / nodeVisibleTo): a manager must never
// learn that a node hidden from them exists through its request queue.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client, InStatement } from "@libsql/client";
import { ulid } from "ulid";
import { z } from "zod";
import { getDb } from "../infra/db.js";
import { logAudit } from "../infra/audit.js";
import {
  parseJsonBody,
  respondError,
  respondJson,
  type RequestIdentity,
} from "../http/middleware.js";
import {
  classifyNodeVisibility,
  filterVisibleNodeIds,
  nodeVisibleTo,
  resolveAccessChain,
} from "../auth/node-access.js";
import type { AccessRequest, AccessRequestStatus } from "../shared/api-types.js";

const RequestBody = z.object({
  message: z.string().trim().max(1000).optional(),
});

const STATUSES = new Set<AccessRequestStatus>(["pending", "approved", "denied"]);

// Base projection shared by every list/detail response: request columns
// plus the node's name/type and the requester's display data.
const SELECT_REQUESTS = `
  SELECT r.id, r.node_id, r.user_id, r.message, r.status, r.created_at, r.resolved_at, r.resolved_by,
         n.name AS node_name, n.type AS node_type,
         u.name AS user_name, u.email AS user_email, u.avatar_url AS user_avatar_url
    FROM access_requests r
    JOIN nodes n ON n.id = r.node_id
    JOIN users u ON u.id = r.user_id`;

function rowToRequest(row: Record<string, unknown>): AccessRequest {
  return {
    id: String(row.id),
    node_id: String(row.node_id),
    node_name: String(row.node_name),
    node_type: String(row.node_type),
    user_id: String(row.user_id),
    user_name: String(row.user_name),
    user_email: String(row.user_email),
    user_avatar_url: (row.user_avatar_url as string | null) ?? null,
    message: (row.message as string | null) ?? null,
    status: String(row.status) as AccessRequestStatus,
    created_at: String(row.created_at),
    resolved_at: (row.resolved_at as string | null) ?? null,
    resolved_by: (row.resolved_by as string | null) ?? null,
  };
}

async function loadRequest(db: Client, id: string): Promise<AccessRequest | null> {
  const r = await db.execute({ sql: `${SELECT_REQUESTS} WHERE r.id = ?`, args: [id] });
  return r.rows.length === 0 ? null : rowToRequest(r.rows[0] as Record<string, unknown>);
}

// Existence + visibility in one helper. See handleGetNodeAccess for why
// the existence SELECT is load-bearing: nodeVisibleTo answers true for a
// missing id (null ACL = unrestricted).
async function nodeExistsAndVisible(
  db: Client,
  identity: RequestIdentity,
  nodeId: string,
): Promise<boolean> {
  const nodeRow = await db.execute({ sql: "SELECT id FROM nodes WHERE id = ?", args: [nodeId] });
  return nodeRow.rows.length > 0 && (await nodeVisibleTo(db, identity, nodeId));
}

export async function handleRequestNodeAccess(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<void> {
  try {
    const db = getDb();
    const nodeRow = await db.execute({ sql: "SELECT id FROM nodes WHERE id = ?", args: [nodeId] });
    // classifyNodeVisibility yields "visible" for a missing id (null chain
    // = unrestricted), so existence is checked separately and folded into
    // the same 404 a hidden node gets -- a requester must not be able to
    // tell "does not exist" from "hidden from you".
    const cls = nodeRow.rows.length === 0
      ? "hidden"
      : (await classifyNodeVisibility(db, identity, [nodeId])).get(nodeId) ?? "hidden";
    if (cls === "hidden") {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    if (cls === "visible") {
      respondJson(res, 409, { error: "already_visible" });
      return;
    }

    const body = await parseJsonBody(req, res, RequestBody);
    if (!body) return;

    const pending = await db.execute({
      sql: "SELECT id FROM access_requests WHERE node_id = ? AND user_id = ? AND status = 'pending'",
      args: [nodeId, identity.userId],
    });
    if (pending.rows.length > 0) {
      respondJson(res, 409, { error: "already_pending", id: String(pending.rows[0].id) });
      return;
    }

    const id = ulid();
    const message = body.message && body.message.length > 0 ? body.message : null;
    await db.execute({
      sql: "INSERT INTO access_requests (id, node_id, user_id, message) VALUES (?, ?, ?, ?)",
      args: [id, nodeId, identity.userId, message],
    });
    await logAudit(identity.userId, "node.access.request", "node", nodeId, {
      request_id: id,
      message,
    });
    respondJson(res, 201, { id, status: "pending" });
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/access/request`, err);
  }
}

export async function handleListNodeAccessRequests(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<void> {
  try {
    const db = getDb();
    if (!(await nodeExistsAndVisible(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    const r = await db.execute({
      sql: `${SELECT_REQUESTS} WHERE r.node_id = ? AND r.status = 'pending' ORDER BY r.created_at ASC`,
      args: [nodeId],
    });
    respondJson(res, 200, {
      requests: r.rows.map((row) => rowToRequest(row as Record<string, unknown>)),
    });
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/access/requests`, err);
  }
}

// Loads requests of one status and drops those on nodes the caller cannot
// see. One chain query for the whole node set (filterVisibleNodeIds).
async function listVisibleRequests(
  db: Client,
  identity: RequestIdentity,
  status: AccessRequestStatus,
): Promise<AccessRequest[]> {
  const r = await db.execute({
    sql: `${SELECT_REQUESTS} WHERE r.status = ? ORDER BY r.created_at ASC`,
    args: [status],
  });
  const all = r.rows.map((row) => rowToRequest(row as Record<string, unknown>));
  if (all.length === 0) return all;
  const visible = await filterVisibleNodeIds(db, identity, all.map((x) => x.node_id));
  return all.filter((x) => visible.has(x.node_id));
}

export async function handleListAccessRequests(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  url: URL,
): Promise<void> {
  try {
    const raw = url.searchParams.get("status") ?? "pending";
    if (!STATUSES.has(raw as AccessRequestStatus)) {
      respondJson(res, 400, { error: "invalid status" });
      return;
    }
    const requests = await listVisibleRequests(getDb(), identity, raw as AccessRequestStatus);
    respondJson(res, 200, { requests });
  } catch (err) {
    respondError(res, `${req.method} /access/requests`, err);
  }
}

export async function handleCountAccessRequests(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    const requests = await listVisibleRequests(getDb(), identity, "pending");
    respondJson(res, 200, { pending: requests.length });
  } catch (err) {
    respondError(res, `${req.method} /access/requests/count`, err);
  }
}

export async function handleResolveAccessRequest(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  requestId: string,
  decision: "approve" | "deny",
): Promise<void> {
  try {
    const db = getDb();
    const request = await loadRequest(db, requestId);
    // A request on a node hidden from the caller is indistinguishable from
    // a missing one -- same 404 either way.
    if (!request || !(await nodeVisibleTo(db, identity, request.node_id))) {
      respondJson(res, 404, { error: "request not found" });
      return;
    }
    if (request.status !== "pending") {
      respondJson(res, 409, { error: "already_resolved", status: request.status });
      return;
    }

    const now = new Date().toISOString();
    const statements: InStatement[] = [];
    let grantedOn: string | null = null;

    if (decision === "approve") {
      // The grant must land on the node that actually owns the ACL: for a
      // node whose restriction is inherited that is the ancestor
      // (sourceNodeId), not the requested node itself -- a row on the child
      // would create a new override that narrows the child to this single
      // user and drops every inherited grantee. An unrestricted node
      // (entries === null: the ACL was cleared after the request was filed)
      // needs no grant, the requester already sees it.
      const chain = await resolveAccessChain(db, request.node_id);
      if (chain.entries !== null && chain.sourceNodeId) {
        grantedOn = chain.sourceNodeId;
        statements.push(
          {
            sql: `INSERT OR IGNORE INTO node_access (node_id, kind, principal, display_email, added_by)
                  VALUES (?, 'user', ?, NULL, ?)`,
            args: [grantedOn, request.user_id, identity.userId],
          },
          {
            // Keep nodes.visibility in step with the ACL the same way PUT
            // /nodes/:id/access derives it: a node with node_access rows
            // is a 'group' node. No-op when it already is (the common case
            // -- the node had rows for the request to be possible at all).
            sql: "UPDATE nodes SET visibility = 'group', updated_at = ? WHERE id = ? AND visibility <> 'group'",
            args: [now, grantedOn],
          },
        );
      }
    }
    statements.push({
      sql: `UPDATE access_requests SET status = ?, resolved_at = datetime('now'), resolved_by = ?
            WHERE id = ? AND status = 'pending'`,
      args: [decision === "approve" ? "approved" : "denied", identity.userId, requestId],
    });
    await db.batch(statements, "write");

    await logAudit(
      identity.userId,
      decision === "approve" ? "node.access.request.approve" : "node.access.request.deny",
      "node",
      request.node_id,
      { request_id: requestId, user_id: request.user_id, granted_on: grantedOn },
    );

    const updated = await loadRequest(db, requestId);
    respondJson(res, 200, updated ?? { id: requestId, status: decision === "approve" ? "approved" : "denied" });
  } catch (err) {
    respondError(res, `${req.method} /access/requests/${requestId}/${decision}`, err);
  }
}
