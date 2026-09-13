// Postgres baseline (batch B2, docs/superpowers/plans/2026-09-12-infra-batch.md):
// boots a PGlite :memory: DB, applies the baseline via ensureSchemaOn, and
// checks the same class of behavior the libsql trigger tests
// (test/migration-006-invariants.test.ts, test/migration-013-sync-key.test.ts,
// test/schema-fast-path.test.ts) already cover for that dialect --
// organization invariant, per-type validation, lifecycle derivation,
// sync_key enforcement, the sessions.terminal_id index, and the files
// unique-remote-path index -- but against the real Postgres dialect
// (PGlite), not a hand-rolled pre-migration SQLite fixture.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { createPgliteDbClient } from "../apps/server/infra/db-pglite.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import type { DbClient } from "../apps/server/infra/db.js";

async function freshPgDb(): Promise<DbClient> {
  const db = createPgliteDbClient();
  await ensureSchemaOn(db);
  return db;
}

async function seedUser(db: DbClient, id = "U1"): Promise<string> {
  await db.execute({ sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)", args: [id, `${id}@t.t`, id] });
  return id;
}

async function seedNode(
  db: DbClient,
  type: string,
  userId: string,
  overrides: { id?: string; syncKey?: string } = {},
): Promise<string> {
  const id = overrides.id ?? ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [id, type, `${type}-${id}`, overrides.syncKey ?? id, userId],
  });
  return id;
}

describe("Postgres baseline (PGlite): tables", () => {
  it("creates every table the libsql fresh install has", async () => {
    const db = await freshPgDb();
    const res = await db.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    const tables = new Set(res.rows.map((r) => String(r.tablename)));
    for (const t of [
      "users",
      "nodes",
      "edges",
      "device_tokens",
      "node_access",
      "access_requests",
      "oauth_grants",
      "oauth_codes",
      "sessions",
      "session_runs",
      "session_events",
      "session_scope",
      "audit_log",
      "pending_file_ops",
      "files",
      "events",
      "migrations",
      "remotes",
      "remote_routing",
      "actors",
      "responsibilities",
      "responsibility_assignments",
      "data_sources",
      "tools",
    ]) {
      assert.ok(tables.has(t), `missing table ${t}`);
    }
  });

  it("is idempotent: a second ensureSchemaOn call does not error or re-run the baseline", async () => {
    const db = createPgliteDbClient();
    await ensureSchemaOn(db);
    await ensureSchemaOn(db);
    const res = await db.execute("SELECT id FROM migrations");
    assert.deepEqual(res.rows.map((r) => r.id), ["pg-001"]);
  });
});

describe("Postgres baseline (PGlite): organization invariant", () => {
  it("rejects a second belongs_to -> organization edge for the same node", async () => {
    const db = await freshPgDb();
    const u = await seedUser(db);
    const org1 = await seedNode(db, "organization", u);
    const org2 = await seedNode(db, "organization", u);
    const project = await seedNode(db, "project", u);
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), project, org1, u],
    });
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
        args: [ulid(), project, org2, u],
      }),
      /organization/,
    );
  });

  it("rejects removing the last belongs_to -> organization edge", async () => {
    const db = await freshPgDb();
    const u = await seedUser(db);
    const org = await seedNode(db, "organization", u);
    const project = await seedNode(db, "project", u);
    const edgeId = ulid();
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [edgeId, project, org, u],
    });
    await assert.rejects(
      db.execute({ sql: "DELETE FROM edges WHERE id = ?", args: [edgeId] }),
      /belongs_to/,
    );
  });
});

describe("Postgres baseline (PGlite): per-type validation and lifecycle", () => {
  it("rejects a responsibility attached to an organization node", async () => {
    const db = await freshPgDb();
    const u = await seedUser(db);
    const org = await seedNode(db, "organization", u);
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO responsibilities (id, node_id, title) VALUES (?, ?, 'X')",
        args: [ulid(), org],
      }),
      /project\/process\/area/,
    );
  });

  it("derives status from lifecycle_state and validates it per node type", async () => {
    const db = await freshPgDb();
    const u = await seedUser(db);
    const project = await seedNode(db, "project", u);
    await db.execute({ sql: "UPDATE nodes SET lifecycle_state = 'done' WHERE id = ?", args: [project] });
    const row = await db.execute({ sql: "SELECT status FROM nodes WHERE id = ?", args: [project] });
    assert.equal(row.rows[0].status, "completed");

    await assert.rejects(
      db.execute({ sql: "UPDATE nodes SET lifecycle_state = 'active' WHERE id = ?", args: [project] }),
      /invalid lifecycle_state/,
    );
  });
});

