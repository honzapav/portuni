// test/migration-009-010-remotes.test.ts
// Tests for migrations 009 (remotes + remote_routing) and 010 (extend files
// table additively with remote_* columns and is_native_format).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { runMigration009 } from "../src/schema.js";

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

