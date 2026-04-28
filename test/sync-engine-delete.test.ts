import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, deleteFile } from "../src/domain/sync/engine.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { resetLocalDbForTests, getFileState } from "../src/domain/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-del-"));
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

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("deleteFile", () => {
  it("preview without confirmed", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, "d.txt");
    await writeFile(src, "d");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const r = await deleteFile(db, { userId: "U1", fileId: file_id });
    assert.equal((r as { requires_confirmation?: boolean }).requires_confirmation, true);
  });

  it("complete mode removes remote + local + portuni row", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(workspace, "d.txt");
    await writeFile(src, "d");
    const { file_id, local_path } = await storeFile(db, {
      userId: "U1",
      nodeId,
      localPath: src,
    });
    await deleteFile(db, {
      userId: "U1",
      fileId: file_id,
      mode: "complete",
      confirmed: true,
    });
    assert.equal(await exists(local_path), false);
    const rr = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [file_id] });
    assert.equal(rr.rows.length, 0);
    assert.equal(await getFileState(file_id), null);
  });

  it("unregister_only keeps local + remote", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(workspace, "u.txt");
    await writeFile(src, "u");
    const { file_id, local_path } = await storeFile(db, {
      userId: "U1",
      nodeId,
      localPath: src,
    });
    await deleteFile(db, {
      userId: "U1",
      fileId: file_id,
      mode: "unregister_only",
      confirmed: true,
    });
    assert.ok(await exists(local_path), "local should remain");
    const rr = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [file_id] });
    assert.equal(rr.rows.length, 0);
  });
});
