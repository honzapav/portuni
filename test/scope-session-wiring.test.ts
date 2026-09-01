// The session wires DiskProjector to scope.onAdd (the exact wiring
// createMcpServer performs): adding an ad-hoc node to scope fires a
// fire-and-forget hardlink projection of that node's local mirror into the
// session's projection directory (#191).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { createDiskProjector } from "../apps/server/mcp/disk-projection.js";
import { clearProjectionRegistryForTests } from "../apps/server/domain/session-projection.js";

let dir: string, home: string, adhoc: string;
let originalPortuniRoot: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-wiring-"));
  home = join(dir, "home");
  adhoc = join(dir, "adhoc");
  await mkdir(join(home, "wip"), { recursive: true });
  await mkdir(join(adhoc, "wip"), { recursive: true });
  originalPortuniRoot = process.env.PORTUNI_ROOT;
  process.env.PORTUNI_ROOT = dir;
  clearProjectionRegistryForTests();
});
afterEach(async () => {
  if (originalPortuniRoot === undefined) delete process.env.PORTUNI_ROOT;
  else process.env.PORTUNI_ROOT = originalPortuniRoot;
  clearProjectionRegistryForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("scope.onAdd -> disk projector wiring", () => {
  it("projects an ad-hoc node's mirror when it is added to scope", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.sessionId = "SESS";
    await writeFile(join(adhoc, "wip", "x.md"), "content\n");

    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: async (_u, id) => (id === "ADHOC" ? adhoc : null),
    });
    // The exact wiring createMcpServer performs:
    scope.onAdd((id) => projector.schedule(id));

    scope.add("ADHOC");
    // schedule() is fire-and-forget; await the deterministic projection.
    const result = await projector.projectNode("ADHOC");
    assert.ok(result);
    assert.equal(
      await readFile(join(result.dir, "wip", "x.md"), "utf8"),
      "content\n",
    );
  });

  it("does not project the home node itself", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = "HOME";
    scope.sessionId = "SESS";

    const projector = createDiskProjector({
      userId: "u",
      scope,
      resolveMirror: async (_u, id) => (id === "HOME" ? home : null),
    });
    scope.onAdd((id) => projector.schedule(id));

    scope.addSeed("HOME");
    assert.equal(await projector.projectNode("HOME"), null);
  });
});
