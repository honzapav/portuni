// Validates migration 038 (#418: files.remote_file_id, the backend's own
// stable object id, so a rename/move/hard delete reported by a change feed
// finds the record whose path no longer matches).
//
// Pinned to libsql: this IS the libsql migration path (PRAGMA table_info,
// ALTER TABLE ... DROP COLUMN). Postgres carries the same column in
// schema.pg.ts's baseline, which has no per-column migration to replay.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openTestDb } from "./helpers/db.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";

async function fileColumns(db: Awaited<ReturnType<typeof openTestDb>>): Promise<string[]> {
  const r = await db.execute("PRAGMA table_info(files)");
  return r.rows.map((row) => String(row.name));
}

describe("migration 038 files.remote_file_id", () => {
  it("upgrades a pre-038 database by adding the column, defaulting to NULL", async () => {
    const db = await openTestDb("libsql");
    await ensureSchemaOn(db);
    await db.execute("DROP INDEX IF EXISTS idx_files_remote_file_id");
    await db.execute("ALTER TABLE files DROP COLUMN remote_file_id");
    await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["038_files_remote_file_id"] });
    assert.ok(!(await fileColumns(db)).includes("remote_file_id"));

    await ensureSchemaOn(db);

    assert.ok((await fileColumns(db)).includes("remote_file_id"));
    // The index on the added column lives in DDL_AFTER_MIGRATIONS, never in
    // the DDL replay that runs BEFORE the migration pass
    // (docs/lessons-learned.md section 7).
    const idx = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_remote_file_id'",
    );
    assert.equal(idx.rows.length, 1);
  });

  it("a fresh install already has the column and the index", async () => {
    const db = await openTestDb("libsql");
    await ensureSchemaOn(db);
    assert.ok((await fileColumns(db)).includes("remote_file_id"));
    const idx = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_remote_file_id'",
    );
    assert.equal(idx.rows.length, 1);
  });
});
