// What the window's background polls and the focus refetch may ask for
// (client traffic contract, rule 5): only the node on screen, only while
// the window is visible, never during a 429 cooldown.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  focusRefetchTargets,
  nodeDetailPollTarget,
  shouldPollSyncStatus,
} from "../apps/web/src/lib/poll-policy.js";

const base = {
  hidden: false,
  rateLimited: false,
  selectedId: "g1",
  selectedWorkspaceNodeId: "w1",
  workspaceDetailVisible: true,
};

describe("nodeDetailPollTarget", () => {
  it("polls the Práce selection while its detail is visible", () => {
    assert.deepEqual(nodeDetailPollTarget({ ...base, view: "workspace" }), { kind: "workspace", nodeId: "w1" });
  });

  it("polls the graph selection in Graf", () => {
    assert.deepEqual(nodeDetailPollTarget({ ...base, view: "graph" }), { kind: "graph", nodeId: "g1" });
  });

  it("polls nothing in Přehled or Settings even with both selections set", () => {
    assert.equal(nodeDetailPollTarget({ ...base, view: "overview" }), null);
    assert.equal(nodeDetailPollTarget({ ...base, view: "settings" }), null);
  });

  it("polls nothing while the Práce detail is collapsed", () => {
    assert.equal(nodeDetailPollTarget({ ...base, view: "workspace", workspaceDetailVisible: false }), null);
  });

  it("polls nothing without a selection", () => {
    assert.equal(nodeDetailPollTarget({ ...base, view: "workspace", selectedWorkspaceNodeId: null }), null);
    assert.equal(nodeDetailPollTarget({ ...base, view: "graph", selectedId: null }), null);
  });

  it("polls nothing while hidden or rate limited", () => {
    assert.equal(nodeDetailPollTarget({ ...base, view: "workspace", hidden: true }), null);
    assert.equal(nodeDetailPollTarget({ ...base, view: "graph", rateLimited: true }), null);
  });
});

describe("shouldPollSyncStatus", () => {
  it("polls only on the Files tab, visible, outside a cooldown", () => {
    assert.equal(shouldPollSyncStatus({ tab: "files", hidden: false, rateLimited: false }), true);
    assert.equal(shouldPollSyncStatus({ tab: "overview", hidden: false, rateLimited: false }), false);
    assert.equal(shouldPollSyncStatus({ tab: "files", hidden: true, rateLimited: false }), false);
    assert.equal(shouldPollSyncStatus({ tab: "files", hidden: false, rateLimited: true }), false);
  });
});

describe("focusRefetchTargets", () => {
  it("refetches the graph and the node of the shown view only", () => {
    assert.deepEqual(
      focusRefetchTargets({ view: "workspace", rateLimited: false, selectedId: "g1", selectedWorkspaceNodeId: "w1" }),
      { graph: true, nodeId: "w1" },
    );
    assert.deepEqual(
      focusRefetchTargets({ view: "graph", rateLimited: false, selectedId: "g1", selectedWorkspaceNodeId: "w1" }),
      { graph: true, nodeId: "g1" },
    );
    assert.deepEqual(
      focusRefetchTargets({ view: "overview", rateLimited: false, selectedId: "g1", selectedWorkspaceNodeId: "w1" }),
      { graph: true, nodeId: null },
    );
  });

  it("refetches nothing during a cooldown", () => {
    assert.deepEqual(
      focusRefetchTargets({ view: "graph", rateLimited: true, selectedId: "g1", selectedWorkspaceNodeId: "w1" }),
      { graph: false, nodeId: null },
    );
  });
});
