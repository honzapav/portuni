import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  residualPendingNode,
  applyPendingNode,
  pruneOverrides,
  applyOverrides,
  type PendingOverride,
} from "../apps/web/src/lib/sync-pending-residual.js";
import type { SyncPendingNode, SyncRunResponse } from "../apps/server/shared/api-types.js";

const node = (id: string, total: number, decisions = 0): SyncPendingNode => ({
  node_id: id,
  node_name: `Node ${id}`,
  node_type: "project",
  push: total,
  conflict: 0,
  untracked: 0,
  remote_missing: 0,
  deleted_local: 0,
  total,
  decisions,
});

const run = (over: Partial<SyncRunResponse> = {}): SyncRunResponse => ({
  pushed: [],
  pulled: [],
  adopted: [],
  adopted_remote: [],
  conflicts: [],
  deleted_local: [],
  deleted_remote: [],
  deleted_on_remote: [],
  sweep_errors: [],
  repaired: [],
  pending_repairs: [],
  errors: [],
  skipped: [],
  ...over,
});

const file = (id: string) => ({ file_id: id, filename: `${id}.md` });

describe("residualPendingNode", () => {
  it("clears a node whose run pushed everything", () => {
    assert.equal(residualPendingNode(node("a", 3), run({ pushed: [file("f1")] })), null);
  });

  it("keeps a failed transfer in total, a conflict in decisions (a run never resolves a conflict)", () => {
    const r = residualPendingNode(
      node("a", 3),
      run({ conflicts: [file("f1")], errors: [{ ...file("f2"), error: "boom" }] }),
    );
    assert.deepEqual(
      r && { push: r.push, conflict: r.conflict, total: r.total, decisions: r.decisions },
      {
        push: 1,
        conflict: 1,
        total: 1,
        decisions: 1,
      },
    );
  });

  it("counts a skipped push but not a skipped remote_missing", () => {
    const r = residualPendingNode(
      node("a", 2),
      run({
        skipped: [
          { ...file("f1"), sync_class: "push" },
          { ...file("f2"), sync_class: "remote_missing" },
        ],
      }),
    );
    assert.equal(r?.total, 1);
    assert.equal(r?.remote_missing, 1);
  });

  it("keeps the node's identity fields", () => {
    const r = residualPendingNode(node("a", 1), run({ conflicts: [file("f1")] }));
    assert.equal(r?.node_name, "Node a");
    assert.equal(r?.node_type, "project");
  });
});

describe("applyPendingNode", () => {
  const pending = { nodes: [node("a", 3), node("b", 1)], total: 4, decisions: 0 };

  it("drops a node and recomputes the total", () => {
    assert.deepEqual(applyPendingNode(pending, "a", null), {
      nodes: [node("b", 1)],
      total: 1,
      decisions: 0,
    });
  });

  it("replaces a node, re-sorting by total", () => {
    const out = applyPendingNode(pending, "a", node("a", 1));
    assert.deepEqual(
      out.nodes.map((n) => n.node_id),
      ["b", "a"],
    );
    assert.equal(out.total, 2);
  });

  it("leaves an unknown node id alone", () => {
    assert.equal(applyPendingNode(pending, "zz", null).total, 4);
  });

  it("recomputes decisions alongside total", () => {
    const withDecisions = {
      nodes: [node("a", 0, 2), node("b", 1)],
      total: 1,
      decisions: 2,
    };
    assert.equal(applyPendingNode(withDecisions, "a", null).decisions, 0);
  });
});

describe("overrides vs. a scan already in flight", () => {
  const overrides = new Map<string, PendingOverride>([
    ["a", { node: null, since: 100 }],
    ["b", { node: null, since: 300 }],
  ]);

  it("drops overrides the scan already saw, keeps newer ones", () => {
    const kept = pruneOverrides(overrides, 200);
    assert.deepEqual([...kept.keys()], ["b"]);
  });

  it("a stale scan cannot resurrect a node cleared after it started", () => {
    const fetched = { nodes: [node("a", 3), node("b", 1)], total: 4, decisions: 0 };
    const out = applyOverrides(fetched, pruneOverrides(overrides, 200));
    assert.deepEqual(
      out.nodes.map((n) => n.node_id),
      ["a"],
    );
    assert.equal(out.total, 3);
  });
});
