// Postgres cutover export/import (batch B5,
// docs/superpowers/plans/2026-09-12-infra-batch.md). All three PGlite
// (in-process, no external service needed).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgliteDbClient } from "../apps/server/infra/db-pglite.js";
import { ensureSchemaOn, SOLO_USER } from "../apps/server/infra/schema.js";
import { exportDb, TABLE_ORDER } from "../apps/server/infra/db-export.js";
import { importDb } from "../apps/server/infra/db-import.js";
import type { DbClient } from "../apps/server/infra/db.js";

async function freshPgDb(): Promise<DbClient> {
  const db = createPgliteDbClient();
  await ensureSchemaOn(db);
  return db;
}

async function tmpOutDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "portuni-db-export-test-"));
}

// A representative slice of every table's own data, enough to exercise
// FK ordering (including the self-referencing session_runs case) and the
// remote_routing identity-column round trip.
async function seedRepresentativeData(db: DbClient): Promise<{ userId: string; nodeId: string }> {
  const userId = "U1";
  await db.execute({ sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)", args: [userId, "a@b.com", "A"] });
  const nodeId = "N0000000000000000000000001";
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'P1', 's1', ?)",
    args: [nodeId, userId],
  });
  await db.execute({
    sql: "INSERT INTO remotes (name, type, config_json, created_by) VALUES ('r1', 'fs', '{}', ?)",
    args: [userId],
  });
  await db.execute("INSERT INTO remote_routing (priority, node_type, org_slug, remote_name) VALUES (10, NULL, NULL, 'r1')");
  await db.execute("INSERT INTO remote_routing (priority, node_type, org_slug, remote_name) VALUES (20, NULL, NULL, 'r1')");
  const sessionId = "01SESSION00000000000000001";
  await db.execute({
    sql: "INSERT INTO sessions (id, node_id, user_id, session_type) VALUES (?, ?, ?, 'interactive_task')",
    args: [sessionId, nodeId, userId],
  });
  const run1 = "01RUN000000000000000000001";
  const run2 = "01RUN000000000000000000002";
  await db.execute({
    sql: "INSERT INTO session_runs (id, session_id, runner) VALUES (?, ?, 'claude')",
    args: [run1, sessionId],
  });
  await db.execute({
    sql: "INSERT INTO session_runs (id, session_id, runner, resumed_from_run_id) VALUES (?, ?, 'claude', ?)",
    args: [run2, sessionId, run1],
  });
  await db.execute({
    sql: "INSERT INTO session_events (id, session_id, run_id, seq, kind, payload) VALUES (?, ?, ?, 1, 'run_started', '{}')",
    args: ["01EVENT0000000000000000001", sessionId, run1],
  });
  await db.execute({
    sql: `INSERT INTO actors (id, type, name) VALUES ('01ACTOR0000000000000000001', 'person', 'Actor')`,
  });
  return { userId, nodeId };
}

