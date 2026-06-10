import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, pullFile, statusScan } from "../src/domain/sync/engine.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import {
  getFileState,
  upsertFileState,
  resetLocalDbForTests,
} from "../src/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";

let workspaceA: string;
let workspaceB: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspaceA = await mkdtemp(join(tmpdir(), "portuni-pullsafe-A-"));
  workspaceB = await mkdtemp(join(tmpdir(), "portuni-pullsafe-B-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspaceA, { recursive: true, force: true });
  await rm(workspaceB, { recursive: true, force: true });
});

async function switchTo(workspace: string): Promise<void> {
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
}

describe("pullFile dirty-local protection", () => {
  it("refuses to overwrite local edits when this device never synced the file", async () => {
    const { db, nodeId } = await makeSharedDb();

    await switchTo(workspaceA);
    await registerMirror("U1", nodeId, join(workspaceA, "mirror"));
    const src = join(workspaceA, "doc.md");
    await writeFile(src, "remote-v1");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });

    // Device B: mirror folder restored from backup with local edits, but a
    // fresh sync.db (no file_state row). Pull must not clobber the edits.
    await switchTo(workspaceB);
    await registerMirror("U1", nodeId, join(workspaceB, "mirror"));
    const localB = join(workspaceB, "mirror", "wip", "doc.md");
    await mkdir(join(workspaceB, "mirror", "wip"), { recursive: true });
    await writeFile(localB, "local-edit-never-pushed");

    await assert.rejects(
      () => pullFile(db, { userId: "U1", fileId: file_id }),
      /force/i,
    );
    assert.equal(await readFile(localB, "utf-8"), "local-edit-never-pushed");
  });

  it("force: true overwrites local edits", async () => {
    const { db, nodeId } = await makeSharedDb();

    await switchTo(workspaceA);
    await registerMirror("U1", nodeId, join(workspaceA, "mirror"));
    const src = join(workspaceA, "doc.md");
    await writeFile(src, "remote-v1");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });

    await switchTo(workspaceB);
    await registerMirror("U1", nodeId, join(workspaceB, "mirror"));
    const localB = join(workspaceB, "mirror", "wip", "doc.md");
    await mkdir(join(workspaceB, "mirror", "wip"), { recursive: true });
    await writeFile(localB, "local-edit");

    const r = await pullFile(db, { userId: "U1", fileId: file_id, force: true });
    assert.equal(await readFile(r.local_path, "utf-8"), "remote-v1");
  });

  it("refuses when local diverged from the known baseline", async () => {
    const { db, nodeId } = await makeSharedDb();

    await switchTo(workspaceA);
    await registerMirror("U1", nodeId, join(workspaceA, "mirror"));
    const src = join(workspaceA, "doc.md");
    await writeFile(src, "v1");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });

    // B pulls v1 (baseline known), then edits locally without pushing,
    // then A pushes v2. Pull on B must refuse.
    await switchTo(workspaceB);
    await registerMirror("U1", nodeId, join(workspaceB, "mirror"));
    const pulled = await pullFile(db, { userId: "U1", fileId: file_id });
    await writeFile(pulled.local_path, "b-local-edit");

    await switchTo(workspaceA);
    const localA = join(workspaceA, "mirror", "wip", "doc.md");
    await writeFile(localA, "v2");
    await storeFile(db, { userId: "U1", nodeId, localPath: localA });

    await switchTo(workspaceB);
    // Restore B's sync.db perspective: same workspace, state row persisted.
    await assert.rejects(
      () => pullFile(db, { userId: "U1", fileId: file_id }),
      /force/i,
    );
    assert.equal(await readFile(pulled.local_path, "utf-8"), "b-local-edit");
  });

  it("pulls normally when local matches the known baseline", async () => {
    const { db, nodeId } = await makeSharedDb();

    await switchTo(workspaceA);
    await registerMirror("U1", nodeId, join(workspaceA, "mirror"));
    const src = join(workspaceA, "doc.md");
    await writeFile(src, "v1");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });

    await switchTo(workspaceB);
    await registerMirror("U1", nodeId, join(workspaceB, "mirror"));
    const pulled = await pullFile(db, { userId: "U1", fileId: file_id });

    await switchTo(workspaceA);
    const localA = join(workspaceA, "mirror", "wip", "doc.md");
    await writeFile(localA, "v2");
    await storeFile(db, { userId: "U1", nodeId, localPath: localA });

    await switchTo(workspaceB);
    const r = await pullFile(db, { userId: "U1", fileId: file_id });
    assert.equal(await readFile(r.local_path, "utf-8"), "v2");
    assert.equal(pulled.local_path, r.local_path);
  });

  it("pulls when local content is already identical to remote (baseline repair)", async () => {
    const { db, nodeId } = await makeSharedDb();

    await switchTo(workspaceA);
    await registerMirror("U1", nodeId, join(workspaceA, "mirror"));
    const src = join(workspaceA, "doc.md");
    await writeFile(src, "same-content");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });

    // B has the identical file but no file_state (e.g. copied manually).
    await switchTo(workspaceB);
    await registerMirror("U1", nodeId, join(workspaceB, "mirror"));
    const localB = join(workspaceB, "mirror", "wip", "doc.md");
    await mkdir(join(workspaceB, "mirror", "wip"), { recursive: true });
    await writeFile(localB, "same-content");

    const r = await pullFile(db, { userId: "U1", fileId: file_id });
    assert.equal(await readFile(r.local_path, "utf-8"), "same-content");
    const state = await getFileState(file_id);
    assert.ok(state?.last_synced_hash, "pull should establish the baseline");
  });

  it("still restores a locally deleted file without force", async () => {
    const { db, nodeId } = await makeSharedDb();

    await switchTo(workspaceA);
    await registerMirror("U1", nodeId, join(workspaceA, "mirror"));
    const src = join(workspaceA, "doc.md");
    await writeFile(src, "v1");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const localA = join(workspaceA, "mirror", "wip", "doc.md");
    await rm(localA);

    const r = await pullFile(db, { userId: "U1", fileId: file_id });
    assert.equal(await readFile(r.local_path, "utf-8"), "v1");
  });
});

