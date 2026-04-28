// Domain: edge mutations enforcing the organization invariant.
//
// Pure functions over a libsql Client. Both REST (src/api/edges.ts) and
// MCP (src/mcp/tools/edges.ts) call into these.

import { ulid } from "ulid";
import type { Client } from "@libsql/client";

async function writeAudit(
  db: Client,
  userId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [ulid(), userId, action, targetType, targetId, detail ? JSON.stringify(detail) : null],
  });
}

export type MoveNodeResult = {
  moved: boolean;
  edge_id: string;
  from_org_id: string;
  to_org_id: string;
};

// Disconnect an edge by id. Pre-checks the org-invariant before letting
// SQLite's trigger abort, so callers (REST and MCP) get a clean,
// actionable error instead of a 500 with an opaque "ABORT" message.
// Returns { deleted: edge_id } on success; throws Error on validation
// failure or "edge not found".
export async function disconnectEdgeById(
  db: Client,
  userId: string,
  edgeId: string,
): Promise<{ deleted: string }> {
  const existing = await db.execute({
    sql: `SELECT e.id, e.source_id, e.target_id, e.relation,
                 ns.type AS source_type, nt.type AS target_type
            FROM edges e
            JOIN nodes ns ON ns.id = e.source_id
            JOIN nodes nt ON nt.id = e.target_id
           WHERE e.id = ?`,
    args: [edgeId],
  });
  if (existing.rows.length === 0) {
    const err = new Error(`edge ${edgeId} not found`);
    (err as Error & { code?: string }).code = "EDGE_NOT_FOUND";
    throw err;
  }
  const row = existing.rows[0];
  const sourceId = row.source_id as string;
  const relation = row.relation as string;
  const sourceType = row.source_type as string;
  const targetType = row.target_type as string;

  if (relation === "belongs_to" && sourceType !== "organization" && targetType === "organization") {
    const orgCount = await db.execute({
      sql: `SELECT COUNT(*) as n FROM edges e
              JOIN nodes t ON t.id = e.target_id
             WHERE e.source_id = ?
               AND e.relation = 'belongs_to'
               AND t.type = 'organization'`,
      args: [sourceId],
    });
    const n = Number(orgCount.rows[0].n);
    if (n <= 1) {
      const err = new Error(
        `cannot remove the only belongs_to -> organization edge of node ${sourceId}; use moveNodeToOrganization to relocate it instead`,
      );
      (err as Error & { code?: string }).code = "ORG_INVARIANT";
      throw err;
    }
  }

  await db.execute({
    sql: "DELETE FROM edges WHERE id = ?",
    args: [edgeId],
  });
  await writeAudit(db, userId, "disconnect", "edge", edgeId, {
    source_id: row.source_id,
    target_id: row.target_id,
    relation,
  });
  return { deleted: edgeId };
}

// Move a non-organization node from its current organization to another by
// rebinding the existing belongs_to edge in place. The org-invariant
// triggers (prevent_multi_parent_org on INSERT, prevent_orphan_on_edge_delete
// on DELETE) only fire on INSERT/DELETE, so a single UPDATE preserves the
// "exactly one belongs_to -> organization" invariant by construction. The
// edge id stays stable, so audit history attached to the membership is
// continuous across the move.
export async function moveNodeToOrganization(
  db: Client,
  userId: string,
  nodeId: string,
  newOrgId: string,
): Promise<MoveNodeResult> {
  const nodeRes = await db.execute({
    sql: "SELECT id, type FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  if (nodeRes.rows.length === 0) {
    throw new Error(`node ${nodeId} not found`);
  }
  if (nodeRes.rows[0].type === "organization") {
    throw new Error(
      `node ${nodeId} is an organization; organizations cannot belong to another organization`,
    );
  }

  const orgRes = await db.execute({
    sql: "SELECT id, type FROM nodes WHERE id = ?",
    args: [newOrgId],
  });
  if (orgRes.rows.length === 0) {
    throw new Error(`organization ${newOrgId} not found`);
  }
  if (orgRes.rows[0].type !== "organization") {
    throw new Error(
      `target ${newOrgId} is not an organization (type: ${orgRes.rows[0].type})`,
    );
  }

  const existing = await db.execute({
    sql: `SELECT e.id, e.target_id
            FROM edges e
            JOIN nodes t ON t.id = e.target_id
           WHERE e.source_id = ?
             AND e.relation = 'belongs_to'
             AND t.type = 'organization'`,
    args: [nodeId],
  });
  if (existing.rows.length === 0) {
    throw new Error(
      `node ${nodeId} has no organization membership; integrity invariant violated`,
    );
  }
  const edgeId = existing.rows[0].id as string;
  const fromOrgId = existing.rows[0].target_id as string;

  if (fromOrgId === newOrgId) {
    return { moved: false, edge_id: edgeId, from_org_id: fromOrgId, to_org_id: newOrgId };
  }

  await db.execute({
    sql: "UPDATE edges SET target_id = ? WHERE id = ?",
    args: [newOrgId, edgeId],
  });

  await writeAudit(db, userId, "move_node", "node", nodeId, {
    edge_id: edgeId,
    from_org_id: fromOrgId,
    to_org_id: newOrgId,
  });

  return { moved: true, edge_id: edgeId, from_org_id: fromOrgId, to_org_id: newOrgId };
}
