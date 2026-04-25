import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, moveFile, pullFile } from "../src/sync/engine.js";
import { registerMirror } from "../src/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../src/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-drvcache-"));
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

describe("move leaves no stale path reachable (engine integration)", () => {
  it("pullFile after move lands at the NEW path", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(workspace, "d.txt");
    await writeFile(src, "d");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const before = await db.execute({
      sql: "SELECT remote_path FROM files WHERE id = ?",
      args: [file_id],
    });
    const oldRemotePath = before.rows[0].remote_path as string;
    await moveFile(db, {
      userId: "U1",
      fileId: file_id,
      newSection: "outputs",
      confirmed: true,
    });
    const pulled = await pullFile(db, { userId: "U1", fileId: file_id });
    assert.ok(pulled.local_path.includes("/outputs/"));
    const after = await db.execute({
      sql: "SELECT remote_path FROM files WHERE id = ?",
      args: [file_id],
    });
    assert.notEqual(oldRemotePath, after.rows[0].remote_path);
  });
});
