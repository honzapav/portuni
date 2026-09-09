// removeLocalCopyAndState (#275): shared by every "delete confirmed on the
// remote, now clean up this device's own copy" call site (pending-ops.ts's
// runDelete, engine-mutations.ts's deleteFile, and the central-mode
// counterparts in agent-router.ts / agent-tools.ts) -- file_state must only
// be cleared once local absence is actually confirmed, or the next sync's
// tombstone cleanup loses the only proof it needs to recognize a leftover
// copy and silently re-adopts it instead.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeLocalCopyAndState } from "../apps/server/domain/sync/local-cleanup.js";
import { resetLocalDbForTests, getFileState, upsertFileState } from "../apps/server/domain/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-local-cleanup-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

async function withState(fileId: string, hash: string): Promise<void> {
  await upsertFileState({
    file_id: fileId,
    last_synced_hash: hash,
    cached_local_hash: hash,
    cached_mtime: 0,
    cached_size: 0,
    cached_ino: null,
    cached_dev: null,
  });
}

describe("removeLocalCopyAndState", () => {
  it("removes an existing file and clears file_state", async () => {
    const p = join(workspace, "a.md");
    await writeFile(p, "content");
    await withState("F1", "hash1");

    const r = await removeLocalCopyAndState(p, "F1");
    assert.equal(r.localRemoved, true);
    await assert.rejects(() => readFile(p));
    assert.equal(await getFileState("F1"), null);
  });

  it("a null localPath (no mirror copy at all) still clears file_state", async () => {
    await withState("F2", "hash2");
    const r = await removeLocalCopyAndState(null, "F2");
    assert.equal(r.localRemoved, true);
    assert.equal(await getFileState("F2"), null);
  });

  it("an already-absent path counts as removed (rm force:true is not an error for ENOENT)", async () => {
    await withState("F3", "hash3");
    const r = await removeLocalCopyAndState(join(workspace, "never-existed.md"), "F3");
    assert.equal(r.localRemoved, true);
    assert.equal(await getFileState("F3"), null);
  });

  it("a real local-removal failure preserves file_state instead of clearing it", async () => {
    // A directory at the target path makes rm(path, {force:true}) (no
    // recursive) throw EISDIR -- the same "something went wrong locally"
    // shape a permission error would produce.
    const p = join(workspace, "blocked.md");
    await mkdir(p);
    await withState("F4", "hash4");

    const r = await removeLocalCopyAndState(p, "F4");
    assert.equal(r.localRemoved, false);
    const state = await getFileState("F4");
    assert.ok(state, "file_state must survive a failed removal");
    assert.equal(state!.last_synced_hash, "hash4");
  });
});
