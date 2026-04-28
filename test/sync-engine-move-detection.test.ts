import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, rename as fsRename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, statusScan } from "../src/domain/sync/engine.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-movedet-"));
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

describe("statusScan move detection", () => {
  it("proposes a move when a deleted local and new local share a hash", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(workspace, "s.txt");
    await writeFile(src, "unique-content-xyz");
    const { file_id, local_path } = await storeFile(db, {
      userId: "U1",
      nodeId,
      localPath: src,
    });
    // Move locally (simulate user reorganization): take the stored file out of wip/, put in outputs/.
    await mkdir(join(mirrorRoot, "outputs"), { recursive: true });
    const newPath = join(mirrorRoot, "outputs", "moved.txt");
    await fsRename(local_path, newPath);
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    const match = scan.moved.find((m) => m.file_id === file_id);
    assert.ok(match, "expected a move proposal");
    assert.equal(match!.new_local_path, newPath);
  });
});
