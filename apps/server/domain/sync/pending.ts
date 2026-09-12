// Cross-mirror aggregate of local work that is not yet on a remote. Powers
// the global "unsynced overview" and the quit guard. Best-effort: a mirror
// that fails to scan is skipped, never aborts the whole aggregate.
import { stat } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { listUserMirrors } from "./mirror-registry.js";
import { statusScan } from "./engine.js";
import { filterVisibleNodeIds, type GroupIdentityView } from "../../auth/node-access.js";
import type { SyncPendingNode, SyncPendingResponse } from "../../shared/api-types.js";

// Scan at most this many mirrors at once. A user can have dozens of mirrors;
// scanning them one after another (the old serial loop) made this endpoint
// take minutes and time out — the footer indicator then never appeared.
const SCAN_CONCURRENCY = 8;

export async function computeSyncPending(
  db: Client,
  identity: GroupIdentityView,
): Promise<SyncPendingResponse> {
  const allMirrors = await listUserMirrors(identity.userId);

  // Group-visibility guard: a mirror for a node whose ACL has since been
  // set/changed (revoked access, or a restricted node the caller never
  // belonged to) must not surface its name or counts in the cross-mirror
  // aggregate. Filter before scanning so a revoked node's disk state is
  // never even touched, not just hidden after the fact.
  const visibleIds = await filterVisibleNodeIds(
    db,
    identity,
    allMirrors.map((m) => m.node_id),
  );
  const mirrors = allMirrors.filter((m) => visibleIds.has(m.node_id));

  const scanOne = async (m: (typeof mirrors)[number]): Promise<SyncPendingNode | null> => {
    const row = await db.execute({
      sql: "SELECT name, type FROM nodes WHERE id = ?",
      args: [m.node_id],
    });
    if (row.rows.length === 0) return null; // mirror for a deleted node — skip before scanning
    const dirExists = await stat(m.local_path)
      .then((s) => s.isDirectory())
      .catch(() => false);
    // A mirror whose root directory was removed from disk is not local work
    // in progress — its files would only ever read as deleted_local, which
    // must not count towards "unsynced" (see below).
    if (!dirExists) return null;
    const scan = await statusScan(db, {
      userId: identity.userId,
      nodeId: m.node_id,
      includeDiscovery: true,
      // The aggregate never counts new_remote, so skip the per-mirror Drive
      // listing — it is the single slowest part of the scan and pure waste here.
      skipRemoteDiscovery: true,
    }).catch(() => null);
    if (!scan) return null; // unscannable mirror — skip, don't break the overview
    const push = scan.push_candidates.length;
    const conflict = scan.conflicts.length;
    // deleted_remote copies count as untracked pending work: the sync run
    // resolves them (cleanup instead of adopt), so they must keep the
    // "something to sync" indicator alive.
    const untracked = scan.new_local.length + scan.deleted_remote.length;
    const remote_missing = scan.remote_missing.length;
    const deleted_local = scan.deleted_local.length;
    // remote_missing is surfaced per-node (SyncBar/file list) but does not
    // count towards either total: a sync run neither pushes nor pulls it,
    // so it would never clear.
    //
    // `total` (actionable) vs `decisions` (needs a human): a sync run
    // pushes/pulls push+untracked but never resolves a conflict or restores
    // a deleted_local file -- counting those into `total` made the footer
    // badge / quit guard warn about work "Synchronizovat vše" can never
    // actually clear. Split so each count means what it says; a node is
    // still included below when it only has decisions, so it isn't hidden
    // from the overview entirely.
    const total = push + untracked;
    const decisions = conflict + deleted_local;
    if (total === 0 && decisions === 0) return null;
    return {
      node_id: m.node_id,
      node_name: row.rows[0].name as string,
      node_type: row.rows[0].type as string,
      push,
      conflict,
      untracked,
      remote_missing,
      deleted_local,
      total,
      decisions,
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
  const decisions = nodes.reduce((s, n) => s + n.decisions, 0);
  return { nodes, total, decisions };
}
