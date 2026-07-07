// test/migration-022-drop-nodes-summary.test.ts
// Validates that migration 022 drops the never-wired `nodes.summary` and
// `nodes.summary_updated_at` columns when present, is a no-op on fresh
// installs (post-022 DDL), stays idempotent, and preserves other columns.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { runMigration022 } from "../apps/server/infra/schema.js";

describe("migration 022 -- drop nodes.summary(_updated_at)", () => {
  it("drops both summary columns when present", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, description TEXT, summary TEXT, summary_updated_at DATETIME, meta TEXT)`,
    );
    await runMigration022(db);
    const info = await db.execute("PRAGMA table_info(nodes)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(!cols.has("summary"), "summary must be dropped");
    assert.ok(!cols.has("summary_updated_at"), "summary_updated_at must be dropped");
    assert.ok(cols.has("id"));
    assert.ok(cols.has("description"));
    assert.ok(cols.has("meta"));
  });

  it("is a no-op when the columns are already gone", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(`CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, meta TEXT)`);
    await runMigration022(db); // must not throw
    const info = await db.execute("PRAGMA table_info(nodes)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(!cols.has("summary"));
    assert.ok(cols.has("name"));
  });

  it("is idempotent across re-runs", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE nodes (id TEXT PRIMARY KEY, summary TEXT, summary_updated_at DATETIME)`,
    );
    await runMigration022(db);
    await runMigration022(db);
    await runMigration022(db);
    const info = await db.execute("PRAGMA table_info(nodes)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(!cols.has("summary"));
    assert.ok(!cols.has("summary_updated_at"));
  });

  it("preserves data in surviving columns", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, summary TEXT, summary_updated_at DATETIME)`,
    );
    await db.execute({
      sql: "INSERT INTO nodes (id, name, summary) VALUES (?, ?, ?)",
      args: ["N1", "Node One", "stale summary"],
    });
    await runMigration022(db);
    const r = await db.execute({ sql: "SELECT id, name FROM nodes WHERE id = ?", args: ["N1"] });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].name, "Node One");
  });
});
