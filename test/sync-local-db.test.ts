import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLocalDb,
  resetLocalDbForTests,
  upsertFileState,
  getFileState,
  deleteFileState,
  upsertRemoteStat,
  getRemoteStat,
  upsertLocalMirror,
  getLocalMirror,
  deleteLocalMirror,
  listLocalMirrors,
} from "../src/sync/local-db.js";

let workspaceRoot: string;
let prevEnv: string | undefined;

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "portuni-localdb-"));
}

describe("local-db", () => {
  beforeEach(async () => {
    prevEnv = process.env.PORTUNI_WORKSPACE_ROOT;
    workspaceRoot = await makeWorkspace();
    process.env.PORTUNI_WORKSPACE_ROOT = workspaceRoot;
    resetLocalDbForTests();
  });

  afterEach(async () => {
    resetLocalDbForTests();
    if (prevEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
    else process.env.PORTUNI_WORKSPACE_ROOT = prevEnv;
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("creates the .portuni directory and sync.db file with all tables", async () => {
    await getLocalDb();
    const dirInfo = await fsStat(join(workspaceRoot, ".portuni"));
    assert.ok(dirInfo.isDirectory(), ".portuni dir exists");
    const fileInfo = await fsStat(join(workspaceRoot, ".portuni", "sync.db"));
    assert.ok(fileInfo.isFile(), "sync.db exists");

    const db = await getLocalDb();
    const tables = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = tables.rows.map((r) => r.name as string);
    assert.ok(names.includes("file_state"));
    assert.ok(names.includes("remote_stat_cache"));
    assert.ok(names.includes("local_mirrors"));
  });

  it("file_state CRUD roundtrip", async () => {
    await upsertFileState({
      file_id: "F1",
      last_synced_hash: "hash1",
      cached_local_hash: "hash1",
      cached_mtime: 12345,
      cached_size: 100,
    });
    const got = await getFileState("F1");
    assert.ok(got);
    assert.equal(got.file_id, "F1");
    assert.equal(got.last_synced_hash, "hash1");
    assert.equal(got.cached_local_hash, "hash1");
    assert.equal(got.cached_mtime, 12345);
    assert.equal(got.cached_size, 100);

    // upsert overwrite
    await upsertFileState({
      file_id: "F1",
      last_synced_hash: "hash2",
      cached_local_hash: null,
      cached_mtime: null,
      cached_size: null,
    });
    const got2 = await getFileState("F1");
    assert.ok(got2);
    assert.equal(got2.last_synced_hash, "hash2");
    assert.equal(got2.cached_local_hash, null);
    assert.equal(got2.cached_mtime, null);
    assert.equal(got2.cached_size, null);

    await deleteFileState("F1");
    assert.equal(await getFileState("F1"), null);
  });

  it("remote_stat_cache CRUD roundtrip", async () => {
    await upsertRemoteStat({
      file_id: "F1",
      remote_hash: "rh1",
      remote_modified_at: "2026-04-24T10:00:00.000Z",
    });
    const got = await getRemoteStat("F1");
    assert.ok(got);
    assert.equal(got.file_id, "F1");
    assert.equal(got.remote_hash, "rh1");
    assert.equal(got.remote_modified_at, "2026-04-24T10:00:00.000Z");
    assert.ok(got.fetched_at.length > 0);

    // overwrite
    await upsertRemoteStat({ file_id: "F1", remote_hash: null, remote_modified_at: null });
    const got2 = await getRemoteStat("F1");
    assert.ok(got2);
    assert.equal(got2.remote_hash, null);
    assert.equal(got2.remote_modified_at, null);
  });

  it("local_mirrors CRUD + list roundtrip", async () => {
    await upsertLocalMirror({ user_id: "U1", node_id: "N1", local_path: "/tmp/N1" });
    await upsertLocalMirror({ user_id: "U1", node_id: "N2", local_path: "/tmp/N2" });
    await upsertLocalMirror({ user_id: "U2", node_id: "N1", local_path: "/tmp/U2N1" });

    const got = await getLocalMirror("U1", "N1");
    assert.ok(got);
    assert.equal(got.local_path, "/tmp/N1");

    const listU1 = await listLocalMirrors("U1");
    assert.equal(listU1.length, 2);
    assert.deepEqual(
      new Set(listU1.map((r) => r.node_id)),
      new Set(["N1", "N2"]),
    );

    // upsert overwrite
    await upsertLocalMirror({ user_id: "U1", node_id: "N1", local_path: "/tmp/N1-new" });
    const got2 = await getLocalMirror("U1", "N1");
    assert.ok(got2);
    assert.equal(got2.local_path, "/tmp/N1-new");

    await deleteLocalMirror("U1", "N1");
    assert.equal(await getLocalMirror("U1", "N1"), null);
    const listAfter = await listLocalMirrors("U1");
    assert.equal(listAfter.length, 1);
    assert.equal(listAfter[0].node_id, "N2");
  });

  it("two different workspaces (different PORTUNI_WORKSPACE_ROOT) get distinct DBs", async () => {
    await upsertFileState({
      file_id: "F1",
      last_synced_hash: "h1",
      cached_local_hash: null,
      cached_mtime: null,
      cached_size: null,
    });
    assert.ok(await getFileState("F1"));

    // Switch to a second workspace
    resetLocalDbForTests();
    const ws2 = await makeWorkspace();
    process.env.PORTUNI_WORKSPACE_ROOT = ws2;
    try {
      const got = await getFileState("F1");
      assert.equal(got, null, "second workspace should not see the first workspace's data");

      await upsertFileState({
        file_id: "F2",
        last_synced_hash: "h2",
        cached_local_hash: null,
        cached_mtime: null,
        cached_size: null,
      });
      assert.ok(await getFileState("F2"));

      // Switch back to first workspace - F1 still there, F2 not.
      resetLocalDbForTests();
      process.env.PORTUNI_WORKSPACE_ROOT = workspaceRoot;
      assert.ok(await getFileState("F1"));
      assert.equal(await getFileState("F2"), null);
    } finally {
      resetLocalDbForTests();
      await rm(ws2, { recursive: true, force: true });
    }
  });

  it("resetLocalDbForTests forces a fresh open on next call", async () => {
    const a = await getLocalDb();
    resetLocalDbForTests();
    const b = await getLocalDb();
    assert.notEqual(a, b, "client instance should be replaced after reset");
  });

  it("throws if PORTUNI_WORKSPACE_ROOT is unset", async () => {
    delete process.env.PORTUNI_WORKSPACE_ROOT;
    resetLocalDbForTests();
    await assert.rejects(() => getLocalDb(), /PORTUNI_WORKSPACE_ROOT/);
  });
});
