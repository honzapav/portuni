// Pure helpers for the workspace's left column. No React, no DOM, no Tauri,
// so the data shape is unit-tested with the backend node-test runner.

// A node shown in the workspace's left column. `id` plus enough to render
// the row without a second graph lookup at the call site.
export type WorkspaceNodeRow = { id: string; name: string; type: string };

// The set of nodes shown in the workspace: every explicitly "open" node, in
// first-seen order, resolved against the graph. Ids that resolve to nothing
// are dropped -- e.g. a node deleted out from under a stale persisted id.
export function deriveWorkspaceNodeRows(
  openNodeIds: readonly string[],
  resolve: (id: string) => { name: string; type: string } | undefined,
): WorkspaceNodeRow[] {
  const rows: WorkspaceNodeRow[] = [];
  const seen = new Set<string>();
  for (const id of openNodeIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const r = resolve(id);
    if (r) rows.push({ id, name: r.name, type: r.type });
  }
  return rows;
}
