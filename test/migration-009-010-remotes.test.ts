// test/migration-009-010-remotes.test.ts
// Tests for migrations 009 (remotes + remote_routing) and 010 (extend files
// table additively with remote_* columns and is_native_format).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { runMigration009, runMigration010 } from "../src/infra/schema.js";

async function freshPre009Db(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  // Minimal nodes/files tables -- migration 009 only depends on the absence
  // of remotes/remote_routing tables, but we add nodes/files for realism.
  await db.execute(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE files (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(id),
    filename TEXT NOT NULL,
    local_path TEXT,
    status TEXT NOT NULL DEFAULT 'wip',
    description TEXT,
    mime_type TEXT,
    created_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

describe("migration 009 -- remotes + remote_routing", () => {
  it("creates remotes and remote_routing tables", async () => {
    const db = await freshPre009Db();
    await runMigration009(db);
    const remotes = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='remotes'");
    assert.equal(remotes.rows.length, 1);
    const routing = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='remote_routing'");
    assert.equal(routing.rows.length, 1);
  });

  it("creates the priority index on remote_routing", async () => {
    const db = await freshPre009Db();
    await runMigration009(db);
    const idx = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_remote_routing_priority'",
    );
    assert.equal(idx.rows.length, 1);
  });

  it("is idempotent on re-run", async () => {
    const db = await freshPre009Db();
    await runMigration009(db);
    await runMigration009(db);
    const remotes = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='remotes'");
    assert.equal(remotes.rows.length, 1);
  });

  it("enforces remote type CHECK constraint", async () => {
    const db = await freshPre009Db();
    await runMigration009(db);
    await assert.rejects(() =>
      db.execute({
        sql: "INSERT INTO remotes (name, type, config_json, created_by) VALUES (?, ?, ?, ?)",
        args: ["bad", "wrongtype", "{}", "U1"],
      }),
    );
  });

  it("accepts known remote types", async () => {
    const db = await freshPre009Db();
    await runMigration009(db);
    for (const type of ["gdrive", "dropbox", "s3", "fs", "webdav", "sftp"]) {
      await db.execute({
        sql: "INSERT INTO remotes (name, type, config_json, created_by) VALUES (?, ?, ?, ?)",
        args: [`remote-${type}`, type, "{}", "U1"],
      });
    }
    const r = await db.execute("SELECT COUNT(*) AS c FROM remotes");
    assert.equal(Number(r.rows[0].c), 6);
  });

  it("remote_routing.remote_name FK rejects unknown remote", async () => {
    const db = await freshPre009Db();
    await runMigration009(db);
    await db.execute("PRAGMA foreign_keys = ON");
    await assert.rejects(() =>
      db.execute({
        sql: "INSERT INTO remote_routing (priority, remote_name) VALUES (?, ?)",
        args: [10, "nonexistent"],
      }),
    );
  });
});

describe("migration 010 -- extend files table", () => {
  async function freshPre010Db(): Promise<Client> {
    const db = await freshPre009Db();
    await runMigration009(db);
    return db;
  }

  it("adds 6 new columns to files", async () => {
    const db = await freshPre010Db();
    await runMigration010(db);
    const info = await db.execute("PRAGMA table_info(files)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    for (const expected of [
      "remote_name",
      "remote_path",
      "current_remote_hash",
      "last_pushed_by",
      "last_pushed_at",
      "is_native_format",
    ]) {
      assert.ok(cols.has(expected), `expected column ${expected} on files`);
    }
  });

  it("is_native_format defaults to 0", async () => {
    const db = await freshPre010Db();
    await runMigration010(db);
    // Insert a node + a file to verify default
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'project', 'P', 'U1')",
      args: ["01J7N100000000000000000001"],
    });
    await db.execute({
      sql: "INSERT INTO files (id, node_id, filename, created_by) VALUES (?, ?, ?, ?)",
      args: ["F1", "01J7N100000000000000000001", "x.md", "U1"],
    });
    const r = await db.execute("SELECT is_native_format FROM files WHERE id = 'F1'");
    assert.equal(Number(r.rows[0].is_native_format), 0);
  });

  it("is idempotent on re-run", async () => {
    const db = await freshPre010Db();
    await runMigration010(db);
    await runMigration010(db);
    const info = await db.execute("PRAGMA table_info(files)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(cols.has("remote_name"));
  });

  it("isApplied flips false -> true", async () => {
    const db = await freshPre010Db();
    // Before: missing the new columns
    const infoBefore = await db.execute("PRAGMA table_info(files)");
    const before = new Set(infoBefore.rows.map((r) => r.name as string));
    assert.ok(!before.has("remote_name"));
    await runMigration010(db);
    const infoAfter = await db.execute("PRAGMA table_info(files)");
    const after = new Set(infoAfter.rows.map((r) => r.name as string));
    assert.ok(after.has("remote_name"));
  });

  it("does NOT drop files.local_path (deferred to migration 012)", async () => {
    // Migration 010 is purely additive -- it must not touch the legacy
    // local_path column. Removal is the responsibility of migration 012.
    const db = await freshPre010Db();
    await runMigration010(db);
    const info = await db.execute("PRAGMA table_info(files)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(cols.has("local_path"), "local_path must still exist after 010");
  });
});

