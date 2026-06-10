// Domain: edge mutations enforcing the organization invariant.
//
// Pure functions over a libsql Client. Both REST (src/api/edges.ts) and
// MCP (src/mcp/tools/edges.ts) call into these.

import type { Client } from "@libsql/client";
import { writeAudit } from "../infra/audit.js";
import { resolveNodeInfo } from "./sync/node-info.js";
import { buildNodeRoot } from "./sync/remote-path.js";
import { resolveRemote } from "./sync/routing.js";
import { getAdapter } from "./sync/adapter-cache.js";

export type MoveNodeResult = {
  moved: boolean;
  edge_id: string;
  from_org_id: string;
  to_org_id: string;
  // File migration outcome. Every tracked remote path is rooted at the
  // org sync_key, so the move rewrites them; failures stay listed here
  // (the rows keep their new path, the remote object may need a manual
  // re-run / repair).
  files_migrated: number;
  files_repair_needed: Array<{ file_id: string; error: string }>;
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
    return {
      moved: false,
      edge_id: edgeId,
      from_org_id: fromOrgId,
      to_org_id: newOrgId,
      files_migrated: 0,
      files_repair_needed: [],
    };
  }

  // Every tracked file's remote_path starts with the org sync_key
  // (org/<type-plural>/<node-key>/...), so rebinding the edge without
  // touching the files would orphan all of them: deriveLocalPath rejects
  // paths outside the new node root and new stores would split into a
  // different subtree. Plan the migration up front and refuse moves the
  // sync layer cannot carry out (different remote for the new org).
  const tracked = await db.execute({
    sql: "SELECT id, remote_name, remote_path FROM files WHERE node_id = ? AND remote_path IS NOT NULL",
    args: [nodeId],
  });

  const migration: Array<{
    file_id: string;
    remote_name: string;
    old_remote_path: string;
    new_remote_path: string;
  }> = [];
  if (tracked.rows.length > 0) {
    const oldInfo = await resolveNodeInfo(db, nodeId);
    const oldRoot = buildNodeRoot(oldInfo);
    const newOrgKeyRes = await db.execute({
      sql: "SELECT sync_key FROM nodes WHERE id = ?",
      args: [newOrgId],
    });
    const newOrgKey = newOrgKeyRes.rows[0].sync_key as string;
    const newRoot = buildNodeRoot({ ...oldInfo, orgSyncKey: newOrgKey });

    const targetRemote = await resolveRemote(db, oldInfo.nodeType, newOrgKey);
    for (const r of tracked.rows) {
      const remoteName = r.remote_name as string;
      if (targetRemote !== null && targetRemote !== remoteName) {
        throw new Error(
          `cannot move node ${nodeId} to organization ${newOrgId}: its files live on remote "${remoteName}" but the new organization routes to remote "${targetRemote}". Move the files individually (portuni_move_file) or adjust the routing first.`,
        );
      }
      const oldRemote = r.remote_path as string;
      if (!oldRemote.startsWith(`${oldRoot}/`)) {
        // Already inconsistent before the move; leave it alone and report.
        migration.push({
          file_id: r.id as string,
          remote_name: remoteName,
          old_remote_path: oldRemote,
          new_remote_path: oldRemote,
        });
        continue;
      }
      migration.push({
        file_id: r.id as string,
        remote_name: remoteName,
        old_remote_path: oldRemote,
        new_remote_path: `${newRoot}${oldRemote.slice(oldRoot.length)}`,
      });
    }
  }

  await db.execute({
    sql: "UPDATE edges SET target_id = ? WHERE id = ?",
    args: [newOrgId, edgeId],
  });

  // Per-file remote rename + row update, after the edge rebind so a crash
  // mid-loop leaves files visibly orphaned under the *new* org (repairable,
  // and reported below) rather than silently split across two orgs.
  let migrated = 0;
  const repairNeeded: Array<{ file_id: string; error: string }> = [];
  const now = new Date().toISOString();
  for (const f of migration) {
    if (f.old_remote_path === f.new_remote_path) {
      repairNeeded.push({
        file_id: f.file_id,
        error: `remote_path did not start with the old node root; left unchanged (${f.old_remote_path})`,
      });
      continue;
    }
    try {
      const adapter = await getAdapter(db, f.remote_name);
      await adapter.rename(f.old_remote_path, f.new_remote_path);
      await db.execute({
        sql: "UPDATE files SET remote_path = ?, updated_at = ? WHERE id = ?",
        args: [f.new_remote_path, now, f.file_id],
      });
      migrated++;
    } catch (e) {
      repairNeeded.push({ file_id: f.file_id, error: String(e) });
    }
  }

  await writeAudit(db, userId, "move_node", "node", nodeId, {
    edge_id: edgeId,
    from_org_id: fromOrgId,
    to_org_id: newOrgId,
    files_migrated: migrated,
    files_repair_needed: repairNeeded.length,
  });

  return {
    moved: true,
    edge_id: edgeId,
    from_org_id: fromOrgId,
    to_org_id: newOrgId,
    files_migrated: migrated,
    files_repair_needed: repairNeeded,
  };
}