describe("db-export / db-import round trip (PGlite)", () => {
  it("exports every table and the import produces an identical target (row counts + checksums)", async () => {
    const src = await freshPgDb();
    await seedRepresentativeData(src);
    const dir = await tmpOutDir();
    const manifest = await exportDb(src, dir);

    assert.deepEqual(Object.keys(manifest.tables), TABLE_ORDER);
    assert.ok(!("migrations" in manifest.tables), "migrations must not be one of the exported tables");
    assert.deepEqual(manifest.source_migrations, ["pg-001"]);

    const tgt = await freshPgDb();
    const result = await importDb(tgt, dir);
    assert.deepEqual(Object.keys(result.tables), TABLE_ORDER);

    // Re-export the target and compare checksums table by table -- the
    // definition of "the import produced an identical database".
    const dir2 = await tmpOutDir();
    const manifest2 = await exportDb(tgt, dir2);
    for (const table of TABLE_ORDER) {
      assert.equal(manifest2.tables[table].rows, manifest.tables[table].rows, `${table}: row count`);
      assert.equal(manifest2.tables[table].sha256, manifest.tables[table].sha256, `${table}: checksum`);
    }
  });

  it("preserves remote_routing's explicit ids and leaves the identity sequence usable afterward", async () => {
    const src = await freshPgDb();
    await seedRepresentativeData(src);
    const dir = await tmpOutDir();
    await exportDb(src, dir);

    const tgt = await freshPgDb();
    await importDb(tgt, dir);
    const rows = await tgt.execute("SELECT id, priority FROM remote_routing ORDER BY id");
    assert.deepEqual(
      rows.rows.map((r) => [r.id, r.priority]),
      [
        [1, 10],
        [2, 20],
      ],
    );
    const inserted = await tgt.execute(
      "INSERT INTO remote_routing (priority, node_type, org_slug, remote_name) VALUES (30, NULL, NULL, 'r1') RETURNING id",
    );
    assert.equal(inserted.rows[0].id, 3, "the sequence must continue past the highest imported id, not collide with it");
  });

  it("backfills session_runs.resumed_from_run_id (the one self-referencing FK) after every row exists", async () => {
    const src = await freshPgDb();
    await seedRepresentativeData(src);
    const dir = await tmpOutDir();
    await exportDb(src, dir);

    const tgt = await freshPgDb();
    await importDb(tgt, dir);
    const rows = await tgt.execute("SELECT id, resumed_from_run_id FROM session_runs ORDER BY id");
    assert.deepEqual(rows.rows.map((r) => r.resumed_from_run_id), [null, "01RUN000000000000000000001"]);
  });

  it("upserts the source's solo-user row instead of colliding with the target's freshly-seeded one", async () => {
    const src = await freshPgDb();
    // The source's own solo user, re-seeded by ensureSchemaOn with a
    // custom email before export -- simulates a real, lived-in database
    // rather than the bare default.
    await src.execute({
      sql: "UPDATE users SET email = ? WHERE id = ?",
      args: ["custom@example.com", SOLO_USER],
    });
    const dir = await tmpOutDir();
    await exportDb(src, dir);

    const tgt = await freshPgDb();
    await importDb(tgt, dir);
    const row = await tgt.execute({ sql: "SELECT email FROM users WHERE id = ?", args: [SOLO_USER] });
    assert.equal(row.rows.length, 1, "no duplicate/colliding solo-user row");
    assert.equal(row.rows[0].email, "custom@example.com");
  });

  it("refuses a target that already has data", async () => {
    const src = await freshPgDb();
    await seedRepresentativeData(src);
    const dir = await tmpOutDir();
    await exportDb(src, dir);

    const tgt = await freshPgDb();
    await tgt.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'Already here', 'preexisting', ?)",
      args: ["N0000000000000000000EXIST1", SOLO_USER],
    });
    await assert.rejects(importDb(tgt, dir), /already has \d+ row\(s\)/);
  });

  it("does not treat the baseline's own seeded solo user as a non-empty target", async () => {
    const src = await freshPgDb();
    await seedRepresentativeData(src);
    const dir = await tmpOutDir();
    await exportDb(src, dir);

    // A target with nothing but ensureSchemaOn's own baseline apply (which
    // always seeds exactly the solo user) must be importable.
    const tgt = await freshPgDb();
    await assert.doesNotReject(importDb(tgt, dir));
  });

  it("a table with zero rows in the source round-trips as zero rows, not a missing file crash", async () => {
    const src = await freshPgDb();
    const dir = await tmpOutDir();
    const manifest = await exportDb(src, dir);
    assert.equal(manifest.tables.sessions.rows, 0);

    const tgt = await freshPgDb();
    const result = await importDb(tgt, dir);
    assert.equal(result.tables.sessions, 0);
  });

  it("a fixture exported from the current libsql schema imports cleanly", async () => {
    // A real libsql export (createLibsqlDbClient over an ensureSchemaOn'd
    // :memory: db) is dialect-agnostic input to exportDb -- this proves the
    // export side genuinely works against libsql, not just PGlite, and that
    // its JSON output imports into a Postgres target without needing any
    // libsql-specific handling on the import side.
    const { createClient } = await import("@libsql/client");
    const { createLibsqlDbClient } = await import("../apps/server/infra/db-libsql.js");
    const libsql = createLibsqlDbClient(createClient({ url: ":memory:" }));
    await ensureSchemaOn(libsql);
    await seedRepresentativeData(libsql);

    const dir = await tmpOutDir();
    const manifest = await exportDb(libsql, dir);
    assert.equal(manifest.dialect, "sqlite");
    assert.ok(manifest.source_migrations.length > 0, "libsql migrations were recorded for reference");

    const tgt = await freshPgDb();
    const result = await importDb(tgt, dir);
    assert.equal(result.tables.nodes, 1);
    assert.equal(result.tables.remote_routing, 2);
  });

});

describe("db-import: missing/malformed export directory", () => {
  it("treats a missing table file as zero rows rather than throwing", async () => {
    const dir = await tmpOutDir();
    // Write only a subset of the table files -- simulates an export
    // directory a human partially copied.
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "nodes.json"), "[]");
    const tgt = await freshPgDb();
    const result = await importDb(tgt, dir);
    assert.equal(result.tables.users, 0);
    assert.equal(result.tables.nodes, 0);
  });
});

describe("manifest.json", () => {
  it("is written alongside the per-table files and is valid JSON", async () => {
    const src = await freshPgDb();
    await seedRepresentativeData(src);
    const dir = await tmpOutDir();
    await exportDb(src, dir);
    const raw = await readFile(join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.dialect, "postgres");
    assert.ok(Array.isArray(parsed.source_migrations));
  });
});
