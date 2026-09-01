import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { createClient } from "@libsql/client";
import { DDL } from "../apps/server/infra/schema-triggers.js";
import { runMigrations } from "../apps/server/infra/schema-migrations.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("migration 029 nodes.health", () => {
  it("creates health with default 'on_track' on fresh install (DDL)", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    const info = await db.execute("PRAGMA table_info(nodes)");
    const col = info.rows.find((r) => r.name === "health");
    assert.ok(col, "health column must exist");
    assert.equal(col!.notnull, 1);

    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'n', ?, 'U1')",
      args: [ulid(), `project:n-${ulid()}`],
    });
    const r = await db.execute("SELECT health FROM nodes LIMIT 1");
    assert.equal(r.rows[0].health, "on_track");
  });

  it("CHECK constraint rejects a value outside on_track/at_risk/off_track", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    const id = ulid();
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO nodes (id, type, name, sync_key, created_by, health) VALUES (?, 'project', 'n', ?, 'U1', 'junk')",
        args: [id, `project:n-${id}`],
      }),
    );
  });
});

// Same trick as migration-020's test: seed rows on a shared-db fixture
// (already migrated), remove the 029 marker, re-run the migrations loop
// against a DB that pre-dates health, and confirm the ALTER TABLE
// backfills the column with the default on existing rows too.
test("migration 029 adds health to an existing nodes table with default 'on_track'", async () => {
  const { db, orgId } = await makeSharedDb();

  const info = await db.execute("PRAGMA table_info(nodes)");
  const hasColumn = info.rows.some((r) => r.name === "health");
  assert.ok(hasColumn, "shared-db fixture should already have health via DDL");

  await db.execute("ALTER TABLE nodes DROP COLUMN health");
  await db.execute({
    sql: "DELETE FROM migrations WHERE id = ?",
    args: ["029_nodes_health"],
  });

  await runMigrations(db);

  const postInfo = await db.execute("PRAGMA table_info(nodes)");
  const col = postInfo.rows.find((r) => r.name === "health");
  assert.ok(col, "health column must be re-added by the migration");

  const row = await db.execute({
    sql: "SELECT health FROM nodes WHERE id = ?",
    args: [orgId],
  });
  assert.equal(row.rows[0].health, "on_track", "existing rows must default to 'on_track'");
});
