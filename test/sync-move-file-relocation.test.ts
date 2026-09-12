import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile } from "../apps/server/domain/sync/engine.js";
import { moveFile } from "../apps/server/domain/sync/engine-mutations.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { resetLocalDbForTests, getFileState, upsertFileState } from "../apps/server/domain/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-move-relocation-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  process.env.PORTUNI_AGENT_MODE = "1";
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  delete process.env.PORTUNI_AGENT_MODE;
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

describe("moveFile retry-safety and destination collision handling", () => {
  it("reports already_at_target instead of failing when a previous attempt's remote step already landed", async () => {
    const { db, nodeId, remoteRoot, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");

    // Simulate a prior moveFile call whose remote step succeeded but whose
    // DB update never landed (e.g. a client-side timeout).
    const nodeRoot = `${orgSyncKey}/projects/${nodeSyncKey}`;
    const dest = `${nodeRoot}/outputs/a.md`;
    await mkdir(join(remoteRoot, nodeRoot, "outputs"), { recursive: true });
    await rename(join(remoteRoot, r.remote_path), join(remoteRoot, dest));

    const mv = await moveFile(db, {
      userId: "U1",
      fileId: r.file_id,
      newSection: "outputs",
      confirmed: true,
    });
    assert.equal("status" in mv && mv.status, "ok");
    assert.equal((mv as { detail: Record<string, unknown> }).detail.already_at_target, true);
    const row = await db.execute({ sql: "SELECT remote_path FROM files WHERE id = ?", args: [r.file_id] });
    assert.equal(row.rows[0].remote_path, dest);
  });

  it("merges into a row the watcher already registered at the destination path instead of raising a UNIQUE error", async () => {
    const { db, nodeId, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");

    // A "shadow" row claiming the destination path -- as if the watcher
    // had registered a file there moments before this move landed.
    const nodeRoot = `${orgSyncKey}/projects/${nodeSyncKey}`;
    const destRemotePath = `${nodeRoot}/outputs/a.md`;
    await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, status, created_by)
            VALUES (?, ?, ?, ?, ?, 'output', 'U1')`,
      args: ["F-SHADOW", nodeId, "a.md", "test-fs", destRemotePath],
    });
    await upsertFileState({
      file_id: "F-SHADOW",
      last_synced_hash: null,
      cached_local_hash: "shadow-hash",
      cached_mtime: 111,
      cached_size: 222,
      cached_ino: 333,
      cached_dev: 444,
    });

    const mv = await moveFile(db, {
      userId: "U1",
      fileId: r.file_id,
      newSection: "outputs",
      confirmed: true,
    });
    assert.equal("status" in mv && mv.status, "ok");

    // The shadow row is gone; the moved file kept its own id at the
    // destination -- exactly one row survives at that path.
    const shadow = await db.execute({ sql: "SELECT id FROM files WHERE id = 'F-SHADOW'" });
    assert.equal(shadow.rows.length, 0);
    const survivor = await db.execute({
      sql: "SELECT id, remote_path FROM files WHERE node_id = ? AND remote_path = ?",
      args: [nodeId, destRemotePath],
    });
    assert.equal(survivor.rows.length, 1);
    assert.equal(survivor.rows[0].id, r.file_id);

    // file_state merged: the survivor's own synced baseline is kept, the
    // shadow's (fresher) local-cache fields are adopted.
    const state = await getFileState(r.file_id);
    assert.equal(state?.last_synced_hash, r.hash);
    assert.equal(state?.cached_local_hash, "shadow-hash");
    assert.equal(await getFileState("F-SHADOW"), null);
  });
});