describe("statusScan does not fabricate a sync baseline", () => {
  it("classifies never-synced local file with unverifiable remote as conflict, not clean/pull", async () => {
    const { db, nodeId } = await makeSharedDb();

    await switchTo(workspaceA);
    await registerMirror("U1", nodeId, join(workspaceA, "mirror"));
    const src = join(workspaceA, "doc.md");
    await writeFile(src, "remote-v1");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });

    // Device B: local edit exists, sync.db has no file_state row. The fs
    // adapter exposes no remote hash, so the scan cannot verify equality --
    // the only safe classification is conflict.
    await switchTo(workspaceB);
    await registerMirror("U1", nodeId, join(workspaceB, "mirror"));
    const localB = join(workspaceB, "mirror", "wip", "doc.md");
    await mkdir(join(workspaceB, "mirror", "wip"), { recursive: true });
    await writeFile(localB, "local-edit-never-pushed");

    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: false });
    assert.ok(
      scan.conflicts.some((f) => f.file_id === file_id),
      `expected conflict; got clean=${scan.clean.length} push=${scan.push_candidates.length} pull=${scan.pull_candidates.length}`,
    );
    // And the scan must not have written a fabricated baseline.
    const state = await getFileState(file_id);
    assert.equal(state?.last_synced_hash ?? null, null);
  });
});

describe("sync.db file_state schema migration", () => {
  it("rebuilds a legacy NOT NULL file_state table so null baselines can be stored", async () => {
    await switchTo(workspaceB);
    // Simulate a sync.db created by an older build (NOT NULL columns).
    const dir = join(workspaceB, ".portuni");
    await mkdir(dir, { recursive: true });
    const legacy = createClient({ url: `file:${join(dir, "sync.db")}` });
    await legacy.execute(`CREATE TABLE file_state (
      file_id TEXT PRIMARY KEY,
      last_synced_hash TEXT NOT NULL,
      last_synced_at DATETIME NOT NULL,
      cached_local_hash TEXT,
      cached_mtime INTEGER,
      cached_size INTEGER
    )`);
    await legacy.execute({
      sql: "INSERT INTO file_state VALUES (?,?,?,?,?,?)",
      args: ["F1", "abc", "2026-01-01T00:00:00Z", "abc", 1, 2],
    });
    legacy.close();

    // New code must migrate the table and accept a cache-only row.
    await upsertFileState({
      file_id: "F2",
      last_synced_hash: null,
      last_synced_at: null,
      cached_local_hash: "deadbeef",
      cached_mtime: 3,
      cached_size: 4,
    });
    const f2 = await getFileState("F2");
    assert.equal(f2?.last_synced_hash ?? null, null);
    assert.equal(f2?.cached_local_hash, "deadbeef");
    // Legacy row survives the rebuild.
    const f1 = await getFileState("F1");
    assert.equal(f1?.last_synced_hash, "abc");
  });
});
