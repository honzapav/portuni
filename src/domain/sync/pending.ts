// Cross-mirror aggregate of local work that is not yet on a remote. Powers
// the global "unsynced overview" and the quit guard. Best-effort: a mirror
// that fails to scan is skipped, never aborts the whole aggregate.
import type { Client } from "@libsql/client";
import { listUserMirrors } from "./mirror-registry.js";
import { statusScan } from "./engine.js";
import type { SyncPendingNode, SyncPendingResponse } from "../../shared/api-types.js";

export async function computeSyncPending(
  db: Client,
  userId: string,
): Promise<SyncPendingResponse> {
  const mirrors = await listUserMirrors(userId);
  const nodes: SyncPendingNode[] = [];
  for (const m of mirrors) {
    let scan;
    try {
      scan = await statusScan(db, {
        userId,
        nodeId: m.node_id,
        includeDiscovery: true,
        fast: true,
      });
    } catch {
      continue; // unscannable mirror — skip, don't break the overview
    }
    const push = scan.push_candidates.length;
    const conflict = scan.conflicts.length;
    const untracked = scan.new_local.length;
    const orphan = scan.orphan.length;
    const deleted_local = scan.deleted_local.length;
    const total = push + conflict + untracked + orphan + deleted_local;
    if (total === 0) continue;
    const row = await db.execute({
      sql: "SELECT name, type FROM nodes WHERE id = ?",
      args: [m.node_id],
    });
    if (row.rows.length === 0) continue; // mirror for a deleted node — skip
    nodes.push({
      node_id: m.node_id,
      node_name: row.rows[0].name as string,
      node_type: row.rows[0].type as string,
      push,
      conflict,
      untracked,
      orphan,
      deleted_local,
      total,
    });
  }
  nodes.sort((a, b) => b.total - a.total);
  const total = nodes.reduce((s, n) => s + n.total, 0);
  return { nodes, total };
}
