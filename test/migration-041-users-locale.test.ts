// Validates migration 041 (#538: users.locale, the user's UI language).
// One ADD COLUMN with a CHECK, no rebuild, no index. Pinned to libsql: this
// IS the libsql migration path; Postgres carries the column in
// schema.pg.ts's baseline.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openTestDb } from "./helpers/db.js";
import { ensureSchemaOn, SOLO_USER } from "../apps/server/infra/schema.js";
import { runMigration041 } from "../apps/server/infra/schema-migrations.js";

async function userColumns(db: Awaited<ReturnType<typeof openTestDb>>): Promise<string[]> {
  const r = await db.execute("PRAGMA table_info(users)");
  return r.rows.map((row) => String(row.name));
}

describe("migration 041 users.locale", () => {
  it("fresh install has the column, NULL for the solo user", async () => {
    const db = await openTestDb("libsql");
    await ensureSchemaOn(db);
    assert.ok((await userColumns(db)).includes("locale"));
    const r = await db.execute({ sql: "SELECT locale FROM users WHERE id = ?", args: [SOLO_USER] });
    assert.equal(r.rows[0].locale, null);
  });

  it("upgrades a pre-041 database, keeping its users", async () => {
    const db = await openTestDb("libsql");
    await ensureSchemaOn(db);
    await db.execute("ALTER TABLE users DROP COLUMN locale");
    await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["041_users_locale"] });
    assert.ok(!(await userColumns(db)).includes("locale"));

    await ensureSchemaOn(db);

    assert.ok((await userColumns(db)).includes("locale"));
    const r = await db.execute({ sql: "SELECT locale FROM users WHERE id = ?", args: [SOLO_USER] });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].locale, null);
  });

  it("accepts en, cs and NULL and refuses anything else", async () => {
    const db = await openTestDb("libsql");
    await ensureSchemaOn(db);
    for (const value of ["en", "cs", null]) {
      await db.execute({ sql: "UPDATE users SET locale = ? WHERE id = ?", args: [value, SOLO_USER] });
    }
    await assert.rejects(
      db.execute({ sql: "UPDATE users SET locale = ? WHERE id = ?", args: ["de", SOLO_USER] }),
      /CHECK/i,
    );
  });

  it("refuses to add the column twice", async () => {
    const db = await openTestDb("libsql");
    await ensureSchemaOn(db);
    await assert.rejects(runMigration041(db), /duplicate column/);
  });
});
