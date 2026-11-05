// A mutation writes its answer into state (docs/superpowers/specs/
// 2026-11-05-client-traffic-contract.md, rule 2). `NodeChange` is what a
// detail-pane action tells App about what it did: the node the server
// returned (PATCH /nodes/:id, POST /nodes/:id/move) patches the graph's
// row for it and becomes the detail; nothing (a file, an event, a
// responsibility, a data source, a tool, a sync run) refetches the one
// node detail; `graph` asks for the graph again, for what a row cannot
// carry -- edges, a move, sharing, an archive.

import type { GraphNode, GraphPayload, NodeDetail } from "../types";

export type NodeChange = {
  node?: NodeDetail;
  graph?: boolean;
  archived?: boolean;
};

export function graphNeedsReload(change: NodeChange | undefined): boolean {
  return change?.graph === true || change?.archived === true;
}

const ROW_FIELDS = ["name", "description", "status", "lifecycle_state", "health", "visibility"] as const;

// The graph with the returned node's row brought up to date; the same
// reference when the row already matches or the graph does not list it.
export function patchGraphNode(graph: GraphPayload, node: NodeDetail): GraphPayload {
  const index = graph.nodes.findIndex((n) => n.id === node.id);
  if (index === -1) return graph;
  const row = graph.nodes[index];
  const owner = node.owner ? { id: node.owner.id, name: node.owner.name } : null;
  const same =
    ROW_FIELDS.every((f) => row[f] === node[f]) &&
    (row.owner?.id ?? null) === (owner?.id ?? null) &&
    (row.owner?.name ?? null) === (owner?.name ?? null);
  if (same) return graph;
  const patched: GraphNode = { ...row, owner };
  for (const f of ROW_FIELDS) (patched as Record<typeof f, string | null>)[f] = node[f];
  const nodes = graph.nodes.slice();
  nodes[index] = patched;
  return { ...graph, nodes };
}
