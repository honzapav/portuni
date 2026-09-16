// Validates migration 036 (#374: sessions.state CHECK gains 'draft'; #375
// added sessions.model/effort to this same migration, landing in the same
// batch). SQLite cannot ALTER a CHECK constraint, so this is a table
// rebuild -- same methodology as
// test/migration-030-sessions-node-set-null.test.ts.
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { createClient } from "@libsql/client";
import { runMigration036 } from "../apps/server/infra/schema-migrations.js";
import { getSession } from "../apps/server/domain/sessions.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("migration 036 sessions.state gains 'draft'", () => {
  it("fresh install already allows 'draft'", async () => {
    const db = createClient({ url: ":memory:" });
    const { ensureSchemaOn } = await import("../apps/server/infra/schema.js");
    await ensureSchemaOn(db);
    const r = await db.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'",
      args: [],
    });
    assert.match(String(r.rows[0]?.sql ?? ""), /'draft'/);
  });

  it("fresh install already has model/effort columns (#375)", async () => {
    const db = createClient({ url: ":memory:" });
    const { ensureSchemaOn } = await import("../apps/server/infra/schema.js");
    await ensureSchemaOn(db);
    const info = await db.execute("PRAGMA table_info(sessions)");
    const cols = new Set(info.rows.map((r) => r.name as string));
    assert.ok(cols.has("model"));
    assert.ok(cols.has("effort"));
  });

  it("is idempotent across re-runs", async () => {
    const { db } = await makeSharedDb("libsql");
    await runMigration036(db);
    await runMigration036(db);
  });
});

test("migration 036 preserves existing rows and allows a draft afterward", async () => {
  const { db, nodeId } = await makeSharedDb("libsql");
  const sessionId = ulid();
  await db.execute({
    sql: "INSERT INTO sessions (id, node_id, user_id, session_type, name) VALUES (?, ?, ?, 'interactive_task', 'pre-migration session')",
    args: [sessionId, nodeId, "U1"],
  });

  // Simulate a pre-036 DB: rebuild sessions with the old CHECK (no
  // 'draft'), preserving the row above, then clear the migration marker.
  await db.execute("PRAGMA foreign_keys = OFF");
  await db.execute(`CREATE TABLE sessions_legacy (
    id TEXT PRIMARY KEY,
    node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    session_type TEXT NOT NULL,
    cli TEXT, instance_id TEXT, agent_session_id TEXT, terminal_id TEXT,
    brief TEXT, runner TEXT, host_id TEXT, waiting_since TEXT,
    state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','suspended','closed','archived')),
    handoff_path TEXT, handoff_hash TEXT, handoff_inline TEXT,
    name TEXT NOT NULL DEFAULT '', name_is_custom INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')), last_active_at DATETIME NOT NULL DEFAULT (datetime('now')),
    closed_at DATETIME
  )`);
  await db.execute(`INSERT INTO sessions_legacy SELECT
      id, node_id, user_id, session_type, cli, instance_id, agent_session_id, terminal_id, brief, runner,
      host_id, waiting_since, state, handoff_path, handoff_hash, handoff_inline, name, name_is_custom,
      created_at, last_active_at, closed_at
    FROM sessions`);
  await db.execute("DROP TABLE sessions");
  await db.execute("ALTER TABLE sessions_legacy RENAME TO sessions");
  await db.execute("PRAGMA foreign_keys = ON");
  await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["036_sessions_draft_state"] });

  // Sanity: the simulated legacy schema really does reject 'draft'.
  await assert.rejects(() =>
    db.execute({
      sql: "INSERT INTO sessions (id, node_id, user_id, session_type, state, name) VALUES (?, ?, ?, 'interactive_task', 'draft', 'x')",
      args: [ulid(), nodeId, "U1"],
    }),
  );

  await runMigration036(db);

  const preserved = await getSession(db, sessionId);
  assert.equal(preserved?.name, "pre-migration session");
  assert.equal(preserved?.node_id, nodeId);

  // The actual behavior change: 'draft' is now a valid state.
  const draftId = ulid();
  await db.execute({
    sql: "INSERT INTO sessions (id, node_id, user_id, session_type, state, name) VALUES (?, ?, ?, 'interactive_task', 'draft', 'x')",
    args: [draftId, nodeId, "U1"],
  });
  const draft = await getSession(db, draftId);
  assert.equal(draft?.state, "draft");

  // #375: model/effort exist and default to NULL for a row preserved
  // across the rebuild (the legacy source table had neither column).
  assert.equal(preserved?.model, null);
  assert.equal(preserved?.effort, null);

  await db.execute({ sql: "UPDATE sessions SET model = ?, effort = ? WHERE id = ?", args: ["claude-opus-4-8", "high", draftId] });
  const withDefaults = await getSession(db, draftId);
  assert.equal(withDefaults?.model, "claude-opus-4-8");
  assert.equal(withDefaults?.effort, "high");

  await assert.rejects(() =>
    db.execute({ sql: "UPDATE sessions SET effort = 'bogus' WHERE id = ?", args: [draftId] }),
  );
});

// Structural guard, same reasoning as migration 030's own: the rebuild must
// be a single executeMultiple script (incident 2026-06-10, migration 017).
describe("migration 036 is a single-connection rebuild", () => {
  it("issues the rebuild through executeMultiple, not statement by statement", async () => {
    const scripts: string[] = [];
    const statements: string[] = [];
    const fake = {
      async execute(stmt: unknown) {
        const sql = typeof stmt === "string" ? stmt : (stmt as { sql: string }).sql;
        statements.push(sql);
        return { rows: [] };
      },
      async executeMultiple(script: string) {
        scripts.push(script);
      },
    };
    await runMigration036(fake as unknown as Parameters<typeof runMigration036>[0]);

    assert.equal(scripts.length, 1, "the rebuild must be exactly one script");
    const script = scripts[0];
    for (const required of [
      "PRAGMA foreign_keys = OFF",
      "CREATE TABLE sessions_new",
      "INSERT INTO sessions_new",
      "DROP TABLE sessions",
      "ALTER TABLE sessions_new RENAME TO sessions",
      "'draft'",
      "model TEXT",
      "effort TEXT",
    ]) {
      assert.ok(script.includes(required), `${required} must be inside the script`);
    }
    assert.deepEqual(statements, [], "no statement may run outside the script");
  });
});
