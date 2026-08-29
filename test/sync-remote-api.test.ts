import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import {
  getNodeSyncInfo,
  registerFileRecordRemote,
  registerFileRecordsRemote,
} from "../apps/server/domain/sync/sync-remote-api.js";
import {
  readFileBytesRemote,
  writeFileBytesRemote,
} from "../apps/server/domain/sync/file-content-remote.js";
import { FileContentError } from "../apps/server/domain/sync/file-content.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-syncremote-"));
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

describe("registerFileRecordRemote", () => {
  it("creates a files row with NULL current_remote_hash (pending upload)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const r = await registerFileRecordRemote(db, {
      userId: "U1",
      nodeId,
      relPath: "wip/notes.md",
    });
    assert.equal(r.filename, "notes.md");
    assert.equal(r.remote_name, "test-fs");
    assert.ok(r.remote_path.endsWith("/wip/notes.md"));

    const row = await db.execute({
      sql: "SELECT current_remote_hash, last_pushed_at, status FROM files WHERE id = ?",
      args: [r.id],
    });
    assert.equal(row.rows[0].current_remote_hash, null);
    assert.equal(row.rows[0].last_pushed_at, null);
    assert.equal(row.rows[0].status, "wip");
  });

  it("is idempotent: re-register keeps the id and the synced state", async () => {
    const { db, nodeId } = await makeSharedDb();
    const first = await registerFileRecordRemote(db, { userId: "U1", nodeId, relPath: "wip/a.md" });
    // Simulate a later push having set the canonical hash.
    await db.execute({
      sql: "UPDATE files SET current_remote_hash = 'abc' WHERE id = ?",
      args: [first.id],
    });
    const second = await registerFileRecordRemote(db, { userId: "U1", nodeId, relPath: "wip/a.md" });
    assert.equal(second.id, first.id);
    const row = await db.execute({
      sql: "SELECT current_remote_hash FROM files WHERE id = ?",
      args: [first.id],
    });
    // Synced baseline preserved -- registration never demotes a synced file.
    assert.equal(row.rows[0].current_remote_hash, "abc");
  });

  it("rejects path traversal", async () => {
    const { db, nodeId } = await makeSharedDb();
    await assert.rejects(
      () => registerFileRecordRemote(db, { userId: "U1", nodeId, relPath: "wip/../../etc/passwd" }),
      (e: unknown) => e instanceof FileContentError && e.code === "INVALID_PATH",
    );
  });

  it("throws for an unknown node", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(() =>
      registerFileRecordRemote(db, { userId: "U1", nodeId: "NOPE", relPath: "wip/a.md" }),
    );
  });
});

