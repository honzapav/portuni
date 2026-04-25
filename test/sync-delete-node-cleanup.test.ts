import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror, getMirrorPath } from "../src/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../src/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-delnode-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("portuni_delete_node purge cleanup", () => {
  it("purge removes the local mirror row on this device", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    assert.ok(await getMirrorPath("U1", nodeId));
    const { purgeNodeLocalCleanup } = await import("../src/tools/nodes.js");
    await purgeNodeLocalCleanup(db, "U1", nodeId);
    assert.equal(await getMirrorPath("U1", nodeId), null);
  });
});
