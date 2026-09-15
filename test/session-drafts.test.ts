import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDraftStore } from "../apps/web/src/lib/session-drafts.js";

describe("createDraftStore", () => {
  it("keeps a draft per session id", () => {
    const store = createDraftStore();
    store.set("s1", "ahoj");
    store.set("s2", "druhy ukol");
    assert.equal(store.get("s1"), "ahoj");
    assert.equal(store.get("s2"), "druhy ukol");
  });

  it("returns an empty string for a session with no draft", () => {
    const store = createDraftStore();
    assert.equal(store.get("neznamy"), "");
  });

  it("a draft survives switching away and back", () => {
    const store = createDraftStore();
    store.set("s1", "rozepsane");
    // switch to another session, type there, come back
    store.set("s2", "jine");
    assert.equal(store.get("s1"), "rozepsane");
  });

  it("emptying the composer drops the draft", () => {
    const store = createDraftStore();
    store.set("s1", "rozepsane");
    store.set("s1", "");
    assert.equal(store.get("s1"), "");
  });

  it("clear removes only that session's draft", () => {
    const store = createDraftStore();
    store.set("s1", "a");
    store.set("s2", "b");
    store.clear("s1");
    assert.equal(store.get("s1"), "");
    assert.equal(store.get("s2"), "b");
  });
});
