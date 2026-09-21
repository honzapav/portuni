// Validates migration 039 (v2 task surface: sessions.context_used_tokens /
// context_max_tokens, the ring's counters). Two ADD COLUMNs, no rebuild.
// Pinned to libsql: this IS the libsql migration path; Postgres carries
// the columns in schema.pg.ts's baseline.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openTestDb } from "./helpers/db.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { runMigration039 } from "../apps/server/infra/schema-migrations.js";

async function sessionColumns(db: Awaited<ReturnType<typeof openTestDb>>): Promise<string[]> {
  const r = await db.execute("PRAGMA table_info(sessions)");
  return r.rows.map((row) => String(row.name));
}

describe("migration 039 sessions context counters", () => {
  it("fresh install has both columns", async () => {
    const db = await openTestDb("libsql");
    await ensureSchemaOn(db);
    const cols = await sessionColumns(db);
    assert.ok(cols.includes("context_used_tokens"));
    assert.ok(cols.includes("context_max_tokens"));
  });

  it("upgrades a pre-039 database by adding the columns, defaulting to NULL", async () => {
    const db = await openTestDb("libsql");
    await ensureSchemaOn(db);
    await db.execute("ALTER TABLE sessions DROP COLUMN context_used_tokens");
    await db.execute("ALTER TABLE sessions DROP COLUMN context_max_tokens");
    await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["039_sessions_context_counters"] });
    assert.ok(!(await sessionColumns(db)).includes("context_max_tokens"));

    await ensureSchemaOn(db);

    const cols = await sessionColumns(db);
    assert.ok(cols.includes("context_used_tokens"));
    assert.ok(cols.includes("context_max_tokens"));
  });

  it("refuses to add the columns twice", async () => {
    const db = await openTestDb("libsql");
    await ensureSchemaOn(db);
    await assert.rejects(runMigration039(db), /duplicate column/);
  });
});
