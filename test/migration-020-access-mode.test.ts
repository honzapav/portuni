import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { createClient } from "@libsql/client";
import { DDL } from "../apps/server/infra/schema-triggers.js";
import { runMigrations } from "../apps/server/infra/schema-migrations.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("migration 020 nodes.access_mode", () => {
  it("creates access_mode with default 'private' on fresh install (DDL)", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    const info = await db.execute("PRAGMA table_info(nodes)");
    const col = info.rows.find((r) => r.name === "access_mode");
    assert.ok(col, "access_mode column must exist");
    assert.equal(col!.notnull, 1);

    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'n', ?, 'U1')",
      args: [ulid(), `project:n-${ulid()}`],
    });
    const r = await db.execute("SELECT access_mode FROM nodes LIMIT 1");
    assert.equal(r.rows[0].access_mode, "private");
  });

  it("CHECK constraint rejects a value outside private/request", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    const id = ulid();
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO nodes (id, type, name, sync_key, created_by, access_mode) VALUES (?, 'project', 'n', ?, 'U1', 'junk')",
        args: [id, `project:n-${id}`],
      }),
    );
  });
});

// Same trick as migration-019's test: seed rows on a shared-db fixture
// (already migrated), remove the 020 marker, re-run the migrations loop
// against a DB that pre-dates access_mode, and confirm the ALTER TABLE
// backfills the column with the default on existing rows too.
test("migration 020 adds access_mode to an existing nodes table with default 'private'", async () => {
  const { db, orgId } = await makeSharedDb();

  // Simulate a pre-migration DB: drop the column by rebuilding the table
  // without it, then remove the marker so runMigrations redoes the work.
  const info = await db.execute("PRAGMA table_info(nodes)");
  const hasColumn = info.rows.some((r) => r.name === "access_mode");
  assert.ok(hasColumn, "shared-db fixture should already have access_mode via DDL");

  await db.execute("ALTER TABLE nodes DROP COLUMN access_mode");
  await db.execute({
    sql: "DELETE FROM migrations WHERE id = ?",
    args: ["020_nodes_access_mode"],
  });

  await runMigrations(db);

  const postInfo = await db.execute("PRAGMA table_info(nodes)");
  const col = postInfo.rows.find((r) => r.name === "access_mode");
  assert.ok(col, "access_mode column must be re-added by the migration");

  const row = await db.execute({
    sql: "SELECT access_mode FROM nodes WHERE id = ?",
    args: [orgId],
  });
  assert.equal(row.rows[0].access_mode, "private", "existing rows must default to 'private'");
});
