// What a finished sync run leaves pending, derived from the run's own result.
//
// GET /sync/pending is a full cross-mirror disk scan (seconds on a machine
// with many mirrors), so refreshing it was the only thing that cleared a
// just-synced node from the overview -- the row sat there long after its
// run had finished. The run result already says what remains, so the list
// is updated from it immediately and the aggregate refresh only reconciles.
import type { SyncPendingNode, SyncPendingResponse, SyncRunResponse } from "../types";

// Mirrors computeSyncPending's accounting (domain/sync/pending.ts):
// total = push + conflict + untracked; remote_missing and deleted_local are
// shown per node but never counted, since a sync run does not clear them.
export function residualPendingNode(
  prev: SyncPendingNode,
  run: SyncRunResponse,
): SyncPendingNode | null {
  const skipped = (cls: string) => run.skipped.filter((s) => s.sync_class === cls).length;
  // A failed transfer stays local work; a push the run declined to make
  // (skipped) is still a push candidate on the next scan.
  const push = run.errors.length + skipped("push");
  const conflict = run.conflicts.length;
  // Untracked files are adopted by the run; anything that failed to adopt
  // is already counted through `errors`.
  const untracked = 0;
  const total = push + conflict + untracked;
  if (total === 0) return null;
  return {
    ...prev,
    push,
    conflict,
    untracked,
    remote_missing: skipped("remote_missing"),
    deleted_local: run.deleted_local.length,
    total,
  };
}

// Replace (or, with `node: null`, drop) one node in the aggregate and
// recompute the grand total, keeping the response's total-desc ordering.
export function applyPendingNode(
  pending: SyncPendingResponse,
  nodeId: string,
  node: SyncPendingNode | null,
): SyncPendingResponse {
  const nodes = pending.nodes.filter((n) => n.node_id !== nodeId);
  if (node) nodes.push(node);
  nodes.sort((a, b) => b.total - a.total);
  return { nodes, total: nodes.reduce((s, n) => s + n.total, 0) };
}

// An optimistic per-node result, valid until an aggregate scan that started
// after it lands (that scan already saw the post-sync state).
export type PendingOverride = { node: SyncPendingNode | null; since: number };

export function pruneOverrides(
  overrides: Map<string, PendingOverride>,
  fetchStartedAt: number,
): Map<string, PendingOverride> {
  return new Map([...overrides].filter(([, o]) => o.since > fetchStartedAt));
}

export function applyOverrides(
  pending: SyncPendingResponse,
  overrides: Map<string, PendingOverride>,
): SyncPendingResponse {
  let out = pending;
  for (const [nodeId, o] of overrides) out = applyPendingNode(out, nodeId, o.node);
  return out;
}
