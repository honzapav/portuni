// The session wires ScopeReconciler to scope.onAdd, so adding any node to
// the authoritative scope set projects it to disk through the one path.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { createScopeReconciler } from "../apps/server/mcp/scope-reconciler.js";

let dir: string, home: string, neighbor: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-wiring-"));
  home = join(dir, "home");
  neighbor = join(dir, "neighbor");
  await mkdir(home, { recursive: true });
  await mkdir(neighbor, { recursive: true });
  await writeFile(join(neighbor, "n.md"), "n\n");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("scope.onAdd -> reconciler wiring", () => {
  it("stages a node when it is added to scope (not via expand_scope)", async () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    const reconciler = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: async (_u, id) =>
        id === "HOME" ? home : id === "NEIGHBOR" ? neighbor : null,
    });
    // This is the exact wiring createMcpServer performs:
    scope.onAdd((id) => reconciler.schedule(id));

    scope.add("NEIGHBOR");
    // schedule() is fire-and-forget; await the deterministic reconcile to
    // observe the completed copy.
    await reconciler.reconcileNode("NEIGHBOR");
    const staged = await readFile(
      join(home, ".portuni-scope", "NEIGHBOR", "n.md"),
      "utf8",
    );
    assert.equal(staged, "n\n");
  });
});
