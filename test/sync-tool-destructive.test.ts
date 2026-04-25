import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import {
  storeFile,
  moveFile,
  deleteFile,
  renameFolder,
  adoptFiles,
} from "../src/sync/engine.js";
import { registerMirror } from "../src/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../src/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-destructive-"));
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

describe("confirm-first contract for destructive tools", () => {
  it("moveFile without confirmed returns preview", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, "m.txt");
    await writeFile(src, "m");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const r = await moveFile(db, { userId: "U1", fileId: file_id, newSection: "outputs" });
    assert.equal((r as { requires_confirmation?: boolean }).requires_confirmation, true);
  });

  it("deleteFile without confirmed returns preview", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, "d.txt");
    await writeFile(src, "d");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const r = await deleteFile(db, { userId: "U1", fileId: file_id });
    assert.equal((r as { requires_confirmation?: boolean }).requires_confirmation, true);
  });

  it("renameFolder dry_run default is true (preview)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const r = await renameFolder(db, {
      userId: "U1",
      nodeId,
      oldPrefix: "wip/x",
      newPrefix: "wip/y",
    });
    assert.equal(r.type, "preview");
  });

  it("adoptFiles is not destructive, no confirm needed", async () => {
    const { db, nodeId } = await makeSharedDb();
    const r = await adoptFiles(db, { userId: "U1", nodeId, paths: [] });
    assert.equal(r.adopted.length, 0);
    assert.equal(r.skipped.length, 0);
  });
});
