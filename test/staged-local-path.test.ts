// TDD: unit test for readableMirrorRoot — the helper that chooses which disk
// path to surface as local_path for a node's files.
//
// Contract:
//   - home node        → real mirror (unchanged — it is the rw sandbox root)
//   - in-scope non-home → staged root  (<home>/.portuni-scope/<id>/)
//   - out-of-scope     → real mirror (unchanged — Seatbelt doesn't restrict it)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { readableMirrorRoot } from "../apps/server/mcp/scope-reconciler.js";

describe("readableMirrorRoot", () => {
  const home = "/root/org/home";

  it("returns the real mirror for the home node", () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    scope.add("HOME");
    assert.equal(
      readableMirrorRoot({ scope, nodeId: "HOME", homeMirror: home, realMirror: home }),
      home,
    );
  });

  it("returns the staged root for an in-scope non-home node", () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    scope.add("HOME");
    scope.add("NB");
    assert.equal(
      readableMirrorRoot({
        scope,
        nodeId: "NB",
        homeMirror: home,
        realMirror: "/root/org/nb",
      }),
      join(home, ".portuni-scope", "NB"),
    );
  });

  it("returns the real mirror for an out-of-scope node (unchanged)", () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    assert.equal(
      readableMirrorRoot({
        scope,
        nodeId: "OUT",
        homeMirror: home,
        realMirror: "/root/org/out",
      }),
      "/root/org/out",
    );
  });

  it("returns realMirror when homeMirror is null (no home mirror on device)", () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    scope.add("HOME");
    scope.add("NB");
    assert.equal(
      readableMirrorRoot({
        scope,
        nodeId: "NB",
        homeMirror: null,
        realMirror: "/root/org/nb",
      }),
      "/root/org/nb",
    );
  });

  it("returns null when both homeMirror and realMirror are null", () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    scope.add("HOME");
    scope.add("NB");
    assert.equal(
      readableMirrorRoot({ scope, nodeId: "NB", homeMirror: null, realMirror: null }),
      null,
    );
  });
});
