// Validates migration 034 (runner batch: sessions gains brief/runner/
// host_id/waiting_since, profile_id is renamed to instance_id, session_runs
// and session_events are created). Mirrors the shape of
// test/migration-030-sessions-node-set-null.test.ts and
// test/schema-upgrade-ordering.test.ts (plant the legacy table, then run
// ensureSchemaOn / runMigrations and assert the upgrade).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { DDL } from "../apps/server/infra/schema-triggers.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { runMigrations } from "../apps/server/infra/schema-migrations.js";

// The sessions table exactly as it exists right before migration 034: every
// column DDL_SESSIONS has today except brief/runner/host_id/waiting_since,
// with the pre-rename profile_id column.
const PRE_034_SESSIONS = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY CHECK(length(id) = 26),
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_type TEXT NOT NULL CHECK(session_type IN ('interactive_task','interactive_chat','headless','env')),
  cli TEXT,
  profile_id TEXT,
  agent_session_id TEXT,
  terminal_id TEXT,
  state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','suspended','closed','archived')),
  handoff_path TEXT,
  handoff_hash TEXT,
  name TEXT NOT NULL DEFAULT '',
  name_is_custom INTEGER NOT NULL DEFAULT 0 CHECK(name_is_custom IN (0,1)),
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  last_active_at DATETIME NOT NULL DEFAULT (datetime('now')),
  closed_at DATETIME
)`;

async function buildPre034Db(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  for (const sql of DDL) {
    if (/CREATE TABLE IF NOT EXISTS sessions\b/.test(sql)) continue;
    if (/CREATE\s+(UNIQUE\s+)?INDEX[^;]*\bON sessions\(/i.test(sql)) continue;
    // session_runs/session_events are brand new tables with a FK onto
    // sessions -- skip them too so the legacy DB genuinely predates them,
    // matching a real pre-034 database.
    if (/CREATE TABLE IF NOT EXISTS session_runs\b/.test(sql)) continue;
    if (/CREATE\s+(UNIQUE\s+)?INDEX[^;]*\bON session_runs\(/i.test(sql)) continue;
    if (/CREATE TABLE IF NOT EXISTS session_events\b/.test(sql)) continue;
    await db.execute(sql);
  }
  await db.execute(PRE_034_SESSIONS);
  return db;
}

describe("migration 034 sessions runner columns", () => {
  it("upgrades a pre-034 database: renames profile_id, adds columns, creates the run/event tables", async () => {
    const db = await buildPre034Db();
    await db.execute({
      sql: "INSERT INTO users (id, email, name) VALUES ('U1', 'a@b', 'A')",
    });
    await db.execute({
      sql: `INSERT INTO sessions (id, node_id, user_id, session_type, cli, profile_id, agent_session_id, name)
            VALUES ('S0000000000000000000000001', NULL, 'U1', 'interactive_task', 'claude', 'work', 'conv-1', 'pre-migration session')`,
    });

    await ensureSchemaOn(db);

    const cols = await db.execute("PRAGMA table_info(sessions)");
    const colNames = new Set(cols.rows.map((r) => r.name as string));
    assert.ok(colNames.has("instance_id"), "profile_id must be renamed to instance_id");
    assert.ok(!colNames.has("profile_id"), "the old column name must be gone");
    for (const col of ["brief", "runner", "host_id", "waiting_since"]) {
      assert.ok(colNames.has(col), `sessions must gain ${col}`);
    }

    const row = await db.execute({
      sql: "SELECT instance_id, brief, runner, host_id, waiting_since FROM sessions WHERE id = ?",
      args: ["S0000000000000000000000001"],
    });
    assert.equal(row.rows[0].instance_id, "work", "the rename must preserve the existing value");
    assert.equal(row.rows[0].brief, null);
    assert.equal(row.rows[0].runner, null);
    assert.equal(row.rows[0].host_id, null);
    assert.equal(row.rows[0].waiting_since, null);

    const tables = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_runs','session_events')",
    );
    assert.deepEqual(
      tables.rows.map((r) => r.name).sort(),
      ["session_events", "session_runs"],
    );
  });

  it("is idempotent across re-runs", async () => {
    const db = await buildPre034Db();
    await db.execute({ sql: "INSERT INTO users (id, email, name) VALUES ('U1', 'a@b', 'A')" });
    await ensureSchemaOn(db);
    await runMigrations(db);
    await runMigrations(db);
  });

  it("a fresh install already has instance_id and the run/event tables", async () => {
    const db = createClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    const cols = await db.execute("PRAGMA table_info(sessions)");
    const colNames = new Set(cols.rows.map((r) => r.name as string));
    assert.ok(colNames.has("instance_id"));
    assert.ok(!colNames.has("profile_id"));
    for (const col of ["brief", "runner", "host_id", "waiting_since"]) {
      assert.ok(colNames.has(col));
    }
    const tables = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_runs','session_events')",
    );
    assert.equal(tables.rows.length, 2);
  });
});
