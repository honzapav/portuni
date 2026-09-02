// Validates that migration 027 creates `sessions` and `session_scope` on
// both the fresh path (DDL) and the upgrade path (runMigrations on a DB
// without the tables), enforces the state/added_via CHECKs and the
// session_scope composite PK, and cascades on node/session deletion.
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { createClient } from "@libsql/client";
import { DDL } from "../apps/server/infra/schema-triggers.js";
import { runMigrations } from "../apps/server/infra/schema-migrations.js";
import { runMigration027 } from "../apps/server/infra/schema.js";
import { makeSharedDb } from "./helpers/shared-db.js";

async function tableExists(db: ReturnType<typeof createClient>, name: string) {
  const r = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [name],
  });
  return r.rows.length > 0;
}

describe("migration 027 sessions + session_scope", () => {
  it("creates both tables and their indexes on fresh install (DDL)", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    assert.ok(await tableExists(db, "sessions"));
    assert.ok(await tableExists(db, "session_scope"));
    const idx = await db.execute(
      "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND tbl_name IN ('sessions','session_scope')",
    );
    const names = new Set(idx.rows.map((r) => String(r.name)));
    assert.ok(names.has("idx_sessions_node"));
    assert.ok(names.has("idx_sessions_user"));
    assert.ok(names.has("idx_sessions_state"));
    assert.ok(names.has("idx_session_scope_session"));
  });

  it("is idempotent across re-runs", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    await runMigration027(db);
    await runMigration027(db);
    assert.ok(await tableExists(db, "sessions"));
    assert.ok(await tableExists(db, "session_scope"));
  });

  it("CHECK rejects a session_type or state outside the closed sets", async () => {
    const { db, nodeId } = await makeSharedDb();
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO sessions (id, node_id, user_id, session_type) VALUES (?, ?, ?, 'junk')",
        args: [ulid(), nodeId, "U1"],
      }),
    );
    const id = ulid();
    await db.execute({
      sql: "INSERT INTO sessions (id, node_id, user_id, session_type) VALUES (?, ?, ?, 'interactive_task')",
      args: [id, nodeId, "U1"],
    });
    await assert.rejects(
      db.execute({ sql: "UPDATE sessions SET state = 'junk' WHERE id = ?", args: [id] }),
    );
  });

  it("session_scope CHECK rejects an added_via outside the closed set", async () => {
    const { db, nodeId } = await makeSharedDb();
    const sessionId = ulid();
    await db.execute({
      sql: "INSERT INTO sessions (id, node_id, user_id, session_type) VALUES (?, ?, ?, 'interactive_task')",
      args: [sessionId, nodeId, "U1"],
    });
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO session_scope (session_id, node_id, added_via) VALUES (?, ?, 'junk')",
        args: [sessionId, nodeId],
      }),
    );
  });

  it("session_scope's composite PK rejects a duplicate (session_id, node_id)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const sessionId = ulid();
    await db.execute({
      sql: "INSERT INTO sessions (id, node_id, user_id, session_type) VALUES (?, ?, ?, 'interactive_task')",
      args: [sessionId, nodeId, "U1"],
    });
    await db.execute({
      sql: "INSERT INTO session_scope (session_id, node_id, added_via) VALUES (?, ?, 'seed')",
      args: [sessionId, nodeId],
    });
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO session_scope (session_id, node_id, added_via) VALUES (?, ?, 'edge')",
        args: [sessionId, nodeId],
      }),
    );
  });

  it("session_scope cascades on node delete; sessions.node_id is SET NULL, not cascade-deleted (#208)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const sessionId = ulid();
    await db.execute({
      sql: "INSERT INTO sessions (id, node_id, user_id, session_type) VALUES (?, ?, ?, 'interactive_task')",
      args: [sessionId, nodeId, "U1"],
    });
    await db.execute({
      sql: "INSERT INTO session_scope (session_id, node_id, added_via) VALUES (?, ?, 'seed')",
      args: [sessionId, nodeId],
    });
    await db.execute({ sql: "DELETE FROM nodes WHERE id = ?", args: [nodeId] });
    // session_scope.node_id still cascades: the audit row for a now-deleted
    // node has nothing left to describe.
    const r1 = await db.execute("SELECT count(*) AS c FROM session_scope");
    assert.equal(Number(r1.rows[0].c), 0);
    // sessions.node_id is migration 030's SET NULL fix: the durable session
    // record survives its anchor node's deletion (spec: "durable core
    // outlives"), with node_id nulled out rather than the row disappearing.
    const r2 = await db.execute({ sql: "SELECT node_id FROM sessions WHERE id = ?", args: [sessionId] });
    assert.equal(r2.rows.length, 1);
    assert.equal(r2.rows[0].node_id, null);
  });

  it("sessions.node_id is nullable (interactive_chat has no anchor)", async () => {
    const { db } = await makeSharedDb();
    const id = ulid();
    await db.execute({
      sql: "INSERT INTO sessions (id, node_id, user_id, session_type) VALUES (?, NULL, ?, 'interactive_chat')",
      args: [id, "U1"],
    });
    const r = await db.execute({ sql: "SELECT node_id, state FROM sessions WHERE id = ?", args: [id] });
    assert.equal(r.rows[0].node_id, null);
    assert.equal(r.rows[0].state, "running");
  });
});

// Upgrade path: drop both tables from an already-migrated fixture, remove
// the 027 marker, and confirm the migrations loop recreates them -- same
// trick as migration-019/020/024's tests.
test("migration 027 adds sessions + session_scope to an existing DB", async () => {
  const { db, nodeId } = await makeSharedDb();
  await db.execute("DROP TABLE session_scope");
  await db.execute("DROP TABLE sessions");
  await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["027_sessions"] });
  assert.equal(await tableExists(db, "sessions"), false);
  assert.equal(await tableExists(db, "session_scope"), false);

  await runMigrations(db);

  assert.ok(await tableExists(db, "sessions"));
  assert.ok(await tableExists(db, "session_scope"));
  const sessionId = ulid();
  await db.execute({
    sql: "INSERT INTO sessions (id, node_id, user_id, session_type) VALUES (?, ?, ?, 'headless')",
    args: [sessionId, nodeId, "U1"],
  });
  const r = await db.execute({ sql: "SELECT state FROM sessions WHERE id = ?", args: [sessionId] });
  assert.equal(r.rows[0].state, "running");
  const marker = await db.execute({
    sql: "SELECT id FROM migrations WHERE id = ?",
    args: ["027_sessions"],
  });
  assert.equal(marker.rows.length, 1);
});
