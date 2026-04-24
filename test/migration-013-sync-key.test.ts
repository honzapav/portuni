import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { runMigration013 } from "../src/schema.js";

const N1_ID = "01J7N100000000000000000001";
const N2_ID = "01J7N100000000000000000002";
const N3_ID = "01J7N100000000000000000003";

describe("migration 013", () => {
  async function freshPreDb() {
    const db = createClient({ url: ":memory:" });
    await db.execute(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )`);
    await db.execute(`CREATE TABLE nodes (
      id TEXT PRIMARY KEY CHECK(length(id) = 26),
      type TEXT NOT NULL CHECK(type IN ('organization','project','process','area','principle')),
      name TEXT NOT NULL,
      description TEXT,
      summary TEXT,
      summary_updated_at DATETIME,
      meta TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      visibility TEXT NOT NULL DEFAULT 'team',
      pos_x REAL,
      pos_y REAL,
      owner_id TEXT,
      lifecycle_state TEXT,
      goal TEXT,
      created_by TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
      CHECK(updated_at >= created_at)
    )`);
    await db.execute("INSERT INTO users (id,email,name) VALUES ('U1','a@b','A')");
    await db.execute({ sql: "INSERT INTO nodes (id,type,name,created_by) VALUES (?,?,?,?)", args: [N1_ID, "project", "Stan GWS", "U1"] });
    await db.execute({ sql: "INSERT INTO nodes (id,type,name,created_by) VALUES (?,?,?,?)", args: [N2_ID, "project", "Stan GWS", "U1"] });
    return db;
  }

  it("adds sync_key column without rebuilding the table", async () => {
    const db = await freshPreDb();
    await runMigration013(db);
    const info = await db.execute("PRAGMA table_info(nodes)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(cols.has("sync_key"));
    assert.ok(cols.has("lifecycle_state"));
    assert.ok(cols.has("owner_id"));
    assert.ok(cols.has("goal"));
  });

  it("creates the UNIQUE partial index", async () => {
    const db = await freshPreDb();
    await runMigration013(db);
    const r = await db.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_nodes_sync_key'");
    assert.equal(r.rows.length, 1);
  });

  it("backfills slug for single matching name", async () => {
    const db = await freshPreDb();
    await db.execute({ sql: "DELETE FROM nodes WHERE id = ?", args: [N2_ID] });
    await runMigration013(db);
    const r = await db.execute({ sql: "SELECT sync_key FROM nodes WHERE id = ?", args: [N1_ID] });
    assert.equal(r.rows[0].sync_key, "stan-gws");
  });

  it("backfills unique keys for duplicate names", async () => {
    const db = await freshPreDb();
    await runMigration013(db);
    const r = await db.execute("SELECT sync_key FROM nodes ORDER BY id");
    const keys = new Set(r.rows.map((row) => row.sync_key as string));
    assert.equal(keys.size, 2);
    assert.ok([...keys].every((k) => k.startsWith("stan-gws")));
  });

  it("UNIQUE index rejects duplicate sync_key inserts", async () => {
    const db = await freshPreDb();
    await runMigration013(db);
    await assert.rejects(() =>
      db.execute({
        sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
        args: [N3_ID, "project", "Other", "stan-gws", "U1"],
      }),
    );
  });

  it("is idempotent on clean re-run", async () => {
    const db = await freshPreDb();
    await runMigration013(db);
    await runMigration013(db);
    const r = await db.execute("SELECT COUNT(*) AS c FROM nodes WHERE sync_key IS NOT NULL");
    assert.equal(Number(r.rows[0].c), 2);
  });

  it("recovers from partial-failure: column added but no backfill", async () => {
    const db = await freshPreDb();
    await db.execute("ALTER TABLE nodes ADD COLUMN sync_key TEXT");
    await runMigration013(db);
    const r = await db.execute("SELECT COUNT(*) AS c FROM nodes WHERE sync_key IS NULL");
    assert.equal(Number(r.rows[0].c), 0);
    const idx = await db.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_nodes_sync_key'");
    assert.equal(idx.rows.length, 1);
    const trg = await db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name='nodes_sync_key_not_null_insert'");
    assert.equal(trg.rows.length, 1);
  });

  it("NOT-NULL trigger rejects INSERT with null sync_key after migration", async () => {
    const db = await freshPreDb();
    await runMigration013(db);
    await assert.rejects(() => db.execute({
      sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
      args: [N3_ID, "project", "X", null, "U1"],
    }), /sync_key/);
  });

  it("NOT-NULL trigger rejects UPDATE that sets sync_key to empty string", async () => {
    const db = await freshPreDb();
    await runMigration013(db);
    await assert.rejects(() => db.execute({
      sql: "UPDATE nodes SET sync_key = '' WHERE id = ?",
      args: [N1_ID],
    }), /sync_key/);
  });
});
