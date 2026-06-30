// Cross-mirror aggregate of local work that is not yet on a remote. Powers
// the global "unsynced overview" and the quit guard. Best-effort: a mirror
// that fails to scan is skipped, never aborts the whole aggregate.
import type { Client } from "@libsql/client";
import { listUserMirrors } from "./mirror-registry.js";
import { statusScan } from "./engine.js";
import type { SyncPendingNode, SyncPendingResponse } from "../../shared/api-types.js";

// Scan at most this many mirrors at once. A user can have dozens of mirrors;
// scanning them one after another (the old serial loop) made this endpoint
// take minutes and time out — the footer indicator then never appeared.
const SCAN_CONCURRENCY = 8;

export async function computeSyncPending(
  db: Client,
  userId: string,
): Promise<SyncPendingResponse> {
  const mirrors = await listUserMirrors(userId);

  const scanOne = async (m: (typeof mirrors)[number]): Promise<SyncPendingNode | null> => {
    const row = await db.execute({
      sql: "SELECT name, type FROM nodes WHERE id = ?",
      args: [m.node_id],
    });
    if (row.rows.length === 0) return null; // mirror for a deleted node — skip before scanning
    const scan = await statusScan(db, {
      userId,
      nodeId: m.node_id,
      includeDiscovery: true,
      // The aggregate never counts new_remote, so skip the per-mirror Drive
      // listing — it is the single slowest part of the scan and pure waste here.
      skipRemoteDiscovery: true,
      fast: true,
    }).catch(() => null);
    if (!scan) return null; // unscannable mirror — skip, don't break the overview
    const push = scan.push_candidates.length;
    const conflict = scan.conflicts.length;
    const untracked = scan.new_local.length;
    const orphan = scan.orphan.length;
    const deleted_local = scan.deleted_local.length;
    const total = push + conflict + untracked + orphan + deleted_local;
    if (total === 0) return null;
    return {
      node_id: m.node_id,
      node_name: row.rows[0].name as string,
      node_type: row.rows[0].type as string,
      push,
      conflict,
      untracked,
      orphan,
      deleted_local,
      total,
    };
  };

  // Bounded-concurrency fan-out: workers pull from a shared cursor.
  const nodes: SyncPendingNode[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= mirrors.length) return;
      const n = await scanOne(mirrors[i]);
      if (n) nodes.push(n);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, mirrors.length) }, () => worker()),
  );

  nodes.sort((a, b) => b.total - a.total);
  const total = nodes.reduce((s, n) => s + n.total, 0);
  return { nodes, total };
}
