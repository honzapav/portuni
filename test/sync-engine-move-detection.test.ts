// On-disk mv detection -- WITH AN ACTIVE WATCHER. The old moveDetectionPhase
// paired deleted_local x new_local in statusScan, but with the watcher
// running the new path is registered the moment it appears, so the phase
// never fired in the configuration that actually ships (it was dead code
// within 3.5 hours of being written). These tests drive the real watcher
// dispatch (injected watchFactory, zero debounce) through the real
// reconcilePath, which now pairs an mv by inode identity at registration
// time and applies the real moveFile (adapter rename, record update).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  rename as fsRename,
  copyFile,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@libsql/client";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, statusScan } from "../apps/server/domain/sync/engine.js";
import { registerLocalFile } from "../apps/server/domain/sync/engine.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import {
  createMirrorWatcher,
  type MirrorWatcher,
  type WatchFactory,
} from "../apps/server/domain/sync/mirror-watcher.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-movedet-"));
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

// Manual-fire watch harness: the test triggers the same onPath callbacks the
// OS watcher would, so event content and ORDER are deterministic.
function manualWatch(): { factory: WatchFactory; fire: (absPath: string) => void } {
  const sinks: Array<(p: string) => void> = [];
  return {
    factory: (_root, onPath) => {
      sinks.push(onPath);
      return { close: () => undefined };
    },
    fire: (absPath) => {
      for (const s of sinks) s(absPath);
    },
  };
}

async function settle(): Promise<void> {
  // debounceMs is 0; two macrotask hops let the queued reconciles finish.
  await new Promise((r) => setTimeout(r, 150));
}

async function startWatcher(db: Client, factory: WatchFactory): Promise<MirrorWatcher> {
  const w = createMirrorWatcher({
    db,
    userId: "U1",
    watchFactory: factory,
    backfill: false,
    debounceMs: 0,
  });
  await w.start();
  return w;
}

async function fileRows(db: Client, nodeId: string) {
  const r = await db.execute({
    sql: "SELECT id, filename, remote_path FROM files WHERE node_id = ? ORDER BY filename",
    args: [nodeId],
  });
  return r.rows as unknown as Array<{ id: string; filename: string; remote_path: string }>;
}

describe("watcher-observed mv (inode pairing)", () => {
  it("mv of a pushed file keeps ONE row and physically moves the remote object", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const oldAbs = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldAbs, "unique-content-xyz");
    const stored = await storeFile(db, { userId: "U1", nodeId, localPath: oldAbs });

    const w = manualWatch();
    const watcher = await startWatcher(db, w.factory);

    await mkdir(join(mirrorRoot, "outputs"), { recursive: true });
    const newAbs = join(mirrorRoot, "outputs", "moved.md");
    await fsRename(oldAbs, newAbs);
    w.fire(oldAbs);
    w.fire(newAbs);
    await settle();
    watcher.stop();

    const rows = await fileRows(db, nodeId);
    assert.equal(rows.length, 1, `expected one row, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0].id, stored.file_id);
    assert.equal(rows[0].filename, "moved.md");
    assert.match(rows[0].remote_path, /outputs\/moved\.md$/);
    // Remote object physically moved on the fs remote.
    await assert.rejects(() => stat(join(remoteRoot, stored.remote_path)));
    await stat(join(remoteRoot, rows[0].remote_path));
    // Scan agrees: nothing new, nothing deleted, file clean.
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    assert.equal(scan.new_local.length, 0);
    assert.equal(scan.deleted_local.length, 0);
  });

  it("pairs the mv regardless of event order (new path first)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const oldAbs = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldAbs, "order-test");
    const stored = await storeFile(db, { userId: "U1", nodeId, localPath: oldAbs });

    const w = manualWatch();
    const watcher = await startWatcher(db, w.factory);
    const newAbs = join(mirrorRoot, "wip", "b.md");
    await fsRename(oldAbs, newAbs);
    w.fire(newAbs);
    w.fire(oldAbs);
    await settle();
    watcher.stop();

    const rows = await fileRows(db, nodeId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, stored.file_id);
    assert.equal(rows[0].filename, "b.md");
  });

  it("a copy (identical content, old path still present) registers a NEW file", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const oldAbs = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldAbs, "copy-me");
    await storeFile(db, { userId: "U1", nodeId, localPath: oldAbs });

    const w = manualWatch();
    const watcher = await startWatcher(db, w.factory);
    const copyAbs = join(mirrorRoot, "wip", "kopie.md");
    await copyFile(oldAbs, copyAbs);
    w.fire(copyAbs);
    await settle();
    watcher.stop();

    const rows = await fileRows(db, nodeId);
    assert.equal(rows.length, 2);
  });

  it("content changed after the mv falls back to register (hash guard)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const oldAbs = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldAbs, "puvodni");
    const stored = await storeFile(db, { userId: "U1", nodeId, localPath: oldAbs });

    const w = manualWatch();
    const watcher = await startWatcher(db, w.factory);
    const newAbs = join(mirrorRoot, "wip", "b.md");
    await fsRename(oldAbs, newAbs);
    await writeFile(newAbs, "prepsano po presunu");
    w.fire(oldAbs);
    w.fire(newAbs);
    await settle();
    watcher.stop();

    const rows = await fileRows(db, nodeId);
    // Old record survives (deleted_local decision for the user), new path
    // registered as its own file -- data is never silently merged.
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.id === stored.file_id));
  });

  it("mv of a never-pushed file, old-path event first: old record unregisters, new path registers (one row)", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const oldAbs = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldAbs, "lokalni");
    // Register only (no push): the watcher's normal registration path.
    await registerLocalFile(db, { userId: "U1", nodeId, localPath: oldAbs });

    const w = manualWatch();
    const watcher = await startWatcher(db, w.factory);
    const newAbs = join(mirrorRoot, "wip", "b.md");
    await fsRename(oldAbs, newAbs);
    w.fire(oldAbs);
    w.fire(newAbs);
    await settle();
    watcher.stop();

    // A never-pushed record carries no remote identity worth preserving, so
    // the delete-side unregister + create-side fresh register is the
    // documented outcome: exactly one row, at the new path, nothing uploaded.
    const rows = await fileRows(db, nodeId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].filename, "b.md");
    await assert.rejects(() => stat(join(remoteRoot, rows[0].remote_path)));
  });

  it("mv of a never-pushed file, new-path event first: record is retargeted in place", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const oldAbs = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldAbs, "lokalni");
    const reg = await registerLocalFile(db, { userId: "U1", nodeId, localPath: oldAbs });

    const w = manualWatch();
    const watcher = await startWatcher(db, w.factory);
    const newAbs = join(mirrorRoot, "wip", "b.md");
    await fsRename(oldAbs, newAbs);
    w.fire(newAbs);
    w.fire(oldAbs);
    await settle();
    watcher.stop();

    const rows = await fileRows(db, nodeId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, reg.file_id);
    assert.equal(rows[0].filename, "b.md");
    await assert.rejects(() => stat(join(remoteRoot, rows[0].remote_path)));
  });
});
