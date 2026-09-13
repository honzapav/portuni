// Driver conformance (batch B1, docs/superpowers/plans/2026-09-12-infra-batch.md):
// the same three behaviours -- positional args, batch atomicity (a failing
// statement rolls back the whole batch), and executeMultiple -- against
// every DbClient implementation. libsql and PGlite are both in-process/
// in-memory and always run; `pg` needs a live Postgres the sandbox/CI does
// not provide (the infra batch plan's own "CI adds no services" constraint),
// so its conformance run is opt-in via PORTUNI_TEST_PG_URL and skipped
// otherwise -- the driver itself still typechecks and shares the same
// normalizeStmt/placeholder-rewrite helpers db-pglite.ts's run here proves
// correct.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createLibsqlDbClient } from "../apps/server/infra/db-libsql.js";
import { createPgliteDbClient } from "../apps/server/infra/db-pglite.js";
import { createPgDbClient } from "../apps/server/infra/db-pg.js";
import type { DbClient } from "../apps/server/infra/db.js";

function conformanceSuite(name: string, makeDb: () => DbClient | Promise<DbClient>, skip: string | false = false) {
  describe(`DbClient conformance: ${name}`, { skip }, () => {
    it("executes with positional args and reads rows back as plain objects", async () => {
      const db = await makeDb();
      await db.execute("CREATE TABLE conformance_books (id INTEGER PRIMARY KEY, title TEXT, year INTEGER)");
      await db.execute({
        sql: "INSERT INTO conformance_books (id, title, year) VALUES (?, ?, ?)",
        args: [1, "Pride and Prejudice", 1813],
      });
      const res = await db.execute({ sql: "SELECT id, title, year FROM conformance_books WHERE id = ?", args: [1] });
      assert.equal(res.rows.length, 1);
      assert.deepEqual({ ...res.rows[0] }, { id: 1, title: "Pride and Prejudice", year: 1813 });
      assert.equal(res.rowsAffected, 0); // a SELECT reports no rows affected
    });

    it("rolls back the whole batch when one statement fails", async () => {
      const db = await makeDb();
      await db.execute("CREATE TABLE conformance_unique (id INTEGER PRIMARY KEY)");
      await assert.rejects(
        db.batch(
          [
            { sql: "INSERT INTO conformance_unique (id) VALUES (?)", args: [1] },
            { sql: "INSERT INTO conformance_unique (id) VALUES (?)", args: [1] }, // duplicate PK -> fails
          ],
          "write",
        ),
      );
      const res = await db.execute("SELECT id FROM conformance_unique");
      assert.equal(res.rows.length, 0, "the first insert must have been rolled back too");
    });

    it("commits every statement in a batch that fully succeeds", async () => {
      const db = await makeDb();
      await db.execute("CREATE TABLE conformance_batch_ok (id INTEGER PRIMARY KEY)");
      await db.batch(
        [
          { sql: "INSERT INTO conformance_batch_ok (id) VALUES (?)", args: [1] },
          { sql: "INSERT INTO conformance_batch_ok (id) VALUES (?)", args: [2] },
        ],
        "write",
      );
      const res = await db.execute("SELECT id FROM conformance_batch_ok ORDER BY id");
      assert.deepEqual(
        res.rows.map((r) => r.id),
        [1, 2],
      );
    });

    it("executeMultiple runs a sequence of statements separated by semicolons", async () => {
      const db = await makeDb();
      await db.executeMultiple(`
        CREATE TABLE conformance_multi_a (id INTEGER);
        CREATE TABLE conformance_multi_b (id INTEGER);
        INSERT INTO conformance_multi_a (id) VALUES (1);
      `);
      const res = await db.execute("SELECT id FROM conformance_multi_a");
      assert.deepEqual(
        res.rows.map((r) => r.id),
        [1],
      );
    });
  });
}

conformanceSuite("libsql (in-memory)", () => createLibsqlDbClient(createClient({ url: ":memory:" })));
conformanceSuite("pglite (in-memory)", () => createPgliteDbClient());

const pgUrl = process.env.PORTUNI_TEST_PG_URL?.trim();
conformanceSuite("pg (live Postgres)", () => createPgDbClient(pgUrl as string), pgUrl ? false : "requires PORTUNI_TEST_PG_URL");
