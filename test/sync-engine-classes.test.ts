import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, statusScan } from "../apps/server/domain/sync/engine.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests, deleteFileState } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-classes-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("classification without orphan", () => {
  it("remote content this device never synced classifies pull", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const localPath = join(mirrorRoot, "wip", "a.md");
    await writeFile(localPath, "obsah");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath });
    // Simulate a second device: no local copy, no baseline.
    await rm(localPath);
    await deleteFileState(r.file_id);
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: false });
    assert.equal(scan.pull_candidates.length, 1);
    assert.equal(scan.pull_candidates[0].file_id, r.file_id);
    assert.equal(scan.pull_candidates[0].class, "pull");
    assert.ok(!("orphan" in scan), "orphan bucket must be gone");
  });

  it("a record whose remote object vanished after a sync classifies remote_missing", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const localPath = join(mirrorRoot, "wip", "a.md");
    await writeFile(localPath, "obsah");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath });
    await rm(join(remoteRoot, r.remote_path));
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: false });
    assert.equal(scan.remote_missing.length, 1);
    assert.equal(scan.remote_missing[0].class, "remote_missing");
  });
});