describe("Postgres baseline (PGlite): sync_key", () => {
  it("rejects an empty sync_key", async () => {
    const db = await freshPgDb();
    const u = await seedUser(db);
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'P', '', ?)",
        args: [ulid(), u],
      }),
      /sync_key must be a non-empty string/,
    );
  });

  it("enforces sync_key uniqueness", async () => {
    const db = await freshPgDb();
    const u = await seedUser(db);
    await seedNode(db, "project", u, { syncKey: "dup" });
    await assert.rejects(seedNode(db, "project", u, { syncKey: "dup" }));
  });
});

describe("Postgres baseline (PGlite): sessions.terminal_id index and files unique remote path", () => {
  it("has an index on sessions.terminal_id", async () => {
    const db = await freshPgDb();
    const res = await db.execute(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'sessions' AND indexname = 'idx_sessions_terminal'",
    );
    assert.equal(res.rows.length, 1);
  });

  it("rejects a second file at the same (node_id, remote_path)", async () => {
    const db = await freshPgDb();
    const u = await seedUser(db);
    const project = await seedNode(db, "project", u);
    await db.execute({
      sql: "INSERT INTO files (id, node_id, filename, remote_path, created_by) VALUES (?, ?, 'a.txt', 'wip/a.txt', ?)",
      args: ["F1", project, u],
    });
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO files (id, node_id, filename, remote_path, created_by) VALUES (?, ?, 'b.txt', 'wip/a.txt', ?)",
        args: ["F2", project, u],
      }),
    );
  });

  it("allows two files with NULL remote_path (not yet routed)", async () => {
    const db = await freshPgDb();
    const u = await seedUser(db);
    const project = await seedNode(db, "project", u);
    await db.execute({
      sql: "INSERT INTO files (id, node_id, filename, created_by) VALUES (?, ?, 'a.txt', ?)",
      args: ["F1", project, u],
    });
    await db.execute({
      sql: "INSERT INTO files (id, node_id, filename, created_by) VALUES (?, ?, 'b.txt', ?)",
      args: ["F2", project, u],
    });
    const res = await db.execute({ sql: "SELECT id FROM files WHERE node_id = ?", args: [project] });
    assert.equal(res.rows.length, 2);
  });
});

describe("Postgres baseline (PGlite): audit_log generated column", () => {
  it("derives audit_node_id from detail's JSON node_id", async () => {
    const db = await freshPgDb();
    const u = await seedUser(db);
    const project = await seedNode(db, "project", u);
    await db.execute({
      sql: "INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail) VALUES (?, ?, 'x', 'file', 'f1', ?)",
      args: ["A1", u, JSON.stringify({ node_id: project })],
    });
    const res = await db.execute({ sql: "SELECT audit_node_id FROM audit_log WHERE id = ?", args: ["A1"] });
    assert.equal(res.rows[0].audit_node_id, project);
  });
});

describe("Postgres baseline (PGlite): session_events primary key", () => {
  it("uses (session_id, seq) as the primary key, not a bare id", async () => {
    const db = await freshPgDb();
    const u = await seedUser(db);
    const project = await seedNode(db, "project", u);
    const sessionId = ulid();
    await db.execute({
      sql: "INSERT INTO sessions (id, node_id, user_id, session_type) VALUES (?, ?, ?, 'interactive_task')",
      args: [sessionId, project, u],
    });
    await db.execute({
      sql: "INSERT INTO session_events (id, session_id, seq, kind, payload) VALUES (?, ?, 1, 'run_started', '{}')",
      args: [ulid(), sessionId],
    });
    // A second row at the same (session_id, seq) violates the PK, even with
    // a different `id` -- proving `id` alone is no longer the constraint.
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO session_events (id, session_id, seq, kind, payload) VALUES (?, ?, 1, 'run_started', '{}')",
        args: [ulid(), sessionId],
      }),
    );
  });
});
