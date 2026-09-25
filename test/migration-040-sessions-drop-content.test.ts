// Validates migration 040 (#462, the central migration of
// docs/superpowers/specs/2026-09-22-local-sessions-design.md): sessions is
// rebuilt without `brief` and `handoff_inline`, and the graph db's
// `session_events` is dropped. A thread's content lives on the device
// (content.db); the record keeps every other column and its indexes. Same
// methodology as the 030 and 036 rebuild tests. libsql only: the Postgres
// baseline carries the new shape directly (schema-pg-baseline.test.ts).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import {
  runMigration040,
  runMigrations,
  SESSION_CONTENT_DROP_MIGRATION_ID,
} from "../apps/server/infra/schema-migrations.js";
import type { DbClient } from "../apps/server/infra/db.js";
import { makeSharedDb } from "./helpers/shared-db.js";
import { makeLegacySessionContentSchema } from "./helpers/legacy-session-content.js";

async function sessionColumns(db: DbClient): Promise<string[]> {
  return (await db.execute("PRAGMA table_info(sessions)")).rows.map((r) => String(r.name));
}

async function sessionIndexes(db: DbClient): Promise<string[]> {
  const r = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
  );
  return r.rows.map((row) => String(row.name));
}

async function tableExists(db: DbClient, name: string): Promise<boolean> {
  const r = await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", args: [name] });
  return r.rows.length > 0;
}

async function applied(db: DbClient): Promise<boolean> {
  const r = await db.execute({ sql: "SELECT 1 FROM migrations WHERE id = ?", args: [SESSION_CONTENT_DROP_MIGRATION_ID] });
  return r.rows.length > 0;
}

