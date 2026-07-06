// The session wires ScopeReconciler to scope.onAdd. Staging is retired, so the
// wiring's job is now the one-time legacy .portuni-scope sweep: adding a node
// to scope fires the reconciler, which clears any stale pre-real-path copies.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { createScopeReconciler } from "../apps/server/mcp/scope-reconciler.js";

let dir: string, home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-wiring-"));
  home = join(dir, "home");
  await mkdir(home, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scope.onAdd -> reconciler wiring", () => {
  it("fires the reconciler sweep when a node is added to scope", async () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    // Stale leftover from a pre-real-path session.
    await mkdir(join(home, ".portuni-scope", "OLD"), { recursive: true });
    await writeFile(join(home, ".portuni-scope", "OLD", "x.md"), "stale\n");
    const reconciler = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: async (_u, id) => (id === "HOME" ? home : null),
    });
    // The exact wiring createMcpServer performs:
    scope.onAdd((id) => reconciler.schedule(id));

    scope.add("HOME");
    // schedule() is fire-and-forget; await the deterministic reconcile.
    await reconciler.reconcileNode("HOME");
    await assert.rejects(
      () => readFile(join(home, ".portuni-scope", "OLD", "x.md"), "utf8"),
      "stale leftover must be swept via the onAdd wiring",
    );
  });
});
