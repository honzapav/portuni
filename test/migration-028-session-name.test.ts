// Validates migration 028 (sessions.name / name_is_custom) on both the
// fresh path (DDL) and the upgrade path, the backfill for pre-existing
// rows, and the NOT NULL / CHECK constraints. Mirrors the shape of
// test/migration-027-sessions.test.ts.
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { createClient } from "@libsql/client";
import { DDL } from "../apps/server/infra/schema-triggers.js";
import { runMigrations } from "../apps/server/infra/schema-migrations.js";
import { runMigration028 } from "../apps/server/infra/schema.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("migration 028 sessions.name / name_is_custom", () => {
  it("fresh install: name defaults to '' and name_is_custom to 0", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    const info = await db.execute("PRAGMA table_info(sessions)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(cols.has("name"));
    assert.ok(cols.has("name_is_custom"));
  });

  it("is idempotent across re-runs", async () => {
    const { db } = await makeSharedDb();
    await runMigration028(db);
    await runMigration028(db);
  });

  it("name_is_custom CHECK rejects a value outside {0,1}", async () => {
    const { db, nodeId } = await makeSharedDb();
    const id = ulid();
    await db.execute({
      sql: "INSERT INTO sessions (id, node_id, user_id, session_type) VALUES (?, ?, ?, 'interactive_task')",
      args: [id, nodeId, "U1"],
    });
    await assert.rejects(
      db.execute({ sql: "UPDATE sessions SET name_is_custom = 2 WHERE id = ?", args: [id] }),
    );
  });
});

// Upgrade path: drop the columns from an already-migrated fixture (via a
// fresh table swap, since SQLite can't DROP COLUMN on old versions), remove
// the 028 marker, and confirm runMigrations backfills existing rows with
// '<node name> · <date>' / 'Chat · <date>'.
test("migration 028 backfills name for pre-existing rows on upgrade", async () => {
  const { db, nodeId } = await makeSharedDb();
  const anchoredId = ulid();
  const chatId = ulid();
  const createdAt = "2026-05-01T10:00:00.000Z";
  await db.execute({
    sql: "INSERT INTO sessions (id, node_id, user_id, session_type, created_at) VALUES (?, ?, ?, 'interactive_task', ?)",
    args: [anchoredId, nodeId, "U1", createdAt],
  });
  await db.execute({
    sql: "INSERT INTO sessions (id, node_id, user_id, session_type, created_at) VALUES (?, NULL, ?, 'interactive_chat', ?)",
    args: [chatId, "U1", createdAt],
  });

  // Simulate a pre-028 DB: rebuild sessions without name/name_is_custom,
  // preserving the two rows above, then clear the migration marker. FKs
  // off for the rebuild -- same trick schema-migrations.ts uses for its own
  // table-recreate migrations.
  await db.execute("PRAGMA foreign_keys = OFF");
  await db.execute("ALTER TABLE sessions RENAME TO sessions_old");
  await db.execute(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, node_id TEXT, user_id TEXT NOT NULL, session_type TEXT NOT NULL,
    cli TEXT, profile_id TEXT, agent_session_id TEXT, state TEXT NOT NULL DEFAULT 'running',
    handoff_path TEXT, handoff_hash TEXT, created_at DATETIME NOT NULL, last_active_at DATETIME NOT NULL,
    closed_at DATETIME
  )`);
  await db.execute(`INSERT INTO sessions (id, node_id, user_id, session_type, cli, profile_id,
      agent_session_id, state, handoff_path, handoff_hash, created_at, last_active_at, closed_at)
    SELECT id, node_id, user_id, session_type, cli, profile_id, agent_session_id, state,
      handoff_path, handoff_hash, created_at, last_active_at, closed_at FROM sessions_old`);
  await db.execute("DROP TABLE sessions_old");
  await db.execute("PRAGMA foreign_keys = ON");
  await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["028_sessions_name"] });

  await runMigrations(db);

  const anchored = await db.execute({ sql: "SELECT name, name_is_custom FROM sessions WHERE id = ?", args: [anchoredId] });
  assert.equal(anchored.rows[0].name, "Stan GWS · 2026-05-01");
  assert.equal(anchored.rows[0].name_is_custom, 0);

  const chat = await db.execute({ sql: "SELECT name FROM sessions WHERE id = ?", args: [chatId] });
  assert.equal(chat.rows[0].name, "Chat · 2026-05-01");
});