describe("migration 040 drops the session content from the graph db", () => {
  it("a fresh install has no brief, no handoff_inline and no session_events, and records 040", async () => {
    const { db } = await makeSharedDb("libsql");
    const cols = await sessionColumns(db);
    assert.ok(!cols.includes("brief"));
    assert.ok(!cols.includes("handoff_inline"));
    assert.equal(await tableExists(db, "session_events"), false);
    assert.equal(await applied(db), true);
  });

  it("the rebuild keeps every other column's value, the indexes, the runs and the scope", async () => {
    const { db, nodeId } = await makeSharedDb("libsql");
    const currentCols = await sessionColumns(db);
    const currentIndexes = await sessionIndexes(db);
    await makeLegacySessionContentSchema(db);

    const id = ulid();
    await db.execute({
      sql: `INSERT INTO sessions (id, node_id, user_id, session_type, cli, instance_id, agent_session_id, terminal_id,
              brief, runner, host_id, waiting_since, state, handoff_path, handoff_hash, handoff_inline, name,
              name_is_custom, model, effort, context_used_tokens, context_max_tokens, created_at, last_active_at, closed_at)
            VALUES (?, ?, 'U1', 'interactive_task', 'claude', 'work', 'conv-1', NULL,
              'Oprav test', 'claude', 'honzas-mac', '2026-09-20 08:00:00', 'suspended', 'handoffs/a.md', 'h1', '# Shrnutí',
              'Moje vlákno', 1, 'opus', 'high', 1200, 200000, '2026-09-19 10:00:00', '2026-09-20 09:00:00', NULL)`,
      args: [id, nodeId],
    });
    const runId = ulid();
    await db.execute({
      sql: "INSERT INTO session_runs (id, session_id, runner, host_id) VALUES (?, ?, 'claude', 'honzas-mac')",
      args: [runId, id],
    });
    await db.execute({
      sql: "INSERT INTO session_scope (session_id, node_id, added_via, writable) VALUES (?, ?, 'seed', 1)",
      args: [id, nodeId],
    });
    await db.execute({
      sql: "INSERT INTO session_events (id, session_id, run_id, seq, kind, payload) VALUES (?, ?, ?, 1, 'run_started', '{}')",
      args: [ulid(), id, runId],
    });

    await ensureSchemaOn(db);

    assert.deepEqual(await sessionColumns(db), currentCols, "exactly the current shape, in order");
    assert.deepEqual(await sessionIndexes(db), currentIndexes);
    assert.equal(await tableExists(db, "session_events"), false);
    assert.equal(await tableExists(db, "sessions_new"), false);
    assert.equal(await applied(db), true);

    const row = (await db.execute({ sql: "SELECT * FROM sessions WHERE id = ?", args: [id] })).rows[0];
    assert.deepEqual(
      { ...row },
      {
        id,
        node_id: nodeId,
        user_id: "U1",
        session_type: "interactive_task",
        cli: "claude",
        instance_id: "work",
        agent_session_id: "conv-1",
        terminal_id: null,
        runner: "claude",
        host_id: "honzas-mac",
        waiting_since: "2026-09-20 08:00:00",
        state: "suspended",
        handoff_path: "handoffs/a.md",
        handoff_hash: "h1",
        name: "Moje vlákno",
        name_is_custom: 1,
        model: "opus",
        effort: "high",
        context_used_tokens: 1200,
        context_max_tokens: 200000,
        created_at: "2026-09-19 10:00:00",
        last_active_at: "2026-09-20 09:00:00",
        closed_at: null,
      },
    );
    // The foreign keys onto sessions survived the rebuild: nothing cascaded.
    assert.equal((await db.execute({ sql: "SELECT 1 FROM session_runs WHERE session_id = ?", args: [id] })).rows.length, 1);
    assert.equal((await db.execute({ sql: "SELECT 1 FROM session_scope WHERE session_id = ?", args: [id] })).rows.length, 1);
    assert.equal((await db.execute("PRAGMA foreign_key_check")).rows.length, 0);
    // And they still hold: deleting the session cascades to its run.
    await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [id] });
    assert.equal((await db.execute({ sql: "SELECT 1 FROM session_runs WHERE session_id = ?", args: [id] })).rows.length, 0);
  });

  it("is idempotent: a second pass finds it applied and changes nothing", async () => {
    const { db } = await makeSharedDb("libsql");
    await makeLegacySessionContentSchema(db);
    await runMigrations(db);
    const cols = await sessionColumns(db);
    await runMigrations(db);
    await ensureSchemaOn(db);
    assert.deepEqual(await sessionColumns(db), cols);
  });

  it("a hold leaves the content in place and 040 unrecorded", async () => {
    const { db } = await makeSharedDb("libsql");
    await makeLegacySessionContentSchema(db);
    await ensureSchemaOn(db, { holdSessionContentDrop: true });
    assert.ok((await sessionColumns(db)).includes("brief"));
    assert.equal(await tableExists(db, "session_events"), true);
    assert.equal(await applied(db), false);
  });

  // docs/lessons-learned.md section 7, point 4: a rebuild that died after
  // DROP TABLE sessions leaves the rows in sessions_new; a DDL replay then
  // creates an empty sessions of the new shape. That must not read as done.
  it("a leftover sessions_new is never mistaken for a finished rebuild", async () => {
    const { db } = await makeSharedDb("libsql");
    await db.execute("CREATE TABLE sessions_new (id TEXT PRIMARY KEY)");
    await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: [SESSION_CONTENT_DROP_MIGRATION_ID] });
    await assert.rejects(() => runMigrations(db), /sessions_new/);
    assert.equal(await applied(db), false);
  });
});

// Structural guard, same reasoning as 030's and 036's: the rebuild is one
// executeMultiple script (incident 2026-06-10, migration 017).
describe("migration 040 is a single-connection rebuild", () => {
  it("issues the rebuild and the drop through executeMultiple, not statement by statement", async () => {
    const scripts: string[] = [];
    const statements: string[] = [];
    const fake = {
      async execute(stmt: unknown) {
        statements.push(typeof stmt === "string" ? stmt : (stmt as { sql: string }).sql);
        return { rows: [] };
      },
      async executeMultiple(script: string) {
        scripts.push(script);
      },
    };
    await runMigration040(fake as unknown as Parameters<typeof runMigration040>[0]);

    assert.equal(scripts.length, 1, "the rebuild must be exactly one script");
    const script = scripts[0];
    for (const required of [
      "PRAGMA foreign_keys = OFF",
      "DROP TABLE IF EXISTS session_events",
      "CREATE TABLE sessions_new",
      "INSERT INTO sessions_new",
      "DROP TABLE sessions;",
      "ALTER TABLE sessions_new RENAME TO sessions",
      "PRAGMA foreign_keys = ON",
    ]) {
      assert.ok(script.includes(required), `${required} must be inside the script`);
    }
    assert.ok(!/\bbrief\b/.test(script), "brief is not part of the new shape");
    assert.ok(!/handoff_inline/.test(script), "handoff_inline is not part of the new shape");
    assert.deepEqual(statements, [], "no statement may run outside the script");
  });
});
