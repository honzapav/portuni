// A mutation writes its answer into state (client traffic contract, rule
// 2): the node the server returned patches the graph's row for it, and the
// graph is reloaded only for what a row cannot carry -- edges, a move, an
// archive, sharing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { graphNeedsReload, patchGraphNode } from "../apps/web/src/lib/graph-patch.js";
import type { GraphNode, GraphPayload, NodeDetail } from "../apps/web/src/types.js";

function graphNode(over: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    type: "project",
    name: "A",
    description: null,
    status: "active",
    lifecycle_state: "active",
    health: "on_track",
    visibility: "team",
    owner: null,
    pos_x: null,
    pos_y: null,
    ...over,
  } as GraphNode;
}

function detail(over: Partial<NodeDetail> & { id: string }): NodeDetail {
  return {
    type: "project",
    name: "A",
    description: null,
    status: "active",
    visibility: "team",
    created_at: "",
    updated_at: "",
    edges: [],
    files: [],
    events: [],
    local_mirror: null,
    owner: null,
    responsibilities: [],
    data_sources: [],
    tools: [],
    goal: null,
    lifecycle_state: "active",
    health: "on_track",
    ...over,
  } as unknown as NodeDetail;
}

describe("patchGraphNode", () => {
  const graph: GraphPayload = { nodes: [graphNode({ id: "n1" }), graphNode({ id: "n2", name: "B" })], edges: [] };

  it("keeps the graph's reference when the row already matches", () => {
    assert.equal(patchGraphNode(graph, detail({ id: "n1" })), graph);
  });

  it("replaces only the row of the returned node", () => {
    const next = patchGraphNode(graph, detail({ id: "n1", name: "Renamed", lifecycle_state: "done", health: "at_risk" }));
    assert.notEqual(next, graph);
    assert.equal(next.nodes[0].name, "Renamed");
    assert.equal(next.nodes[0].lifecycle_state, "done");
    assert.equal(next.nodes[0].health, "at_risk");
    assert.equal(next.nodes[1], graph.nodes[1]);
    assert.equal(next.edges, graph.edges);
  });

  it("carries the owner into the row", () => {
    const next = patchGraphNode(graph, detail({ id: "n1", owner: { id: "a1", name: "Ann", type: "person" } as NodeDetail["owner"] }));
    assert.deepEqual(next.nodes[0].owner, { id: "a1", name: "Ann" });
  });

  it("leaves a graph that does not list the node alone", () => {
    assert.equal(patchGraphNode(graph, detail({ id: "elsewhere" })), graph);
  });
});

describe("graphNeedsReload", () => {
  it("only edges, a move, an archive and sharing reload the graph", () => {
    assert.equal(graphNeedsReload(undefined), false);
    assert.equal(graphNeedsReload({}), false);
    assert.equal(graphNeedsReload({ node: detail({ id: "n1" }) }), false);
    assert.equal(graphNeedsReload({ graph: true }), true);
    assert.equal(graphNeedsReload({ archived: true }), true);
  });
});
