import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile } from "../apps/server/domain/sync/engine.js";
import { remoteSweep } from "../apps/server/domain/sync/remote-sweep.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { registerLocalFile } from "../apps/server/domain/sync/engine.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests, setAdapterForTests } from "../apps/server/domain/sync/adapter-cache.js";
import type { FileAdapter, FileRef } from "../apps/server/domain/sync/types.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-sweep-"));
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

async function pushed(db: Awaited<ReturnType<typeof makeSharedDb>>["db"], nodeId: string, mirrorRoot: string, name: string) {
  await mkdir(join(mirrorRoot, "wip"), { recursive: true });
  const localPath = join(mirrorRoot, "wip", name);
  await writeFile(localPath, `obsah ${name}`);
  return storeFile(db, { userId: "U1", nodeId, localPath });
}

// A minimal FileAdapter double that reports a single native-format remote
// object (the shape drive-adapter.ts's fileRefFrom produces for a Google
// Doc/Sheet/Slide: hash null by construction) and fails loudly if the
// sweep ever tries to fetch its bytes -- the real Drive API rejects
// alt=media for native files, so a naive hash backfill would hit exactly
// this. Everything else is unused by the adoption path and throws if
// called, so an unexpected call surfaces as a test failure instead of
// silently no-opping.
function fakeNativeAdapter(nativeRef: FileRef): FileAdapter {
  return {
    async put() {
      throw new Error("fakeNativeAdapter: put not implemented");
    },
    async get(path) {
      throw new Error(`fakeNativeAdapter: native files have no bytes to fetch via alt=media (${path})`);
    },
    async stat(path) {
      return path === nativeRef.path ? nativeRef : null;
    },
    async list() {
      return [nativeRef];
    },
    async delete() {
      throw new Error("fakeNativeAdapter: delete not implemented");
    },
    async rename() {
      throw new Error("fakeNativeAdapter: rename not implemented");
    },
    async url() {
      throw new Error("fakeNativeAdapter: url not implemented");
    },
  };
}

describe("remoteSweep", () => {
  it("removes the record of a file deleted on the remote and writes a tombstone", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    await rm(join(remoteRoot, r.remote_path));
    const out = await remoteSweep(db, { userId: "U1", nodeId });
    assert.deepEqual(out.deleted_on_remote.map((f) => f.file_id), [r.file_id]);
    const row = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [r.file_id] });
    assert.equal(row.rows.length, 0);
    const tomb = await db.execute({
      sql: `SELECT json_extract(detail, '$.node_id') AS n, json_extract(detail, '$.remote_path') AS p, json_extract(detail, '$.reason') AS reason
            FROM audit_log WHERE action = 'sync_delete_remote' AND target_id = ?`,
      args: [r.file_id],
    });
    assert.equal(tomb.rows.length, 1);
    assert.equal(tomb.rows[0].n, nodeId);
    assert.equal(tomb.rows[0].p, r.remote_path);
    assert.equal(tomb.rows[0].reason, "remote_sweep");
  });

  it("leaves a registered-but-never-pushed record alone", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const localPath = join(mirrorRoot, "wip", "pending.md");
    await writeFile(localPath, "not pushed yet");
    const reg = await registerLocalFile(db, { userId: "U1", nodeId, localPath });
    const out = await remoteSweep(db, { userId: "U1", nodeId });
    assert.equal(out.deleted_on_remote.length, 0);
    const row = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [reg.file_id] });
    assert.equal(row.rows.length, 1);
  });

  it("adopts a file that appeared on the remote under a tracked section", async () => {
    const { db, nodeId, remoteRoot, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const nodeRoot = `${orgSyncKey}/projects/${nodeSyncKey}`;
    await mkdir(join(remoteRoot, nodeRoot, "outputs"), { recursive: true });
    await writeFile(join(remoteRoot, nodeRoot, "outputs", "report.md"), "from drive");
    await mkdir(join(remoteRoot, nodeRoot, "wip"), { recursive: true });
    await writeFile(join(remoteRoot, nodeRoot, "wip", ".DS_Store"), "junk");
    await writeFile(join(remoteRoot, nodeRoot, "notes.txt"), "outside sections");
    const out = await remoteSweep(db, { userId: "U1", nodeId });
    assert.deepEqual(out.adopted.map((f) => f.remote_path), [`${nodeRoot}/outputs/report.md`]);
    const row = await db.execute({
      sql: "SELECT status, current_remote_hash FROM files WHERE id = ?",
      args: [out.adopted[0].file_id],
    });
    assert.equal(row.rows[0].status, "output");
    assert.ok(row.rows[0].current_remote_hash);
  });

  it("adopts a native-format remote file without a hash backfill or a spurious error", async () => {
    const { db, nodeId, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const nodeRoot = `${orgSyncKey}/projects/${nodeSyncKey}`;
    const nativePath = `${nodeRoot}/outputs/Quarterly Report`;
    const nativeRef: FileRef = {
      path: nativePath,
      hash: null,
      size: 0,
      modified_at: new Date(),
      is_native_format: true,
      native_format: "gdoc",
    };
    setAdapterForTests("test-fs", fakeNativeAdapter(nativeRef));
    const out = await remoteSweep(db, { userId: "U1", nodeId });
    assert.deepEqual(out.adopted.map((f) => f.remote_path), [nativePath]);
    assert.deepEqual(out.errors, []);
    const row = await db.execute({
      sql: "SELECT current_remote_hash, is_native_format FROM files WHERE id = ?",
      args: [out.adopted[0].file_id],
    });
    assert.equal(row.rows[0].current_remote_hash, null);
    assert.equal(Number(row.rows[0].is_native_format), 1);
  });

  it("does not delete anything when the listing fails", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    await rm(remoteRoot, { recursive: true, force: true }); // whole remote gone = unreachable
    const out = await remoteSweep(db, { userId: "U1", nodeId });
    assert.equal(out.deleted_on_remote.length, 0);
    assert.equal(out.errors.length, 1);
    const row = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [r.file_id] });
    assert.equal(row.rows.length, 1);
  });
});
