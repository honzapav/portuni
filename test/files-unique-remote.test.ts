import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";

// Concurrent writers (desktop sidecar, tmux MCP server, agent sessions) all
// hit the same DB; SELECT-then-INSERT in storeFile/adoptFiles can interleave
// and register one remote file twice. Deleting either row later trashes the
// remote object and strands the other row. The unique index is the backstop;
// the writers upsert so a lost race degrades to an UPDATE, not an error.
//
// Migration 031 (#201) dropped remote_name from the key: it is now
// (node_id, remote_path) alone. remote_path is derived purely from the
// node's own identity, never from which remote is routed, so it already
// identifies "the same file" on its own -- and a row registered before any
// remote existed (remote_name NULL) must collide with the same file
// registered again after routing resolves, so the upsert backfills
// remote_name instead of creating a second row (standard SQL NULL
// semantics mean two NULLs never collide on their own).
describe("files (node_id, remote_path) uniqueness", () => {
  it("rejects a second row for the same remote file", async () => {
    const { db, nodeId } = await makeSharedDb();
    const insert = (id: string) =>
      db.execute({
        sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, created_by)
              VALUES (?, ?, 'doc.md', 'test-fs', 'workflow/projects/stan-gws/wip/doc.md', 'U1')`,
        args: [id, nodeId],
      });
    await insert(ulid());
    await assert.rejects(() => insert(ulid()), /UNIQUE/i);
  });

  it("rejects a second row for the same path even when remote_name differs (one NULL)", async () => {
    const { db, nodeId } = await makeSharedDb();
    await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, created_by)
            VALUES (?, ?, 'doc.md', NULL, 'workflow/projects/stan-gws/wip/doc.md', 'U1')`,
      args: [ulid(), nodeId],
    });
    await assert.rejects(
      () =>
        db.execute({
          sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, created_by)
                VALUES (?, ?, 'doc.md', 'test-fs', 'workflow/projects/stan-gws/wip/doc.md', 'U1')`,
          args: [ulid(), nodeId],
        }),
      /UNIQUE/i,
    );
  });

  it("allows multiple untracked rows (remote_path NULL) per node", async () => {
    const { db, nodeId } = await makeSharedDb();
    const insert = (id: string) =>
      db.execute({
        sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, created_by)
              VALUES (?, ?, 'draft.md', NULL, NULL, 'U1')`,
        args: [id, nodeId],
      });
    await insert(ulid());
    await insert(ulid());
    const r = await db.execute({
      sql: "SELECT COUNT(*) AS c FROM files WHERE node_id = ? AND remote_path IS NULL",
      args: [nodeId],
    });
    assert.equal(Number(r.rows[0].c), 2);
  });

  it("migration dedupes pre-existing duplicates keeping the newest row", async () => {
    const { db, nodeId } = await makeSharedDb();
    // Simulate an old DB: drop the index, plant duplicates, clear the
    // migration marker, and let runMigrations repair it.
    await db.execute("DROP INDEX IF EXISTS idx_files_unique_remote");
    const mkRow = (id: string, updatedAt: string) =>
      db.execute({
        sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, created_by, updated_at)
              VALUES (?, ?, 'dup.md', 'test-fs', 'workflow/projects/stan-gws/wip/dup.md', 'U1', ?)`,
        args: [id, nodeId, updatedAt],
      });
    await mkRow("01OLD0000000000000000000DU", "2026-01-01T00:00:00Z");
    await mkRow("01NEW0000000000000000000DU", "2026-06-01T00:00:00Z");
    await db.execute({
      sql: "DELETE FROM migrations WHERE id = ?",
      args: ["015_files_unique_remote"],
    });

    const { runMigrations } = await import("../apps/server/infra/schema-migrations.js");
    await runMigrations(db);

    const rows = await db.execute({
      sql: "SELECT id FROM files WHERE node_id = ? AND filename = 'dup.md'",
      args: [nodeId],
    });
    assert.equal(rows.rows.length, 1, "duplicates must be collapsed to one row");
    assert.equal(rows.rows[0].id, "01NEW0000000000000000000DU", "newest row wins");
    const idx = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_files_unique_remote'",
    );
    assert.equal(idx.rows.length, 1, "unique index must be recreated");
  });

  it("migration 031 dedupes a NULL-remote row against a resolved-remote row for the same path, keeping the resolved one", async () => {
    const { db, nodeId } = await makeSharedDb();
    // Simulate a pre-031 DB: rebuild the index in its OLD (node_id,
    // remote_name, remote_path) shape, plant a NULL-remote row (registered
    // before any remote existed -- possible pre-fix, if a race ever slipped
    // past the old index) alongside a since-resolved row for the exact same
    // path, then let runMigrations repair it.
    await db.execute("DROP INDEX IF EXISTS idx_files_unique_remote");
    await db.execute(
      `CREATE UNIQUE INDEX idx_files_unique_remote
         ON files(node_id, remote_name, remote_path) WHERE remote_path IS NOT NULL`,
    );
    const path = "workflow/projects/stan-gws/wip/dup.md";
    await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, created_by, updated_at)
            VALUES (?, ?, 'dup.md', NULL, ?, 'U1', '2026-06-01T00:00:00Z')`,
      args: ["01NULLREMOTE0000000000DUP", nodeId, path],
    });
    await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, created_by, updated_at)
            VALUES (?, ?, 'dup.md', 'test-fs', ?, 'U1', '2026-01-01T00:00:00Z')`,
      args: ["01RESOLVED0000000000DUP", nodeId, path],
    });
    await db.execute({
      sql: "DELETE FROM migrations WHERE id = ?",
      args: ["031_files_unique_remote_drop_remote_name"],
    });

    const { runMigrations } = await import("../apps/server/infra/schema-migrations.js");
    await runMigrations(db);

    const rows = await db.execute({
      sql: "SELECT id, remote_name FROM files WHERE node_id = ? AND filename = 'dup.md'",
      args: [nodeId],
    });
    assert.equal(rows.rows.length, 1, "duplicates must be collapsed to one row");
    assert.equal(rows.rows[0].id, "01RESOLVED0000000000DUP", "the resolved-remote row wins even though it is older");
    assert.equal(rows.rows[0].remote_name, "test-fs");

    const idx = await db.execute(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_files_unique_remote'",
    );
    assert.doesNotMatch(String(idx.rows[0].sql), /remote_name/);
  });
});
