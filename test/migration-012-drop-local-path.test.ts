// test/migration-012-drop-local-path.test.ts
// Validates that migration 012 drops the legacy `files.local_path` column
// when present and is a no-op when the column was never created (fresh
// installs via the post-012 DDL). The migration must be idempotent: re-runs
// after success must not throw.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { runMigration012 } from "../src/schema.js";

describe("migration 012 -- drop files.local_path", () => {
  it("drops files.local_path when present", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT, local_path TEXT)`,
    );
    await runMigration012(db);
    const info = await db.execute("PRAGMA table_info(files)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(!cols.has("local_path"), "local_path must be dropped");
    // Other columns must survive.
    assert.ok(cols.has("id"));
    assert.ok(cols.has("filename"));
  });

  it("is a no-op when files.local_path is already gone", async () => {
    const db = createClient({ url: ":memory:" });
    // Fresh install shape: no local_path column at all.
    await db.execute(
      `CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT)`,
    );
    await runMigration012(db); // must not throw
    const info = await db.execute("PRAGMA table_info(files)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(!cols.has("local_path"));
    assert.ok(cols.has("filename"));
  });

  it("is idempotent across re-runs", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT, local_path TEXT)`,
    );
    await runMigration012(db);
    await runMigration012(db); // re-run
    await runMigration012(db); // and again
    const info = await db.execute("PRAGMA table_info(files)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(!cols.has("local_path"));
  });

  it("preserves data in surviving columns", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE files (id TEXT PRIMARY KEY, filename TEXT, local_path TEXT)`,
    );
    await db.execute({
      sql: "INSERT INTO files (id, filename, local_path) VALUES (?, ?, ?)",
      args: ["F1", "doc.md", "/tmp/doc.md"],
    });
    await runMigration012(db);
    const r = await db.execute({
      sql: "SELECT id, filename FROM files WHERE id = ?",
      args: ["F1"],
    });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].filename, "doc.md");
  });
});
