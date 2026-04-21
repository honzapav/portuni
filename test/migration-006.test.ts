import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { runMigration006 } from "../src/schema.js";

async function freshPre006Db() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE nodes (id TEXT PRIMARY KEY CHECK(length(id)=26), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, summary TEXT, summary_updated_at DATETIME, meta TEXT, status TEXT NOT NULL DEFAULT 'active', visibility TEXT NOT NULL DEFAULT 'team', pos_x REAL, pos_y REAL, created_by TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT (datetime('now')), updated_at DATETIME NOT NULL DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES nodes(id), target_id TEXT NOT NULL REFERENCES nodes(id), relation TEXT NOT NULL, meta TEXT, created_by TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT (datetime('now')))`);
  await db.execute(`INSERT INTO users (id, email, name) VALUES ('U1','t@t','T')`);
  const orgId = ulid();
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'organization', 'Workflow', 'U1')`, args: [orgId] });
  return { db, orgId };
}

describe("migration 006 creates tables", () => {
  it("creates actors, responsibilities, responsibility_assignments, data_sources, tools", async () => {
    const { db } = await freshPre006Db();
    await runMigration006(db);
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = tables.rows.map((r) => r.name as string);
    for (const expected of ["actors", "responsibilities", "responsibility_assignments", "data_sources", "tools"]) {
      assert.ok(names.includes(expected), `expected table ${expected} to exist`);
    }
  });

  it("adds owner_id, lifecycle_state, goal columns to nodes", async () => {
    const { db } = await freshPre006Db();
    await runMigration006(db);
    const info = await db.execute("PRAGMA table_info(nodes)");
    const cols = info.rows.map((r) => r.name as string);
    assert.ok(cols.includes("owner_id"));
    assert.ok(cols.includes("lifecycle_state"));
    assert.ok(cols.includes("goal"));
  });

  it("seeds lifecycle_state from existing status values", async () => {
    const { db, orgId } = await freshPre006Db();
    await runMigration006(db);
    const r = await db.execute({ sql: "SELECT lifecycle_state FROM nodes WHERE id = ?", args: [orgId] });
    // Organization with status='active' should seed lifecycle_state='active'
    assert.equal(r.rows[0].lifecycle_state, "active");
  });
});
