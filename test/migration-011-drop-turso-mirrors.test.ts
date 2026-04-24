import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { runMigration011 } from "../src/schema.js";

describe("migration 011", () => {
  it("drops existing Turso local_mirrors table", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(`CREATE TABLE local_mirrors (
      user_id TEXT NOT NULL, node_id TEXT NOT NULL, local_path TEXT,
      registered_at DATETIME DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, node_id)
    )`);
    await runMigration011(db);
    const r = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='local_mirrors'",
    );
    assert.equal(r.rows.length, 0);
  });

  it("is a no-op on a DB without the table", async () => {
    const db = createClient({ url: ":memory:" });
    await runMigration011(db);
    const r = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='local_mirrors'",
    );
    assert.equal(r.rows.length, 0);
  });

  it("isApplied reflects the state", async () => {
    const db = createClient({ url: ":memory:" });
    await db.execute(
      `CREATE TABLE local_mirrors (user_id TEXT, node_id TEXT, local_path TEXT, PRIMARY KEY (user_id, node_id))`,
    );
    const r1 = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='local_mirrors'",
    );
    assert.equal(r1.rows.length, 1);
    await runMigration011(db);
    const r2 = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='local_mirrors'",
    );
    assert.equal(r2.rows.length, 0);
  });
});
