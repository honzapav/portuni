import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordWatcherError,
  clearWatcherError,
  getWatcherErrors,
  clearWatcherErrorBufferForTests,
} from "../apps/server/domain/sync/watcher-error-buffer.js";

beforeEach(() => {
  clearWatcherErrorBufferForTests();
});

describe("watcher-error-buffer", () => {
  it("records an error and exposes it via getWatcherErrors", () => {
    recordWatcherError("N1", "wip/a.md", new Error("boom"));
    const all = getWatcherErrors();
    assert.equal(all.length, 1);
    assert.equal(all[0].node_id, "N1");
    assert.equal(all[0].path, "wip/a.md");
    assert.equal(all[0].message, "boom");
    assert.ok(all[0].at);
  });

  it("stringifies a non-Error thrown value", () => {
    recordWatcherError("N1", "wip/a.md", "plain string failure");
    assert.equal(getWatcherErrors()[0].message, "plain string failure");
  });

  it("dedupes repeats of the same path: one entry, refreshed timestamp", async () => {
    recordWatcherError("N1", "wip/a.md", new Error("first"));
    const firstAt = getWatcherErrors()[0].at;
    await new Promise((r) => setTimeout(r, 5));
    recordWatcherError("N1", "wip/a.md", new Error("second"));
    const all = getWatcherErrors();
    assert.equal(all.length, 1, "repeated failures for the same path must not grow the buffer");
    assert.equal(all[0].message, "second");
    assert.notEqual(all[0].at, firstAt);
  });

  it("clearWatcherError removes the entry after a successful reconcile", () => {
    recordWatcherError("N1", "wip/a.md", new Error("boom"));
    clearWatcherError("N1", "wip/a.md");
    assert.deepEqual(getWatcherErrors(), []);
  });

  it("clearWatcherError on an untracked path is a harmless no-op", () => {
    assert.doesNotThrow(() => clearWatcherError("N1", "wip/never-failed.md"));
  });

  it("getWatcherErrors(nodeId) restricts to one node", () => {
    recordWatcherError("N1", "wip/a.md", new Error("a"));
    recordWatcherError("N2", "wip/b.md", new Error("b"));
    const forN1 = getWatcherErrors("N1");
    assert.equal(forN1.length, 1);
    assert.equal(forN1[0].node_id, "N1");
    assert.equal(getWatcherErrors().length, 2);
  });

  it("keeps distinct paths under the same node as separate entries", () => {
    recordWatcherError("N1", "wip/a.md", new Error("a"));
    recordWatcherError("N1", "wip/b.md", new Error("b"));
    assert.equal(getWatcherErrors("N1").length, 2);
  });

  it("caps entries per node, evicting the oldest first", () => {
    // Cap is 50; add 51 distinct paths under one node and confirm exactly
    // one (the first inserted) is evicted, the rest survive.
    for (let i = 0; i < 51; i++) {
      recordWatcherError("N1", `wip/f${i}.md`, new Error(`err${i}`));
    }
    const all = getWatcherErrors("N1");
    assert.equal(all.length, 50);
    assert.ok(!all.some((e) => e.path === "wip/f0.md"), "oldest entry must be evicted");
    assert.ok(all.some((e) => e.path === "wip/f50.md"), "newest entry must survive");
  });

  it("sorts newest-first", async () => {
    recordWatcherError("N1", "wip/older.md", new Error("older"));
    await new Promise((r) => setTimeout(r, 5));
    recordWatcherError("N1", "wip/newer.md", new Error("newer"));
    const all = getWatcherErrors();
    assert.equal(all[0].path, "wip/newer.md");
    assert.equal(all[1].path, "wip/older.md");
  });
});
