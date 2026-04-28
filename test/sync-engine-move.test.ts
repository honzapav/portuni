import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, moveFile } from "../src/domain/sync/engine.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-move-"));
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

describe("moveFile", () => {
  it("preview without confirmed", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(workspace, "m.txt");
    await writeFile(src, "m");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const r = await moveFile(db, { userId: "U1", fileId: file_id, newSubpath: "archive" });
    assert.equal((r as { requires_confirmation?: boolean }).requires_confirmation, true);
  });
  it("confirmed: renames remote + local + DB in lockstep", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(workspace, "m.txt");
    await writeFile(src, "m");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const oldLocal = join(mirrorRoot, "wip", "m.txt");
    assert.ok(await exists(oldLocal));
    await moveFile(db, {
      userId: "U1",
      fileId: file_id,
      newSection: "outputs",
      confirmed: true,
    });
    assert.equal(await exists(oldLocal), false);
    assert.ok(await exists(join(mirrorRoot, "outputs", "m.txt")));
    const row = await db.execute({
      sql: "SELECT remote_path FROM files WHERE id = ?",
      args: [file_id],
    });
    assert.ok((row.rows[0].remote_path as string).includes("/outputs/"));
  });
});