describe("getNodeSyncInfo", () => {
  it("returns node identity, routed remote, and file records", async () => {
    const { db, nodeId, nodeSyncKey, orgSyncKey } = await makeSharedDb();
    const reg = await registerFileRecordRemote(db, { userId: "U1", nodeId, relPath: "outputs/r.pdf" });

    const info = await getNodeSyncInfo(db, nodeId);
    assert.equal(info.node.id, nodeId);
    assert.equal(info.node.type, "project");
    assert.equal(info.node.sync_key, nodeSyncKey);
    assert.equal(info.node.org_sync_key, orgSyncKey);
    assert.equal(info.remote_name, "test-fs");
    assert.equal(info.files.length, 1);
    assert.equal(info.files[0].id, reg.id);
    assert.equal(info.files[0].filename, "r.pdf");
    assert.equal(info.files[0].status, "output");
    assert.equal(info.files[0].current_remote_hash, null);
    assert.equal(info.files[0].is_native_format, false);
  });

  it("throws for an unknown node (handler maps to 404)", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(() => getNodeSyncInfo(db, "NOPE"));
  });

  it("exposes delete tombstones for the node, excluding repair_needed rows", async () => {
    const { db, nodeId } = await makeSharedDb();
    const now = new Date().toISOString();
    const mk = (action: string, fileId: string, tombNodeId: string) =>
      db.execute({
        sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
              VALUES (?, 'U1', ?, 'file', ?, ?, ?)`,
        args: [
          ulid(),
          action,
          fileId,
          JSON.stringify({ node_id: tombNodeId, remote_path: `p/${fileId}.md` }),
          now,
        ],
      });
    await mk("sync_delete", "F1", nodeId);
    await mk("sync_delete_remote", "F2", nodeId);
    await mk("sync_delete_repair_needed", "F3", nodeId);
    await mk("sync_delete_remote_repair_needed", "F4", nodeId);
    await mk("sync_delete", "F5", "N-OTHER");

    const info = await getNodeSyncInfo(db, nodeId);
    assert.deepEqual(info.deleted.map((d) => d.file_id).sort(), ["F1", "F2"]);
    assert.equal(info.deleted.find((d) => d.file_id === "F1")?.remote_path, "p/F1.md");
  });

  // renameFolder writes one sync_rename row per affected file, and a sweep
  // of a folder deleted on the remote writes one sync_delete_remote row per
  // file. A row-count window (LIMIT 200) lets either push older DELETE
  // tombstones out of the answer -- and a delete tombstone the agent never
  // sees is a local copy that gets adopted and pushed back, i.e. the exact
  // resurrection tombstones exist to prevent.
  it("still exposes an older delete tombstone behind 300 newer rename rows", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mk = (action: string, fileId: string, path: string, timestamp: string) =>
      db.execute({
        sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
              VALUES (?, 'U1', ?, 'file', ?, ?, ?)`,
        args: [
          ulid(),
          action,
          fileId,
          JSON.stringify({ node_id: nodeId, remote_path: path, old_remote_path: path }),
          timestamp,
        ],
      });
    const t0 = Date.now() - 3 * 86_400_000;
    await mk("sync_delete", "OLD", "p/old.md", new Date(t0).toISOString());
    for (let i = 0; i < 300; i++) {
      await mk("sync_rename", `R${i}`, `p/r${i}.md`, new Date(t0 + 60_000 + i).toISOString());
    }

    const info = await getNodeSyncInfo(db, nodeId);
    assert.ok(
      info.deleted.some((d) => d.file_id === "OLD"),
      "the delete tombstone must survive a folder-sized batch of newer rename rows",
    );
  });

  // Delete A at path P, push a new file B to P, then move B away: the newest
  // tombstone for P is B's move, but a device still holding A's old copy can
  // only match A's delete tombstone (the hash guard is per file). Collapsing
  // to one tombstone per path would drop A's and let that copy get adopted
  // and pushed back -- so the dedupe key is (path, file), not path.
  it("keeps a delete tombstone alongside a newer move tombstone for the same path", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mk = (action: string, fileId: string, detail: Record<string, unknown>, timestamp: string) =>
      db.execute({
        sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
              VALUES (?, 'U1', ?, 'file', ?, ?, ?)`,
        args: [ulid(), action, fileId, JSON.stringify({ node_id: nodeId, ...detail }), timestamp],
      });
    const t0 = Date.now() - 3600_000;
    await mk("sync_delete", "A", { remote_path: "p/x.md" }, new Date(t0).toISOString());
    await mk("sync_move", "B", { old_remote_path: "p/x.md" }, new Date(t0 + 60_000).toISOString());

    const info = await getNodeSyncInfo(db, nodeId);
    const forPath = info.deleted.filter((d) => d.remote_path === "p/x.md");
    assert.deepEqual(
      forPath.map((d) => [d.file_id, d.record_alive]).sort(),
      [["A", false], ["B", true]],
    );
  });

  it("returns an empty tombstone list when nothing was deleted", async () => {
    const { db, nodeId } = await makeSharedDb();
    const info = await getNodeSyncInfo(db, nodeId);
    assert.deepEqual(info.deleted, []);
  });
});

describe("byte-plane read/write (binary-safe sync transfer)", () => {
  it("round-trips binary bytes with NUL through the routed remote", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerFileRecordRemote(db, { userId: "U1", nodeId, relPath: "wip/p.png" });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]);

    const w = await writeFileBytesRemote(db, {
      userId: "U1",
      nodeId,
      relPath: "wip/p.png",
      bytes,
    });
    assert.equal(w.version.length, 64);
    assert.ok(w.canonical_hash.length > 0);

    const r = await readFileBytesRemote(db, { nodeId, relPath: "wip/p.png" });
    assert.deepEqual(r.bytes, bytes);
    assert.equal(r.version, w.version);
    assert.equal(r.canonical_hash, w.canonical_hash);
  });

  it("refreshes the file record canonical hash after a write", async () => {
    const { db, nodeId } = await makeSharedDb();
    const reg = await registerFileRecordRemote(db, { userId: "U1", nodeId, relPath: "wip/b.bin" });
    const w = await writeFileBytesRemote(db, {
      userId: "U1",
      nodeId,
      relPath: "wip/b.bin",
      bytes: Buffer.from("data"),
    });
    const row = await db.execute({
      sql: "SELECT current_remote_hash, last_pushed_by FROM files WHERE id = ?",
      args: [reg.id],
    });
    assert.equal(row.rows[0].current_remote_hash, w.canonical_hash);
    assert.equal(row.rows[0].last_pushed_by, "U1");
  });

  it("raises CONFLICT with currentVersion on a stale baseVersion", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerFileRecordRemote(db, { userId: "U1", nodeId, relPath: "wip/c.txt" });
    const w1 = await writeFileBytesRemote(db, {
      userId: "U1",
      nodeId,
      relPath: "wip/c.txt",
      bytes: Buffer.from("v1"),
    });
    // Second writer with a stale base.
    await assert.rejects(
      () =>
        writeFileBytesRemote(db, {
          userId: "U1",
          nodeId,
          relPath: "wip/c.txt",
          bytes: Buffer.from("v3"),
          baseVersion: "0".repeat(64),
        }),
      (e: unknown) =>
        e instanceof FileContentError &&
        e.code === "CONFLICT" &&
        e.currentVersion === w1.version,
    );
  });

  it("read of a missing remote object is NOT_FOUND", async () => {
    const { db, nodeId } = await makeSharedDb();
    await assert.rejects(
      () => readFileBytesRemote(db, { nodeId, relPath: "wip/missing.bin" }),
      (e: unknown) => e instanceof FileContentError && e.code === "NOT_FOUND",
    );
  });

  it("read of a tracked-but-vanished remote object is NOT_FOUND (fast path)", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    await registerFileRecordRemote(db, { userId: "U1", nodeId, relPath: "wip/gone.txt" });
    await writeFileBytesRemote(db, { userId: "U1", nodeId, relPath: "wip/gone.txt", bytes: Buffer.from("x") });
    // Record now carries a hash (fast path active); wipe the remote object
    // directly on the fs remote's root.
    const info = await getNodeSyncInfo(db, nodeId);
    const rp = info.files[0].remote_path as string;
    await rm(join(remoteRoot, rp), { force: true });
    await assert.rejects(
      () => readFileBytesRemote(db, { nodeId, relPath: "wip/gone.txt" }),
      (e: unknown) => e instanceof FileContentError && e.code === "NOT_FOUND",
    );
  });

  it("baseCanonicalHash precondition: match writes, mismatch raises CONFLICT without download", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerFileRecordRemote(db, { userId: "U1", nodeId, relPath: "wip/pc.txt" });
    const w1 = await writeFileBytesRemote(db, {
      userId: "U1", nodeId, relPath: "wip/pc.txt", bytes: Buffer.from("v1"),
    });
    // Matching canonical hash -> write proceeds.
    const w2 = await writeFileBytesRemote(db, {
      userId: "U1", nodeId, relPath: "wip/pc.txt", bytes: Buffer.from("v2"),
      baseCanonicalHash: w1.canonical_hash,
    });
    // Stale canonical hash -> CONFLICT carrying the current canonical hash.
    await assert.rejects(
      () => writeFileBytesRemote(db, {
        userId: "U1", nodeId, relPath: "wip/pc.txt", bytes: Buffer.from("v3"),
        baseCanonicalHash: w1.canonical_hash,
      }),
      (e: unknown) =>
        e instanceof FileContentError && e.code === "CONFLICT" && e.currentVersion === w2.canonical_hash,
    );
  });

  it("ifAbsent: creates when missing, EXISTS when the object is already there", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerFileRecordRemote(db, { userId: "U1", nodeId, relPath: "wip/new.txt" });
    await writeFileBytesRemote(db, {
      userId: "U1", nodeId, relPath: "wip/new.txt", bytes: Buffer.from("first"), ifAbsent: true,
    });
    await assert.rejects(
      () => writeFileBytesRemote(db, {
        userId: "U1", nodeId, relPath: "wip/new.txt", bytes: Buffer.from("second"), ifAbsent: true,
      }),
      (e: unknown) => e instanceof FileContentError && e.code === "EXISTS",
    );
  });
});

describe("registerFileRecordsRemote (batch)", () => {
  it("registers many files in one batch with NULL hashes", async () => {
    const { db, nodeId } = await makeSharedDb();
    const results = await registerFileRecordsRemote(db, {
      userId: "U1",
      nodeId,
      relPaths: ["wip/a.md", "wip/sub/b.md", "outputs/c.pdf"],
    });
    assert.equal(results.length, 3);
    assert.equal(results[2].filename, "c.pdf");
    const rows = await db.execute({
      sql: "SELECT current_remote_hash, status FROM files WHERE node_id = ? ORDER BY filename",
      args: [nodeId],
    });
    assert.equal(rows.rows.length, 3);
    for (const r of rows.rows) assert.equal(r.current_remote_hash, null);
    assert.equal(rows.rows[2].status, "output");
  });

  it("is idempotent against existing records (keeps ids and synced state)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const single = await registerFileRecordRemote(db, { userId: "U1", nodeId, relPath: "wip/a.md" });
    await db.execute({ sql: "UPDATE files SET current_remote_hash = 'kept' WHERE id = ?", args: [single.id] });
    const batch = await registerFileRecordsRemote(db, {
      userId: "U1", nodeId, relPaths: ["wip/a.md", "wip/b.md"],
    });
    assert.equal(batch[0].id, single.id);
    const row = await db.execute({ sql: "SELECT current_remote_hash FROM files WHERE id = ?", args: [single.id] });
    assert.equal(row.rows[0].current_remote_hash, "kept");
  });
});
