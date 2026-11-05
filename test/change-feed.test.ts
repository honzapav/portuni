// The server's change feed (client traffic contract, rule 3): every graph
// and file write publishes the node it touched; a reader asks for what
// happened since its cursor and can wait for the next change instead of
// polling the nodes themselves. In-memory, per process: a cursor from
// another process instance, or older than the ring keeps, answers `reset`.

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHANGE_FEED_RING,
  changesSince,
  publishNodeChange,
  resetChangeFeedForTesting,
  subscribeChanges,
  waitForChanges,
} from "../apps/server/infra/change-feed.js";

describe("change feed", () => {
  beforeEach(() => resetChangeFeedForTesting());

  it("a null cursor answers reset with the current cursor and no changes", () => {
    publishNodeChange("n1", "node");
    const r = changesSince(null);
    assert.equal(r.reset, true);
    assert.deepEqual(r.changes, []);
    assert.equal(typeof r.cursor, "string");
  });

  it("answers the changes after the cursor, in order, and moves the cursor", () => {
    const start = changesSince(null).cursor;
    publishNodeChange("n1", "node");
    publishNodeChange("n2", "files");
    const r = changesSince(start);
    assert.equal(r.reset, false);
    assert.deepEqual(
      r.changes.map((c) => [c.node_id, c.kind]),
      [
        ["n1", "node"],
        ["n2", "files"],
      ],
    );
    const again = changesSince(r.cursor);
    assert.deepEqual(again.changes, []);
    assert.equal(again.cursor, r.cursor);
  });

  it("a cursor from another process instance answers reset", () => {
    const foreign = "01OTHERINSTANCE:5";
    const r = changesSince(foreign);
    assert.equal(r.reset, true);
  });

  it("a cursor older than the ring answers reset", () => {
    const start = changesSince(null).cursor;
    for (let i = 0; i < CHANGE_FEED_RING + 5; i++) publishNodeChange(`n${i}`, "node");
    const r = changesSince(start);
    assert.equal(r.reset, true);
    assert.deepEqual(r.changes, []);
  });

  it("caps one answer and leaves the rest for the next cursor", () => {
    const start = changesSince(null).cursor;
    for (let i = 0; i < 7; i++) publishNodeChange(`n${i}`, "node");
    const first = changesSince(start, 5);
    assert.equal(first.changes.length, 5);
    const rest = changesSince(first.cursor, 5);
    assert.deepEqual(
      rest.changes.map((c) => c.node_id),
      ["n5", "n6"],
    );
  });

  it("waitForChanges resolves on the next publish and on timeout", async () => {
    const start = changesSince(null).cursor;
    const resolvedByPublish = waitForChanges(start, 5_000);
    setTimeout(() => publishNodeChange("n1", "files"), 5);
    assert.equal(await resolvedByPublish, true);
    const cursor = changesSince(start).cursor;
    assert.equal(await waitForChanges(cursor, 10), false);
  });

  it("subscribers hear every publish", () => {
    const heard: string[] = [];
    const off = subscribeChanges((c) => heard.push(`${c.node_id}:${c.kind}`));
    publishNodeChange("n1", "node");
    off();
    publishNodeChange("n2", "node");
    assert.deepEqual(heard, ["n1:node"]);
  });
});
