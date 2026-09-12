import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, deleteFile, registerLocalFile } from "../apps/server/domain/sync/engine.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { resetLocalDbForTests, getFileState } from "../apps/server/domain/sync/local-db.js";
import { replaceRules } from "../apps/server/domain/sync/routing.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-del-"));
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

  it("complete mode removes the local copy for a row with no routed remote (#254)", async () => {
    // registerLocalFile always computes remote_path deterministically from
    // node identity, but remote_name stays null while routing does not
    // resolve (#201) -- exactly the row shape that used to skip the local
    // rm entirely, since it was gated on remoteName && remotePath together.
    const { db, nodeId } = await makeSharedDb();
    await replaceRules(db, []);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const src = join(mirrorRoot, "wip", "no-route.txt");
    await writeFile(src, "no route");
    const reg = await registerLocalFile(db, { userId: "U1", nodeId, localPath: src });

    const row = await db.execute({
      sql: "SELECT remote_name, remote_path FROM files WHERE id = ?",
      args: [reg.file_id],
    });
    assert.equal(row.rows[0].remote_name, null, "precondition: routing unresolved");
    assert.ok(row.rows[0].remote_path, "precondition: remote_path still computed");

    await deleteFile(db, {
      userId: "U1",
      fileId: reg.file_id,
      mode: "complete",
      confirmed: true,
    });
    assert.equal(await exists(src), false, "local copy must be removed");
    const rr = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [reg.file_id] });
    assert.equal(rr.rows.length, 0);
    assert.equal(await getFileState(reg.file_id), null);
  });

  // #275: file_state used to be deleted unconditionally after a best-effort
  // (swallowed) local rm, even when that rm actually failed -- destroying
  // the only proof (last_synced_hash) a later sync's tombstone cleanup
  // needs to recognize a leftover local copy as this exact confirmed
  // deletion rather than new content to adopt and push back.
  it("complete mode preserves file_state when the local removal itself fails", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(workspace, "blocked.txt");
    await writeFile(src, "d");
    const { file_id, local_path } = await storeFile(db, {
      userId: "U1",
      nodeId,
      localPath: src,
    });
    // Simulate the local removal failing: replace the mirrored file with a
    // directory at the same path. rm(path, {force:true}) (no recursive)
    // throws EISDIR for a directory -- the same "something went wrong
    // locally" shape a permission error would produce.
    await rm(local_path);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(local_path);

    const r = await deleteFile(db, {
      userId: "U1",
      fileId: file_id,
      mode: "complete",
      confirmed: true,
    });
    assert.equal(r.status, "ok", "remote + record deletion still completes");
    const rr = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [file_id] });
    assert.equal(rr.rows.length, 0);
    const state = await getFileState(file_id);
    assert.ok(state, "file_state must survive a failed local removal");
    assert.ok(state!.last_synced_hash, "synced baseline stays intact for a later tombstone match");
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
