// Tests for the scope reconciler: the single path that projects the
// authoritative SessionScope set onto disk. When a node enters scope it
// is staged read-only into <home>/.portuni-scope/<id>/. The home node is
// never staged (it is already rw). Missing mirrors degrade to null.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionScope } from "../apps/server/mcp/scope.js";
import {
  stagedMirrorRoot,
  createScopeReconciler,
} from "../apps/server/mcp/scope-reconciler.js";

let dir: string;
let home: string;
let neighbor: string;

// The reconciler resolves mirrors via getMirrorPath(userId, nodeId). We
// inject a fake by overriding the module's resolver through the documented
// `resolveMirror` option (see createScopeReconciler args below).
function fakeResolver(map: Record<string, string>) {
  return async (_userId: string, nodeId: string) => map[nodeId] ?? null;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-reconciler-"));
  home = join(dir, "home");
  neighbor = join(dir, "neighbor");
  await mkdir(join(home, "wip"), { recursive: true });
  await mkdir(join(neighbor, "wip"), { recursive: true });
  await writeFile(join(neighbor, "wip", "method.md"), "# method\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("stagedMirrorRoot", () => {
  it("is home/.portuni-scope/<id>", () => {
    assert.equal(stagedMirrorRoot("/h", "01N"), join("/h", ".portuni-scope", "01N"));
  });
});

describe("ScopeReconciler.reconcileNode", () => {
  it("stages a non-home node's mirror into the home .portuni-scope dir", async () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    const r = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ HOME: home, NEIGHBOR: neighbor }),
    });
    const res = await r.reconcileNode("NEIGHBOR");
    assert.ok(res);
    assert.equal(res.staged_path, join(home, ".portuni-scope", "NEIGHBOR"));
    const staged = await readFile(
      join(home, ".portuni-scope", "NEIGHBOR", "wip", "method.md"),
      "utf8",
    );
    assert.equal(staged, "# method\n");
  });

  it("returns null for the home node (never stages itself)", async () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    const r = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ HOME: home }),
    });
    assert.equal(await r.reconcileNode("HOME"), null);
  });

  it("returns null when the node has no local mirror", async () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    const r = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ HOME: home }),
    });
    assert.equal(await r.reconcileNode("GHOST"), null);
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
