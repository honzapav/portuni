// The window's node-change bus (docs/superpowers/specs/
// 2026-11-05-client-traffic-contract.md, rule 3): the live channel's
// `node_changed` frames (lib/sessions-client.ts) land here, and every
// surface that shows a node -- the detail (App.tsx), the Files tab and its
// sync status (DetailPane), the open file (use-file-editor), the sync
// counter (use-sync-pending) -- refetches only what a change names. A
// `reset` (the server restarted, or this device's feed fell behind) means
// "refetch what you show, once".

export type NodeChangeKind = "node" | "files";
export type NodeChangeBatch = { changes: { node_id: string; kind: NodeChangeKind }[]; reset: boolean };

const listeners = new Set<(batch: NodeChangeBatch) => void>();

export function onNodeChanges(cb: (batch: NodeChangeBatch) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emitNodeChanges(batch: NodeChangeBatch): void {
  for (const cb of listeners) cb(batch);
}

// Whether a batch concerns `nodeId` (any kind, or `kind` only); a reset
// concerns every node, a null node nothing.
export function nodeChangeTouches(batch: NodeChangeBatch, nodeId: string | null, kind?: NodeChangeKind): boolean {
  if (nodeId === null) return false;
  if (batch.reset) return true;
  return batch.changes.some((c) => c.node_id === nodeId && (kind === undefined || c.kind === kind));
}
