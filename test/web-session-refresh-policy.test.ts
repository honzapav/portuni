// Which nodes' thread lists the window refetches over REST (client traffic
// contract, rules 1 and 3): the nodes just opened, and a node whose live
// frame names a session the store does not hold complete. Closing a node,
// and a frame about a known thread, cost nothing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  nodesAddedToOpenSet,
  nodesToRefetchForFrames,
} from "../apps/web/src/lib/session-refresh-policy.js";

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `node-${i}`);
}

describe("nodesAddedToOpenSet", () => {
  it("closing one of twelve nodes refetches nothing", () => {
    const prev = ids(12);
    const next = prev.filter((id) => id !== prev[3]);
    assert.deepEqual(nodesAddedToOpenSet(prev, next), []);
  });

  it("opening one node refetches that node only", () => {
    assert.deepEqual(nodesAddedToOpenSet(["a", "b"], ["a", "b", "c"]), ["c"]);
  });

  it("first mount refetches every open node", () => {
    assert.deepEqual(nodesAddedToOpenSet([], ["a", "b"]), ["a", "b"]);
  });

  it("an unchanged set refetches nothing", () => {
    assert.deepEqual(nodesAddedToOpenSet(["a", "b"], ["b", "a"]), []);
  });
});

describe("nodesToRefetchForFrames", () => {
  it("a frame for a complete record refetches nothing", () => {
    assert.deepEqual(nodesToRefetchForFrames([{ session_id: "s1", node_id: "a" }], ["a"], () => true), []);
  });

  it("a frame for a stub on an open node refetches that node once", () => {
    assert.deepEqual(
      nodesToRefetchForFrames(
        [
          { session_id: "s1", node_id: "a" },
          { session_id: "s2", node_id: "a" },
        ],
        ["a", "b"],
        () => false,
      ),
      ["a"],
    );
  });

  it("a frame for a node that is not open refetches nothing", () => {
    assert.deepEqual(nodesToRefetchForFrames([{ session_id: "s1", node_id: "z" }], ["a"], () => false), []);
  });

  it("a frame without a node refetches nothing", () => {
    assert.deepEqual(nodesToRefetchForFrames([{ session_id: "s1", node_id: null }], ["a"], () => false), []);
  });

  it("only the incomplete session's node is refetched in a mixed burst", () => {
    const complete = new Set(["s1"]);
    assert.deepEqual(
      nodesToRefetchForFrames(
        [
          { session_id: "s1", node_id: "a" },
          { session_id: "s9", node_id: "b" },
        ],
        ["a", "b"],
        (id) => complete.has(id),
      ),
      ["b"],
    );
  });
});
