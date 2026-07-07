// test/migration-021-drop-files-description.test.ts
// Validates that migration 021 drops the unmaintained `files.description`
// column when present and is a no-op when it was never created (fresh installs
// via the post-021 DDL). Must be idempotent and preserve surviving columns.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { runMigration021 } from "../apps/server/infra/schema.js";

describe("migration 021 -- drop files.description", () => {
  it("drops files.description when present", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT, status TEXT, description TEXT)`,
    );
    await runMigration021(db);
    const info = await db.execute("PRAGMA table_info(files)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(!cols.has("description"), "description must be dropped");
    assert.ok(cols.has("id"));
    assert.ok(cols.has("filename"));
    assert.ok(cols.has("status"));
  });

  it("is a no-op when files.description is already gone", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT, status TEXT)`,
    );
    await runMigration021(db); // must not throw
    const info = await db.execute("PRAGMA table_info(files)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(!cols.has("description"));
    assert.ok(cols.has("filename"));
  });

  it("is idempotent across re-runs", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT, status TEXT, description TEXT)`,
    );
    await runMigration021(db);
    await runMigration021(db);
    await runMigration021(db);
    const info = await db.execute("PRAGMA table_info(files)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(!cols.has("description"));
  });

  it("preserves data in surviving columns", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT, status TEXT, description TEXT)`,
    );
    await db.execute({
      sql: "INSERT INTO files (id, filename, status, description) VALUES (?, ?, ?, ?)",
      args: ["F1", "doc.md", "wip", "some stale note"],
    });
    await runMigration021(db);
    const r = await db.execute({
      sql: "SELECT id, filename, status FROM files WHERE id = ?",
      args: ["F1"],
    });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].filename, "doc.md");
    assert.equal(r.rows[0].status, "wip");
  });
});
