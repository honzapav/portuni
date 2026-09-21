// The Práce column's pure rules (apps/web/src/lib/workspace-list.ts): the
// node's status dot and the Stav grouping.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeNodeActivity, taskGroupOf } from "../apps/web/src/lib/workspace-list.js";

describe("summarizeNodeActivity", () => {
  it("waiting beats running", () => {
    assert.equal(
      summarizeNodeActivity([
        { state: "running", waiting_since: "2026-09-21 10:00:00" },
        { state: "running", waiting_since: null },
      ]),
      "waiting",
    );
    assert.equal(summarizeNodeActivity([{ state: "running", waiting_since: null }]), "running");
  });

  it("a suspended or draft thread shows no dot (v2, left column)", () => {
    assert.equal(
      summarizeNodeActivity([
        { state: "suspended", waiting_since: null },
        { state: "draft", waiting_since: null },
      ]),
      null,
    );
    assert.equal(summarizeNodeActivity([]), null);
  });
});

describe("taskGroupOf", () => {
  it("groups by what the thread needs from the user", () => {
    assert.equal(taskGroupOf({ state: "running", waiting_since: "x" }), "waiting");
    assert.equal(taskGroupOf({ state: "running", waiting_since: null }), "running");
    assert.equal(taskGroupOf({ state: "suspended", waiting_since: null }), "suspended");
    assert.equal(taskGroupOf({ state: "draft", waiting_since: null }), "draft");
    assert.equal(taskGroupOf({ state: "closed", waiting_since: null }), "done");
  });
});
