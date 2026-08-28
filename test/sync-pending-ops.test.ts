import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, rename, stat, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile } from "../apps/server/domain/sync/engine.js";
import { moveFile, deleteFile } from "../apps/server/domain/sync/engine-mutations.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import {
  resetAdapterCacheForTests,
  setAdapterForTests,
  getAdapter,
} from "../apps/server/domain/sync/adapter-cache.js";
import {
  enqueuePendingOp,
  listPendingOps,
  retryPendingFileOps,
} from "../apps/server/domain/sync/pending-ops.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-pending-ops-"));
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

async function pushed(
  db: Awaited<ReturnType<typeof makeSharedDb>>["db"],
  nodeId: string,
  mirrorRoot: string,
  name: string,
) {
  await mkdir(join(mirrorRoot, "wip"), { recursive: true });
  const localPath = join(mirrorRoot, "wip", name);
  await writeFile(localPath, `obsah ${name}`);
  return storeFile(db, { userId: "U1", nodeId, localPath });
}

describe("pending file ops", () => {
  it("a completed move leaves no pending op", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    await moveFile(db, { userId: "U1", fileId: r.file_id, newSection: "outputs", confirmed: true });
    assert.equal((await listPendingOps(db, nodeId)).length, 0);
  });

  it("a move whose remote step fails stays pending and is completed by the retry", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    // Break the remote: make the rename fail once by replacing the adapter.
    const real = await getAdapter(db, "test-fs");
    let fail = true;
    const broken = {
      ...real,
      rename: async (from: string, to: string) => {
        if (fail) throw new Error("boom");
        return real.rename(from, to);
      },
    };
    setAdapterForTests("test-fs", broken);
    const mv = await moveFile(db, { userId: "U1", fileId: r.file_id, newSection: "outputs", confirmed: true });
    assert.equal("status" in mv && mv.status, "repair_needed");
    const pending = await listPendingOps(db, nodeId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].payload.op, "move");
    assert.equal(pending[0].last_error, "boom");
    fail = false;
    const retry = await retryPendingFileOps(db, { userId: "U1", nodeId });
    assert.deepEqual(retry.repaired, [{ file_id: r.file_id, op: "move", filename: "a.md" }]);
    assert.equal((await listPendingOps(db, nodeId)).length, 0);
    const row = await db.execute({ sql: "SELECT remote_path FROM files WHERE id = ?", args: [r.file_id] });
    assert.ok((row.rows[0].remote_path as string).includes("/outputs/"));
    assert.ok(await stat(join(remoteRoot, row.rows[0].remote_path as string)));
  });

  it("retry of a move already applied on the remote only fixes the record", async () => {
    const { db, nodeId, remoteRoot, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    const nodeRoot = `${orgSyncKey}/projects/${nodeSyncKey}`;
    const to = `${nodeRoot}/outputs/a.md`;
    await mkdir(join(remoteRoot, nodeRoot, "outputs"), { recursive: true });
    await rename(join(remoteRoot, r.remote_path), join(remoteRoot, to));
    await enqueuePendingOp(db, {
      userId: "U1",
      nodeId,
      fileId: r.file_id,
      payload: {
        op: "move",
        from_remote_name: "test-fs",
        from_remote_path: r.remote_path,
        to_remote_name: "test-fs",
        to_remote_path: to,
        to_node_id: nodeId,
        filename: "a.md",
      },
    });
    const retry = await retryPendingFileOps(db, { userId: "U1", nodeId });
    assert.equal(retry.repaired.length, 1);
    const row = await db.execute({ sql: "SELECT remote_path FROM files WHERE id = ?", args: [r.file_id] });
    assert.equal(row.rows[0].remote_path, to);
  });

  it("a delete whose remote step fails is completed by the retry and leaves a tombstone", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    const real = await getAdapter(db, "test-fs");
    let fail = true;
    const broken = {
      ...real,
      delete: async (p: string) => {
        if (fail) throw new Error("boom");
        return real.delete(p);
      },
    };
    setAdapterForTests("test-fs", broken);
    const d = await deleteFile(db, { userId: "U1", fileId: r.file_id, confirmed: true });
    assert.equal(d.status, "repair_needed");
    fail = false;
    const retry = await retryPendingFileOps(db, { userId: "U1", nodeId });
    assert.deepEqual(retry.repaired, [{ file_id: r.file_id, op: "delete", filename: "a.md" }]);
    const row = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [r.file_id] });
    assert.equal(row.rows.length, 0);
    const tomb = await db.execute({
      sql: "SELECT id FROM audit_log WHERE action = 'sync_delete' AND target_id = ?",
      args: [r.file_id],
    });
    assert.equal(tomb.rows.length, 1);
  });

  it("an op targeting an already-gone record and remote object completes as a no-op delete (idempotent)", async () => {
    const { db, nodeId } = await makeSharedDb();
    await enqueuePendingOp(db, {
      userId: "U1",
      nodeId,
      fileId: "F-missing",
      payload: {
        op: "delete",
        remote_name: "test-fs",
        remote_path: "workflow/projects/stan-gws/wip/x.md",
        filename: "x.md",
      },
    });
    const retry = await retryPendingFileOps(db, { userId: "U1", nodeId });
    // The record is gone and the remote object never existed: the op can
    // complete as a no-op delete (idempotent).
    assert.equal(retry.repaired.length, 1);
  });

  it("an op whose executor keeps failing is reported with attempts/last_error, not dropped", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    const real = await getAdapter(db, "test-fs");
    const broken = {
      ...real,
      stat: async () => {
        throw new Error("stat unavailable");
      },
    };
    setAdapterForTests("test-fs", broken);
    await enqueuePendingOp(db, {
      userId: "U1",
      nodeId,
      fileId: r.file_id,
      payload: { op: "delete", remote_name: "test-fs", remote_path: r.remote_path, filename: "a.md" },
    });

    const retry1 = await retryPendingFileOps(db, { userId: "U1", nodeId });
    assert.equal(retry1.repaired.length, 0);
    assert.equal(retry1.pending_repairs.length, 1);
    assert.equal(retry1.pending_repairs[0].attempts, 1);
    assert.equal(retry1.pending_repairs[0].last_error, "stat unavailable");
    const pendingAfterFirst = await listPendingOps(db, nodeId);
    assert.equal(pendingAfterFirst.length, 1);
    assert.equal(pendingAfterFirst[0].attempts, 1);
    assert.equal(pendingAfterFirst[0].last_error, "stat unavailable");

    const retry2 = await retryPendingFileOps(db, { userId: "U1", nodeId });
    assert.equal(retry2.pending_repairs[0].attempts, 2);
    const pendingAfterSecond = await listPendingOps(db, nodeId);
    assert.equal(pendingAfterSecond.length, 1);
    assert.equal(pendingAfterSecond[0].attempts, 2);
  });

  it("a move whose source and destination BOTH exist on the remote fails without deleting either", async () => {
    const { db, nodeId, remoteRoot, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    const nodeRoot = `${orgSyncKey}/projects/${nodeSyncKey}`;
    const to = `${nodeRoot}/outputs/a.md`;
    await mkdir(join(remoteRoot, nodeRoot, "outputs"), { recursive: true });
    // Copy (not move): both the source and destination objects exist on the
    // remote at once, the ambiguous case the executor must refuse to guess
    // its way out of.
    await copyFile(join(remoteRoot, r.remote_path), join(remoteRoot, to));
    await enqueuePendingOp(db, {
      userId: "U1",
      nodeId,
      fileId: r.file_id,
      payload: {
        op: "move",
        from_remote_name: "test-fs",
        from_remote_path: r.remote_path,
        to_remote_name: "test-fs",
        to_remote_path: to,
        to_node_id: nodeId,
        filename: "a.md",
      },
    });

    const retry = await retryPendingFileOps(db, { userId: "U1", nodeId });
    assert.equal(retry.repaired.length, 0);
    assert.equal(retry.pending_repairs.length, 1);
    assert.match(retry.pending_repairs[0].last_error ?? "", /both/);
    // Neither remote object was touched.
    assert.ok(await stat(join(remoteRoot, r.remote_path)));
    assert.ok(await stat(join(remoteRoot, to)));
    // The record is untouched too.
    const row = await db.execute({ sql: "SELECT remote_path FROM files WHERE id = ?", args: [r.file_id] });
    assert.equal(row.rows[0].remote_path, r.remote_path);
  });

  it("a stale delete op refuses to remove a different file's remote object that now occupies its path", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const a = await pushed(db, nodeId, mirrorRoot, "a.md");
    // A pending delete op for file "a" targeting its remote path...
    await enqueuePendingOp(db, {
      userId: "U1",
      nodeId,
      fileId: a.file_id,
      payload: { op: "delete", remote_name: "test-fs", remote_path: a.remote_path, filename: "a.md" },
    });
    // ...but the record for "a" is gone (deleted out of band) and a
    // DIFFERENT file "b" now claims that exact remote path.
    await db.execute({ sql: "DELETE FROM files WHERE id = ?", args: [a.file_id] });
    await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, status, created_by)
            VALUES (?, ?, ?, ?, ?, 'wip', 'U1')`,
      args: ["F-B", nodeId, "a.md", "test-fs", a.remote_path],
    });

    const retry = await retryPendingFileOps(db, { userId: "U1", nodeId });
    assert.equal(retry.repaired.length, 0);
    assert.equal(retry.pending_repairs.length, 1);
    assert.match(retry.pending_repairs[0].last_error ?? "", /claimed by a different file/);
    // File B's remote object must still be there.
    assert.ok(await stat(join(remoteRoot, a.remote_path)));
    const row = await db.execute({ sql: "SELECT id FROM files WHERE id = 'F-B'" });
    assert.equal(row.rows.length, 1);
  });
});
