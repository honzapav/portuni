// Scope -> disk projection after staging retirement. readableMirrorRoot maps
// a node to the real disk path the agent may read (home + seed set) or null
// (ad-hoc in-scope nodes, read via portuni_read_file). The reconciler no
// longer copies anything; its only job is a one-time sweep of legacy
// .portuni-scope directories from pre-real-path sessions.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionScope } from "../apps/server/mcp/scope.js";
import {
  readableMirrorRoot,
  createScopeReconciler,
} from "../apps/server/mcp/scope-reconciler.js";

let dir: string;
let home: string;
let neighbor: string;

function fakeResolver(map: Record<string, string>) {
  return async (_userId: string, nodeId: string) => map[nodeId] ?? null;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-reconciler-"));
  home = join(dir, "home");
  neighbor = join(dir, "neighbor");
  await mkdir(join(home, "wip"), { recursive: true });
  await mkdir(join(neighbor, "wip"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readableMirrorRoot", () => {
  it("returns the real mirror for the home node", () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    const p = readableMirrorRoot({ scope, nodeId: "HOME", homeMirror: "/h", realMirror: "/h" });
    assert.equal(p, "/h");
  });

  it("returns the real mirror for a seed-set (depth-1) node", () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    scope.addSeed("NEIGHBOR");
    const p = readableMirrorRoot({
      scope,
      nodeId: "NEIGHBOR",
      homeMirror: "/h",
      realMirror: "/real/neighbor",
    });
    assert.equal(p, "/real/neighbor");
  });

  it("returns null for a non-seed in-scope (ad-hoc) node -- read via portuni_read_file", () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    scope.add("ADHOC"); // in scope but not seeded
    const p = readableMirrorRoot({
      scope,
      nodeId: "ADHOC",
      homeMirror: "/h",
      realMirror: "/real/adhoc",
    });
    assert.equal(p, null);
  });
});

describe("ScopeReconciler (sweep-only, no staging)", () => {
  it("never stages a node -- reconcileNode returns null", async () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    const r = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ HOME: home, NEIGHBOR: neighbor }),
    });
    assert.equal(await r.reconcileNode("NEIGHBOR"), null);
    // No copy was made under the home mirror.
    await assert.rejects(() => readFile(join(home, ".portuni-scope", "NEIGHBOR", "wip", "method.md")));
  });

  it("sweeps stale staged copies from a prior session on first reconcile", async () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    await mkdir(join(home, ".portuni-scope", "OLD"), { recursive: true });
    await writeFile(join(home, ".portuni-scope", "OLD", "x.md"), "stale\n");
    const r = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ HOME: home }),
    });
    await r.reconcileNode("HOME");
    await assert.rejects(
      () => readFile(join(home, ".portuni-scope", "OLD", "x.md"), "utf8"),
      "stale leftover must be swept",
    );
  });

  it("returns null when there is no home node", async () => {
    const scope = new SessionScope("strict"); // homeNodeId stays null
    const r = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ NEIGHBOR: neighbor }),
    });
    assert.equal(await r.reconcileNode("NEIGHBOR"), null);
  });
});
