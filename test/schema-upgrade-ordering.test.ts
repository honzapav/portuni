// ensureSchemaOn replays DDL BEFORE running migrations. Anything in that
// replay which depends on a column a migration adds therefore fails on every
// database old enough to need the migration -- and the server never finishes
// booting.
//
// That is how the 0.11.0 -> 0.13.x deploy took api.portuni.com down:
//
//   SQLite input error: no such column: terminal_id (at offset 61)
//     at ensureSchemaOn (dist/infra/schema.js:102)
//
// `CREATE INDEX ... ON sessions(terminal_id)` sat in DDL; the column arrives
// with migration 032. IF NOT EXISTS does not help -- the table exists, the
// index does not, so SQLite tries to build it and hits the missing column.
//
// It cannot live only in 032 either: on a fresh install DDL_SESSIONS already
// declares terminal_id, so 032's isApplied reports it done and never runs.
// Each path covered the column on its own and the two excluded each other.
// DDL_AFTER_MIGRATIONS is the one point where a single statement covers both.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { DDL, DDL_AFTER_MIGRATIONS } from "../apps/server/infra/schema-triggers.js";

// The sessions table as a database predating migration 032 has it: no
// terminal_id, and node_id still ON DELETE CASCADE (pre-030).
const OLD_SESSIONS = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY CHECK(length(id) = 26),
  node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_type TEXT NOT NULL CHECK(session_type IN ('interactive_task','interactive_chat','headless','env')),
  cli TEXT,
  profile_id TEXT,
  agent_session_id TEXT,
  state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','suspended','closed','archived')),
  handoff_path TEXT,
  handoff_hash TEXT,
  name TEXT NOT NULL DEFAULT '',
  name_is_custom INTEGER NOT NULL DEFAULT 0 CHECK(name_is_custom IN (0,1)),
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  last_active_at DATETIME NOT NULL DEFAULT (datetime('now')),
  closed_at DATETIME
)`;

async function hasIndex(db: Client, name: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='index' AND name = ?",
    args: [name],
  });
  return r.rows.length === 1;
}

describe("schema upgrade ordering", () => {
  it("no DDL statement may reference a column a migration adds", () => {
    // The structural rule, checked without a database: a statement naming
    // terminal_id cannot be in the replay that runs before the migrations.
    const offenders = DDL.filter(
      (s) => /CREATE\s+(UNIQUE\s+)?INDEX/i.test(s) && s.includes("terminal_id"),
    );
    assert.deepEqual(
      offenders,
      [],
      `these run before migrations and would fail on a pre-032 database:\n${offenders.join("\n")}`,
    );
    assert.ok(
      DDL_AFTER_MIGRATIONS.some((s) => s.includes("terminal_id")),
      "the index still has to be created somewhere",
    );
  });

  it("upgrades a database whose sessions table predates terminal_id", async () => {
    const db = createClient({ url: ":memory:" });
    // Bring up everything EXCEPT sessions, then plant the old shape so the
    // DDL replay's `IF NOT EXISTS` leaves it alone -- exactly production's
    // position before the deploy.
    for (const sql of DDL) {
      // Skip only the sessions table itself and the indexes ON it; every
      // other statement (session_scope included) must still be created.
      if (/CREATE TABLE IF NOT EXISTS sessions\b/.test(sql)) continue;
      if (/CREATE\s+INDEX[^;]*\bON sessions\(/i.test(sql)) continue;
      await db.execute(sql);
    }
    await db.execute(OLD_SESSIONS);

    await ensureSchemaOn(db);

    const cols = await db.execute("PRAGMA table_info(sessions)");
    assert.ok(
      cols.rows.some((r) => r.name === "terminal_id"),
      "migration 032 must have added the column",
    );
    assert.ok(await hasIndex(db, "idx_sessions_terminal"), "and the index must exist after");
  });

  it("a fresh install gets the same index, where the migration is skipped", async () => {
    const db = createClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    const cols = await db.execute("PRAGMA table_info(sessions)");
    assert.ok(cols.rows.some((r) => r.name === "terminal_id"));
    // 032's isApplied reports done here (DDL_SESSIONS already declares the
    // column), so nothing in the migration pass creates this index.
    assert.ok(await hasIndex(db, "idx_sessions_terminal"));
  });
});
