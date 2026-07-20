// Sync-layer regression suite WITH AN ACTIVE WATCHER -- the configuration
// that actually ships. The desktop sidecar always runs the mirror watcher,
// so every disk change goes through reconcilePath before any scan or tool
// call sees it; tests that exercise the sync layer without a watcher run a
// configuration that exists only in tests (that gap hid the dead
// moveDetectionPhase for three weeks). Move pairing itself is covered by
// sync-engine-move-detection.test.ts; this file covers the remaining
// lifecycle -- create (incl. bursts), modify, delete -- and asserts against
// fast-mode statusScan (fast: true, includeDiscovery: false), the exact
// query the UI's status indicator reads.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@libsql/client";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, statusScan } from "../apps/server/domain/sync/engine.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { resetLocalDbForTests, getFileState } from "../apps/server/domain/sync/local-db.js";
import {
  createMirrorWatcher,
  type MirrorWatcher,
  type WatchFactory,
} from "../apps/server/domain/sync/mirror-watcher.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-watchreg-"));
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
  // debounceMs is 0; the wait lets the serialized reconcileChain drain.
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

// The UI's status indicator: pure DB-cache classification, no disk walk, no
// remote listing. Truthful ONLY when the watcher keeps the cache current.
async function fastScan(db: Client, nodeId: string) {
  return statusScan(db, { userId: "U1", nodeId, includeDiscovery: false, fast: true });
}

describe("sync lifecycle with an active watcher (fast-mode scan truth)", () => {
  it("a burst of files written back-to-back all register (no silent loss)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });

    const w = manualWatch();
    const watcher = await startWatcher(db, w.factory);

    // The GH #80 shape: an agent session writing several outputs within the
    // same second. Every event must survive the dispatch -> reconcile chain.
    const paths = ["t1.md", "t2.md", "t3.md"].map((f) => join(mirrorRoot, "wip", f));
    for (const [i, p] of paths.entries()) await writeFile(p, `obsah ${i}`);
    for (const p of paths) w.fire(p);
    await settle();
    watcher.stop();

    const rows = await db.execute({
      sql: "SELECT filename FROM files WHERE node_id = ? ORDER BY filename",
      args: [nodeId],
    });
    assert.deepEqual(
      rows.rows.map((r) => r.filename),
      ["t1.md", "t2.md", "t3.md"],
    );
    // Fast-mode scan sees all three as pending upload -- not invisible, not
    // new_local (registration already happened).
    const scan = await fastScan(db, nodeId);
    assert.equal(scan.push_candidates.length, 3);
    assert.equal(scan.new_local.length, 0);
  });

  it("a disk edit of a pushed file surfaces as push without any manual store/status call", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const abs = join(mirrorRoot, "wip", "doc.md");
    await writeFile(abs, "v1");
    const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: abs });

    // Clean baseline before the edit.
    const before = await fastScan(db, nodeId);
    assert.ok(before.clean.some((f) => f.file_id === file_id));

    const w = manualWatch();
    const watcher = await startWatcher(db, w.factory);
    await writeFile(abs, "v2 -- editor save");
    w.fire(abs);
    await settle();
    watcher.stop();

    const scan = await fastScan(db, nodeId);
    assert.ok(
      scan.push_candidates.some((f) => f.file_id === file_id),
      `expected push, got ${JSON.stringify({ clean: scan.clean, push: scan.push_candidates })}`,
    );
  });

  it("deleting a pushed file on disk reads as deleted_local, remote copy untouched", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const abs = join(mirrorRoot, "wip", "doc.md");
    await writeFile(abs, "v1");
    const { file_id, remote_path } = await storeFile(db, {
      userId: "U1",
      nodeId,
      localPath: abs,
    });

    const w = manualWatch();
    const watcher = await startWatcher(db, w.factory);
    await rm(abs);
    w.fire(abs);
    await settle();
    watcher.stop();

    const scan = await fastScan(db, nodeId);
    assert.ok(scan.deleted_local.some((f) => f.file_id === file_id));
    // Record and remote object survive; only the cached local hash is gone.
    const state = await getFileState(file_id);
    assert.equal(state?.cached_local_hash, null);
    assert.ok(state?.last_synced_hash);
    const { stat } = await import("node:fs/promises");
    await stat(join(remoteRoot, remote_path));
  });

  it("deleting a never-pushed file unregisters it entirely (no orphan row)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const abs = join(mirrorRoot, "wip", "scratch.md");

    const w = manualWatch();
    const watcher = await startWatcher(db, w.factory);
    await writeFile(abs, "docasny");
    w.fire(abs);
    await settle();
    // Registered by the watcher, never pushed -- now delete it again.
    await rm(abs);
    w.fire(abs);
    await settle();
    watcher.stop();

    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS c FROM files WHERE node_id = ?",
      args: [nodeId],
    });
    assert.equal(Number(rows.rows[0].c), 0);
    const scan = await fastScan(db, nodeId);
    assert.equal(scan.push_candidates.length, 0);
    assert.equal(scan.deleted_local.length, 0);
    assert.equal(scan.orphan.length, 0);
  });

  it("two devices with a live watcher on the writer: B's pull baseline still detects A's edit", async () => {
    // The watcher-active variant of sync-two-device-regression: device A's
    // edit lands via the watcher (rehash), not via an explicit store call,
    // and the shared DB must still let device B see that the remote moved on
    // after A pushes.
    const { db, nodeId } = await makeSharedDb();
    const workspaceB = await mkdtemp(join(tmpdir(), "portuni-watchreg-devB-"));
    try {
      const mirrorRoot = join(workspace, "mirror");
      await registerMirror("U1", nodeId, mirrorRoot);
      await mkdir(join(mirrorRoot, "wip"), { recursive: true });
      const abs = join(mirrorRoot, "wip", "doc.md");
      await writeFile(abs, "v1");
      const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: abs });

      // A edits; the watcher rehashes; A pushes the pending change.
      const w = manualWatch();
      const watcher = await startWatcher(db, w.factory);
      await writeFile(abs, "v2");
      w.fire(abs);
      await settle();
      watcher.stop();
      const scanA = await fastScan(db, nodeId);
      assert.ok(scanA.push_candidates.some((f) => f.file_id === file_id));
      await storeFile(db, { userId: "U1", nodeId, localPath: abs });

      // Device B (fresh sync.db): pulls and compares baselines.
      process.env.PORTUNI_WORKSPACE_ROOT = workspaceB;
      resetLocalDbForTests();
      resetAdapterCacheForTests();
      await registerMirror("U1", nodeId, join(workspaceB, "mirror"));
      const { pullFile } = await import("../apps/server/domain/sync/engine.js");
      const pulled = await pullFile(db, { userId: "U1", fileId: file_id });
      const { readFile } = await import("node:fs/promises");
      assert.equal(await readFile(pulled.local_path, "utf-8"), "v2");
    } finally {
      await rm(workspaceB, { recursive: true, force: true });
    }
  });
});
