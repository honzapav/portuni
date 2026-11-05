// The window's node-change bus (client traffic contract, rule 3): the live
// channel's node_changed frames land here, and the surfaces that show a
// node (the detail, the files tab, the editor, the sync counter) refetch
// only what the change names. A reset refetches what is on screen.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  emitNodeChanges,
  nodeChangeTouches,
  onNodeChanges,
} from "../apps/web/src/lib/node-changes.js";

describe("node-change bus", () => {
  it("delivers every emitted batch to the listeners until they unsubscribe", () => {
    const heard: unknown[] = [];
    const off = onNodeChanges((batch) => heard.push(batch));
    emitNodeChanges({ changes: [{ node_id: "n1", kind: "files" }], reset: false });
    off();
    emitNodeChanges({ changes: [], reset: true });
    assert.deepEqual(heard, [{ changes: [{ node_id: "n1", kind: "files" }], reset: false }]);
  });

  it("nodeChangeTouches says whether a batch concerns a node, by kind, and a reset concerns every node", () => {
    const batch = { changes: [{ node_id: "n1", kind: "files" as const }], reset: false };
    assert.equal(nodeChangeTouches(batch, "n1"), true);
    assert.equal(nodeChangeTouches(batch, "n1", "files"), true);
    assert.equal(nodeChangeTouches(batch, "n1", "node"), false);
    assert.equal(nodeChangeTouches(batch, "n2"), false);
    assert.equal(nodeChangeTouches({ changes: [], reset: true }, "n2"), true);
    assert.equal(nodeChangeTouches(batch, null), false);
  });
});
