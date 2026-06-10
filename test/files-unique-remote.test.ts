import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";

// Concurrent writers (desktop sidecar, tmux MCP server, agent sessions) all
// hit the same DB; SELECT-then-INSERT in storeFile/adoptFiles can interleave
// and register one remote file twice. Deleting either row later trashes the
// remote object and strands the other row. The unique index is the backstop;
// the writers upsert so a lost race degrades to an UPDATE, not an error.
describe("files (node_id, remote_name, remote_path) uniqueness", () => {
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

    const { runMigrations } = await import("../src/infra/schema-migrations.js");
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
});
