// Tombstone reconciliation (GH #79): a file deleted on a plane this device
// cannot see (web UI, another device) leaves an untracked local copy behind.
// Discovery matches it against the node's delete tombstones — path + a
// file_state row for the tombstoned id + last_synced_hash equal to the
// current disk hash — and classifies it deleted_remote instead of new_local,
// so adopt/store cannot resurrect the deletion. The sync run then removes
// the local copy and the orphaned file_state row. A file modified after the
// delete fails the hash check and stays new_local: data is never destroyed.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import type { Client } from "@libsql/client";
import { makeSharedDb } from "./helpers/shared-db.js";
import {
  storeFile,
  statusScan,
  cleanupDeletedRemote,
} from "../apps/server/domain/sync/engine.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import {
  getFileState,
  upsertFileState,
  resetLocalDbForTests,
} from "../apps/server/domain/sync/local-db.js";
import { md5Buffer } from "../apps/server/domain/sync/hash.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-tombstone-"));
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

// Push a file, then simulate a deletion observed elsewhere: the files row is
// gone and a sync_delete tombstone exists, but the local copy and file_state
// survive on this device.
async function arrangeTombstonedFile(
  db: Client,
  nodeId: string,
  mirrorRoot: string,
): Promise<{ fileId: string; localPath: string; remotePath: string }> {
  await mkdir(join(mirrorRoot, "wip"), { recursive: true });
  const localPath = join(mirrorRoot, "wip", "a.md");
  await writeFile(localPath, "obsah");
  const r = await storeFile(db, { userId: "U1", nodeId, localPath });
  await db.execute({ sql: "DELETE FROM files WHERE id = ?", args: [r.file_id] });
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, 'U1', 'sync_delete', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      r.file_id,
      JSON.stringify({ node_id: nodeId, remote_path: r.remote_path }),
      new Date().toISOString(),
    ],
  });
  return { fileId: r.file_id, localPath, remotePath: r.remote_path };
}

describe("tombstone reconciliation in discovery", () => {
  it("classifies an untracked disk file matching a tombstone as deleted_remote", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const { fileId } = await arrangeTombstonedFile(db, nodeId, mirrorRoot);

    const r = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    assert.equal(r.new_local.length, 0);
    assert.equal(r.deleted_remote.length, 1);
    assert.equal(r.deleted_remote[0].file_id, fileId);
  });

  it("keeps a file modified after the remote delete as new_local", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const { localPath } = await arrangeTombstonedFile(db, nodeId, mirrorRoot);
    await writeFile(localPath, "obsah upraveny po smazani");

    const r = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    assert.equal(r.deleted_remote.length, 0);
    assert.equal(r.new_local.length, 1);
  });

  it("ignores repair_needed audit rows (remote copy still exists)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const { fileId } = await arrangeTombstonedFile(db, nodeId, mirrorRoot);
    // Rewrite the tombstone as repair_needed — must NOT match.
    await db.execute({
      sql: "UPDATE audit_log SET action = 'sync_delete_repair_needed' WHERE target_id = ?",
      args: [fileId],
    });

    const r = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    assert.equal(r.deleted_remote.length, 0);
    assert.equal(r.new_local.length, 1);
  });
});

describe("tombstone matching across hash algorithms", () => {
  it("matches when the synced baseline is a Drive-style md5 hash", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const { fileId } = await arrangeTombstonedFile(db, nodeId, mirrorRoot);
    // Drive reports md5 as the canonical hash; the discovery walk computes
    // sha256. A naive comparison would never match and silently disable the
    // cleanup on Drive-backed files.
    await upsertFileState({
      file_id: fileId,
      last_synced_hash: md5Buffer(Buffer.from("obsah")),
      cached_local_hash: null,
      cached_mtime: null,
      cached_size: null,
    });

    const r = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    assert.equal(r.deleted_remote.length, 1);
    assert.equal(r.deleted_remote[0].file_id, fileId);
  });
});

describe("cleanupDeletedRemote (sync-run cleanup)", () => {
  it("removes the local copy and the file_state row", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const { fileId, localPath } = await arrangeTombstonedFile(db, nodeId, mirrorRoot);

    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    const { cleaned, errors } = await cleanupDeletedRemote(scan.deleted_remote);
    assert.equal(errors.length, 0);
    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0].file_id, fileId);
    await assert.rejects(() => stat(localPath));
    assert.equal(await getFileState(fileId), null);
  });

  it("leaves a post-delete edit untouched (stays new_local)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const { localPath } = await arrangeTombstonedFile(db, nodeId, mirrorRoot);
    await writeFile(localPath, "novy obsah");

    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    await cleanupDeletedRemote(scan.deleted_remote);
    const st = await stat(localPath);
    assert.ok(st.isFile());
    assert.equal(scan.new_local.length, 1);
  });
});

describe("move tombstones", () => {
  it("an untracked copy left at a moved-from path is cleaned up, not adopted", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const oldLocal = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldLocal, "obsah");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath: oldLocal });
    // Move through Portuni; then put the old copy back as if this device
    // had missed the local step (another device, or a failed front door).
    const { moveFile } = await import("../apps/server/domain/sync/engine-mutations.js");
    const mv = await moveFile(db, { userId: "U1", fileId: r.file_id, newSection: "outputs", confirmed: true });
    assert.equal("status" in mv && mv.status, "ok");
    await writeFile(oldLocal, "obsah");
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    assert.equal(scan.new_local.length, 0, "old copy must not surface as new_local");
    assert.equal(scan.deleted_remote.length, 1);
    assert.equal(scan.deleted_remote[0].record_alive, true);
    const cleaned = await cleanupDeletedRemote(scan.deleted_remote);
    assert.equal(cleaned.cleaned.length, 1);
    await assert.rejects(() => stat(oldLocal));
    assert.ok(await getFileState(r.file_id), "file_state of a live record must survive");
  });

  it("an old copy edited after the move stays new_local", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const oldLocal = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldLocal, "obsah");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath: oldLocal });
    const { moveFile } = await import("../apps/server/domain/sync/engine-mutations.js");
    await moveFile(db, { userId: "U1", fileId: r.file_id, newSection: "outputs", confirmed: true });
    await writeFile(oldLocal, "obsah upraveny");
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    assert.equal(scan.new_local.length, 1);
    assert.equal(scan.deleted_remote.length, 0);
  });
});
