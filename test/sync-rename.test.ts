import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { storeFile } from "../src/domain/sync/engine.js";
import { renameFile } from "../src/domain/sync/engine-mutations.js";
import { getAdapter } from "../src/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { stat } from "node:fs/promises";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-rename-"));
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
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("renameFile", () => {
  it("renames remote + local + DB row, preserving section/subpath", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip", "docs"), { recursive: true });
    const src = join(mirrorRoot, "wip", "docs", "old.md");
    await writeFile(src, "body");
    const { file_id, remote_path } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    assert.ok(remote_path.endsWith("/wip/docs/old.md"));

    const r = await renameFile(db, { userId: "U1", fileId: file_id, newFilename: "new.md" });
    assert.equal(r.new_filename, "new.md");
    assert.ok(r.new_remote_path.endsWith("/wip/docs/new.md"));

    assert.equal(await exists(join(mirrorRoot, "wip", "docs", "old.md")), false);
    assert.equal(await exists(join(mirrorRoot, "wip", "docs", "new.md")), true);

    const row = await db.execute({
      sql: "SELECT filename, remote_path FROM files WHERE id = ?",
      args: [file_id],
    });
    assert.equal(row.rows[0].filename, "new.md");
    assert.ok((row.rows[0].remote_path as string).endsWith("/wip/docs/new.md"));

    // remote object moved too
    const adapter = await getAdapter(db, "test-fs");
    assert.ok(await adapter.stat(r.new_remote_path));
  });

  it("local rename failure after remote rename still updates the DB and reports repair_needed", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const src = join(mirrorRoot, "wip", "old.md");
    await writeFile(src, "body");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });

    // Force a non-ENOENT local rename failure: a non-empty directory sits
    // where the renamed file should land (ENOTEMPTY/EISDIR).
    await mkdir(join(mirrorRoot, "wip", "new.md", "child"), { recursive: true });

    const r = await renameFile(db, { userId: "U1", fileId: file_id, newFilename: "new.md" });
    assert.equal(r.status, "repair_needed");
    assert.ok(r.repair_hint && r.repair_hint.length > 0);

    // The remote already moved, so the DB row MUST point at the new path --
    // the old behavior threw before the UPDATE and orphaned the file.
    const row = await db.execute({
      sql: "SELECT filename, remote_path FROM files WHERE id = ?",
      args: [file_id],
    });
    assert.equal(row.rows[0].filename, "new.md");
    assert.ok((row.rows[0].remote_path as string).endsWith("/wip/new.md"));
    const adapter = await getAdapter(db, "test-fs");
    assert.ok(await adapter.stat(r.new_remote_path), "remote object lives at the new path");
  });

  it("successful rename reports status ok", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const src = join(mirrorRoot, "wip", "a.md");
    await writeFile(src, "x");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const r = await renameFile(db, { userId: "U1", fileId: file_id, newFilename: "b.md" });
    assert.equal(r.status, "ok");
  });

  it("rejects an unsafe filename", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(mirrorRoot, "wip", "a.md");
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(src, "x");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    await assert.rejects(
      () => renameFile(db, { userId: "U1", fileId: file_id, newFilename: "../evil.md" }),
      (e: unknown) => e instanceof Error && /Invalid filename/i.test((e as Error).message),
    );
  });
});
