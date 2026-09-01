// registerLocalFile: register a brand-new local file WITHOUT uploading it.
// This is the "auto git add, don't push" capability the deterministic
// file-state watcher needs -- a file created through Portuni is tracked
// immediately and shows as pending-upload, but the bytes only reach the
// remote on a deliberate sync.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { registerLocalFile, statusScan, storeFile } from "../apps/server/domain/sync/engine.js";
import { replaceRules, addRule } from "../apps/server/domain/sync/routing.js";
import {
  getFileState,
  resetLocalDbForTests,
} from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-reg-"));
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

describe("registerLocalFile", () => {
  it("registers a local file without uploading it to the remote", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const fp = join(mirrorRoot, "wip", "note.md");
    await writeFile(fp, "hello");

    const res = await registerLocalFile(db, {
      userId: "U1",
      nodeId,
      localPath: fp,
    });

    // files row exists, routed, but never pushed.
    const rows = await db.execute({
      sql: "SELECT filename, remote_name, current_remote_hash, last_pushed_at FROM files WHERE id = ?",
      args: [res.file_id],
    });
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].filename, "note.md");
    assert.equal(rows.rows[0].remote_name, "test-fs");
    assert.equal(rows.rows[0].current_remote_hash, null);
    assert.equal(rows.rows[0].last_pushed_at, null);

    // file_state: local hash cached, no synced baseline.
    const st = await getFileState(res.file_id);
    assert.ok(st);
    assert.equal(st.last_synced_hash, null);
    assert.ok(st.cached_local_hash);

    // Nothing reached the remote.
    const remoteEntries = await readdir(remoteRoot, { recursive: true }).catch(
      () => [] as string[],
    );
    assert.equal(
      (remoteEntries as string[]).some((f) => String(f).endsWith("note.md")),
      false,
    );
  });

  it("classifies a register-only file as push (pending upload), not remote_missing", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const fp = join(mirrorRoot, "wip", "note.md");
    await writeFile(fp, "hello");
    await registerLocalFile(db, { userId: "U1", nodeId, localPath: fp });

    const scan = await statusScan(db, {
      userId: "U1",
      nodeId,
      fast: true,
      includeDiscovery: false,
    });
    assert.deepEqual(
      scan.push_candidates.map((f) => f.filename),
      ["note.md"],
    );
    assert.equal(scan.remote_missing.length, 0);
  });

  // #201: a local-only workspace (no remote configured at all) must still
  // track its files -- registerLocalFile used to throw "No remote routing
  // configured" before writing anything.
  describe("without any remote routing configured (#201)", () => {
    it("registers successfully with remote_name NULL and yields a tracked push file", async () => {
      const { db, nodeId } = await makeSharedDb();
      await replaceRules(db, []); // strip the routing makeSharedDb set up
      const mirrorRoot = join(workspace, "mirror");
      await registerMirror("U1", nodeId, mirrorRoot);
      await mkdir(join(mirrorRoot, "wip"), { recursive: true });
      const fp = join(mirrorRoot, "wip", "note.md");
      await writeFile(fp, "hello");

      const res = await registerLocalFile(db, { userId: "U1", nodeId, localPath: fp });
      assert.equal(res.remote_name, null);
      assert.ok(res.remote_path, "remote_path is still computed -- it never depends on the remote");

      const rows = await db.execute({
        sql: "SELECT remote_name, remote_path FROM files WHERE id = ?",
        args: [res.file_id],
      });
      assert.equal(rows.rows[0].remote_name, null);
      assert.equal(rows.rows[0].remote_path, res.remote_path);

      const scan = await statusScan(db, { userId: "U1", nodeId, fast: true, includeDiscovery: false });
      assert.deepEqual(scan.push_candidates.map((f) => f.filename), ["note.md"]);
      assert.equal(scan.remote_missing.length, 0);
      assert.equal(scan.conflicts.length, 0);
    });

    it("classifies as clean (not remote_error) once the unrouted file's local content is gone", async () => {
      const { db, nodeId } = await makeSharedDb();
      await replaceRules(db, []);
      const mirrorRoot = join(workspace, "mirror");
      await registerMirror("U1", nodeId, mirrorRoot);
      await mkdir(join(mirrorRoot, "wip"), { recursive: true });
      const fp = join(mirrorRoot, "wip", "note.md");
      await writeFile(fp, "hello");
      await registerLocalFile(db, { userId: "U1", nodeId, localPath: fp });

      const { rm: rmFile } = await import("node:fs/promises");
      await rmFile(fp);

      const scan = await statusScan(db, { userId: "U1", nodeId, fast: false, includeDiscovery: false });
      assert.deepEqual(scan.clean.map((f) => f.filename), ["note.md"]);
      assert.equal(scan.push_candidates.length, 0);
      assert.equal(scan.remote_missing.length, 0);
      assert.equal(scan.remote_error.length, 0, "no remote configured is not a data-integrity error");
      assert.equal(
        scan.conflicts.length + scan.pull_candidates.length,
        0,
        "no remote to compare against -- must not surface as an error/conflict bucket",
      );
    });

    it("re-registering the same file does not create a duplicate row", async () => {
      const { db, nodeId } = await makeSharedDb();
      await replaceRules(db, []);
      const mirrorRoot = join(workspace, "mirror");
      await registerMirror("U1", nodeId, mirrorRoot);
      await mkdir(join(mirrorRoot, "wip"), { recursive: true });
      const fp = join(mirrorRoot, "wip", "note.md");
      await writeFile(fp, "hello");

      const first = await registerLocalFile(db, { userId: "U1", nodeId, localPath: fp });
      const second = await registerLocalFile(db, { userId: "U1", nodeId, localPath: fp });
      assert.equal(first.file_id, second.file_id);

      const rows = await db.execute({
        sql: "SELECT COUNT(*) AS c FROM files WHERE node_id = ? AND filename = 'note.md'",
        args: [nodeId],
      });
      assert.equal(rows.rows[0].c, 1);
    });

    it("connecting a remote later and calling storeFile backfills remote_name onto the existing row and uploads", async () => {
      const { db, nodeId, remoteRoot } = await makeSharedDb();
      await replaceRules(db, []);
      const mirrorRoot = join(workspace, "mirror");
      await registerMirror("U1", nodeId, mirrorRoot);
      await mkdir(join(mirrorRoot, "wip"), { recursive: true });
      const fp = join(mirrorRoot, "wip", "note.md");
      await writeFile(fp, "hello");

      const registered = await registerLocalFile(db, { userId: "U1", nodeId, localPath: fp });
      assert.equal(registered.remote_name, null);

      // Deliberate sync attempted before a remote exists: the ROUTING_GUIDANCE
      // error, not a silent no-op.
      await assert.rejects(
        () => storeFile(db, { userId: "U1", nodeId, localPath: fp }),
        /No remote routing configured/,
      );

      // Now connect a remote.
      await addRule(db, { priority: 10, node_type: null, org_slug: null, remote_name: "test-fs" });

      const stored = await storeFile(db, { userId: "U1", nodeId, localPath: fp });
      assert.equal(stored.file_id, registered.file_id, "backfills the existing row, does not duplicate it");
      assert.equal(stored.remote_name, "test-fs");

      const rows = await db.execute({
        sql: "SELECT remote_name, current_remote_hash, last_pushed_at FROM files WHERE id = ?",
        args: [stored.file_id],
      });
      assert.equal(rows.rows[0].remote_name, "test-fs");
      assert.ok(rows.rows[0].current_remote_hash);
      assert.ok(rows.rows[0].last_pushed_at);

      const remoteEntries = await readdir(remoteRoot, { recursive: true }).catch(() => [] as string[]);
      assert.ok((remoteEntries as string[]).some((f) => String(f).endsWith("note.md")));

      const countRows = await db.execute({
        sql: "SELECT COUNT(*) AS c FROM files WHERE node_id = ? AND filename = 'note.md'",
        args: [nodeId],
      });
      assert.equal(countRows.rows[0].c, 1, "still one row, not a duplicate");
    });
  });
});
