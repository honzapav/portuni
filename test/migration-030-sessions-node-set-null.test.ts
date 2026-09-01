// Validates migration 030 (sessions.node_id ON DELETE CASCADE -> SET NULL,
// #208): the durable session record and its session_scope audit must
// outlive the anchor node's deletion. Mirrors the shape of
// test/migration-028-session-name.test.ts.
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { createClient } from "@libsql/client";
import { DDL } from "../apps/server/infra/schema-triggers.js";
import { runMigrations } from "../apps/server/infra/schema-migrations.js";
import { runMigration030 } from "../apps/server/infra/schema.js";
import { upsertSessionScopeRead, getSessionScope, getSession } from "../apps/server/domain/sessions.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("migration 030 sessions.node_id ON DELETE SET NULL", () => {
  it("fresh install: sessions.node_id is ON DELETE SET NULL", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    const r = await db.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'",
      args: [],
    });
    assert.match(String(r.rows[0]?.sql ?? ""), /node_id TEXT REFERENCES nodes\(id\) ON DELETE SET NULL/);
  });

  it("is idempotent across re-runs", async () => {
    const { db } = await makeSharedDb();
    await runMigration030(db);
    await runMigration030(db);
  });
});

// Upgrade path: simulate a pre-030 DB (sessions.node_id ON DELETE CASCADE),
// clear the migration marker, and confirm runMigrations rewrites the FK
// clause while preserving every row -- including a resulting deletion test
// proving the session (and its session_scope audit) now survives its
// anchor node's deletion instead of being cascade-deleted with it.
test("migration 030 preserves existing rows and stops cascading session deletes off the anchor node", async () => {
  const { db, nodeId, orgId } = await makeSharedDb();
  const sessionId = ulid();
  await db.execute({
    sql: "INSERT INTO sessions (id, node_id, user_id, session_type, name) VALUES (?, ?, ?, 'interactive_task', 'pre-migration session')",
    args: [sessionId, nodeId, "U1"],
  });
  await upsertSessionScopeRead(db, sessionId, nodeId, "seed", "session_init seed");
  // A second, unrelated scope entry (a depth-1 neighbor reached at seed
  // time) that must survive the anchor node's deletion below.
  await upsertSessionScopeRead(db, sessionId, orgId, "seed", "session_init seed");

  // Simulate a pre-030 DB: rebuild sessions with the old CASCADE clause,
  // preserving the rows above, then clear the migration marker. Same
  // create-new/drop-old/rename-into-place order runMigration030 itself
  // uses (matches migrations 007/008's actors rebuild too) -- crucially
  // NOT a rename-away-first order. Renaming the original table away first
  // (sessions -> sessions_old) would make SQLite's modern ALTER-TABLE-
  // RENAME silently rewrite session_scope's FK clause to "REFERENCES
  // sessions_old(id)" (dependent-reference rewriting on rename happens
  // regardless of the foreign_keys pragma), which then dangles forever
  // once sessions_old is dropped.
  await db.execute("PRAGMA foreign_keys = OFF");
  await db.execute(`CREATE TABLE sessions_legacy (
    id TEXT PRIMARY KEY,
    node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    session_type TEXT NOT NULL,
    cli TEXT, profile_id TEXT, agent_session_id TEXT, state TEXT NOT NULL DEFAULT 'running',
    handoff_path TEXT, handoff_hash TEXT,
    name TEXT NOT NULL DEFAULT '', name_is_custom INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')), last_active_at DATETIME NOT NULL DEFAULT (datetime('now')),
    closed_at DATETIME
  )`);
  await db.execute(`INSERT INTO sessions_legacy (id, node_id, user_id, session_type, cli, profile_id,
      agent_session_id, state, handoff_path, handoff_hash, name, name_is_custom, created_at, last_active_at, closed_at)
    SELECT id, node_id, user_id, session_type, cli, profile_id, agent_session_id, state,
      handoff_path, handoff_hash, name, name_is_custom, created_at, last_active_at, closed_at FROM sessions`);
  await db.execute("DROP TABLE sessions");
  await db.execute("ALTER TABLE sessions_legacy RENAME TO sessions");
  await db.execute("PRAGMA foreign_keys = ON");
  await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["030_sessions_node_set_null"] });

  // Sanity: the simulated legacy schema really does cascade (proves the
  // "before" behavior the migration fixes, not just a passthrough).
  const preCheck = await db.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'",
    args: [],
  });
  assert.match(String(preCheck.rows[0]?.sql ?? ""), /ON DELETE CASCADE/);

  await runMigrations(db);

  const postCheck = await db.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'",
    args: [],
  });
  assert.match(String(postCheck.rows[0]?.sql ?? ""), /node_id TEXT REFERENCES nodes\(id\) ON DELETE SET NULL/);

  const preserved = await getSession(db, sessionId);
  assert.equal(preserved?.name, "pre-migration session");
  assert.equal(preserved?.node_id, nodeId);

  // The actual behavior change: deleting the anchor node must no longer
  // cascade-delete the session or its audit.
  await db.execute({ sql: "DELETE FROM nodes WHERE id = ?", args: [nodeId] });

  const survived = await getSession(db, sessionId);
  assert.ok(survived, "session record must survive its anchor node's deletion");
  assert.equal(survived?.node_id, null, "node_id is SET NULL, not left dangling");

  // session_scope.node_id keeps its own (unchanged) ON DELETE CASCADE, so
  // the scope row for the deleted node itself is gone -- but the session
  // record and the OTHER node's scope row (proving the audit as a whole
  // survives) remain.
  const scope = await getSessionScope(db, sessionId);
  assert.equal(scope.length, 1, "the deleted node's own scope row cascades away independently");
  assert.equal(scope[0].node_id, orgId, "the surviving node's scope row is untouched");
});
