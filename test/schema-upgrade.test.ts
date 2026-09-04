import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { DDL, DDL_MIGRATION_006 } from "../apps/server/infra/schema-triggers.js";

// ensureSchemaOn replays the DDL set before it runs the migrations, so every
// DDL statement has to be valid against a database that is still at an older
// schema version. A CREATE INDEX over a column that only a migration adds is
// not: CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so the
// column is absent and the index fails with "no such column" before the
// migration that would have added it ever runs. That shipped once
// (0.13.2, audit_node_id) and locked every existing install out of its own
// database.

async function indexExists(db: Client, name: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='index' AND name = ?",
    args: [name],
  });
  return r.rows.length > 0;
}

async function columnExists(db: Client, table: string, column: string): Promise<boolean> {
  // table_xinfo, not table_info: the latter omits generated columns.
  const r = await db.execute(`PRAGMA table_xinfo(${table})`);
  return r.rows.some((row) => row.name === column);
}

// Put a fully migrated database back into the shape 0.13.1 left it in:
// audit_log without the generated column or its index, and without the
// markers that would let the version fast path skip the replay.
async function rollBackTo032(db: Client): Promise<void> {
  // Rebuilt rather than ALTER ... DROP COLUMN: SQLite re-parses the stored
  // CREATE TABLE text after a drop, and audit_log's carries line comments it
  // chokes on ("incomplete input").
  await db.execute("DROP INDEX IF EXISTS idx_audit_file_node_ts");
  await db.execute("ALTER TABLE audit_log RENAME TO audit_log_pre_033");
  await db.execute(`CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    detail TEXT,
    timestamp DATETIME NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
    SELECT id, user_id, action, target_type, target_id, detail, timestamp FROM audit_log_pre_033`);
  await db.execute("DROP TABLE audit_log_pre_033");
  await db.execute("DELETE FROM migrations WHERE id = '033_audit_node_id_index'");
  await db.execute("DELETE FROM migrations WHERE id LIKE 'ddl:%'");
}

describe("ensureSchemaOn against an older database", () => {
  it("upgrades an audit_log that predates the audit_node_id column", async () => {
    const db = createClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    await rollBackTo032(db);
    assert.equal(await columnExists(db, "audit_log", "audit_node_id"), false);

    // Used to throw LibsqlError: SQLITE_ERROR: no such column: audit_node_id.
    await ensureSchemaOn(db);

    assert.equal(await columnExists(db, "audit_log", "audit_node_id"), true);
    assert.equal(await indexExists(db, "idx_audit_file_node_ts"), true);
    db.close();
  });

  it("creates idx_audit_file_node_ts on a fresh install too", async () => {
    const db = createClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    assert.equal(await indexExists(db, "idx_audit_file_node_ts"), true);
    db.close();
  });

  it("keeps every DDL statement applicable to a database at the previous version", async () => {
    // The general form of the same bug: DDL must never reference schema that
    // only a migration introduces. Replaying it against a rolled-back
    // database is what catches the next one.
    const db = createClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    await rollBackTo032(db);
    for (const sql of [...DDL, ...DDL_MIGRATION_006]) {
      await db.execute(sql);
    }
    db.close();
  });
});
