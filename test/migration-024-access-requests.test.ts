// test/migration-024-access-requests.test.ts
// Validates that migration 024 creates `access_requests` on both the fresh
// path (DDL) and the upgrade path (runMigrations on a DB without the
// table), enforces the one-pending-per-(node, user) partial unique index
// and the status CHECK, and cascades on node deletion.
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { createClient } from "@libsql/client";
import { DDL } from "../apps/server/infra/schema-triggers.js";
import { runMigrations } from "../apps/server/infra/schema-migrations.js";
import { runMigration024 } from "../apps/server/infra/schema.js";
import { makeSharedDb } from "./helpers/shared-db.js";

async function tableExists(db: ReturnType<typeof createClient>, name: string) {
  const r = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [name],
  });
  return r.rows.length > 0;
}

describe("migration 024 access_requests", () => {
  it("creates access_requests on fresh install (DDL)", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    assert.ok(await tableExists(db, "access_requests"));
    const idx = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='access_requests'",
    );
    const names = new Set(idx.rows.map((r) => String(r.name)));
    assert.ok(names.has("idx_access_requests_pending"));
    assert.ok(names.has("idx_access_requests_status"));
  });

  it("is idempotent across re-runs", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    await runMigration024(db);
    await runMigration024(db);
    assert.ok(await tableExists(db, "access_requests"));
  });

  it("allows one pending request per (node, user) but keeps resolved history", async () => {
    const { db, nodeId } = await makeSharedDb();
    const insert = (status: string) =>
      db.execute({
        sql: "INSERT INTO access_requests (id, node_id, user_id, status) VALUES (?, ?, ?, ?)",
        args: [ulid(), nodeId, "U1", status],
      });
    await insert("denied");
    await insert("approved");
    await insert("pending");
    await assert.rejects(insert("pending"), /UNIQUE|unique/);
    const r = await db.execute("SELECT count(*) AS c FROM access_requests");
    assert.equal(Number(r.rows[0].c), 3);
  });

  it("CHECK rejects a status outside pending/approved/denied", async () => {
    const { db, nodeId } = await makeSharedDb();
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO access_requests (id, node_id, user_id, status) VALUES (?, ?, ?, 'junk')",
        args: [ulid(), nodeId, "U1"],
      }),
    );
  });

  it("cascades on node delete", async () => {
    const { db, nodeId } = await makeSharedDb();
    await db.execute({
      sql: "INSERT INTO access_requests (id, node_id, user_id) VALUES (?, ?, ?)",
      args: [ulid(), nodeId, "U1"],
    });
    await db.execute({ sql: "DELETE FROM nodes WHERE id = ?", args: [nodeId] });
    const r = await db.execute("SELECT count(*) AS c FROM access_requests");
    assert.equal(Number(r.rows[0].c), 0);
  });
});

// Upgrade path: drop the table from an already-migrated fixture, remove the
// 024 marker, and confirm the migrations loop recreates it -- same trick as
// migration-019/020's tests.
test("migration 024 adds access_requests to an existing DB", async () => {
  const { db, nodeId } = await makeSharedDb();
  await db.execute("DROP TABLE access_requests");
  await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["024_access_requests"] });
  assert.equal(await tableExists(db, "access_requests"), false);

  await runMigrations(db);

  assert.ok(await tableExists(db, "access_requests"));
  await db.execute({
    sql: "INSERT INTO access_requests (id, node_id, user_id, message) VALUES (?, ?, ?, ?)",
    args: [ulid(), nodeId, "U1", "hi"],
  });
  const r = await db.execute("SELECT status, message FROM access_requests");
  assert.equal(r.rows[0].status, "pending");
  assert.equal(r.rows[0].message, "hi");
  const marker = await db.execute({
    sql: "SELECT id FROM migrations WHERE id = ?",
    args: ["024_access_requests"],
  });
  assert.equal(marker.rows.length, 1);
});
