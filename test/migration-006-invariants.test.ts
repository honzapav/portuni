// test/migration-006-invariants.test.ts
// Verifies DB-level triggers installed by migration 006 actually enforce
// their invariants: automation cannot be placeholder or have user_id,
// responsibilities/data_sources/tools only on project/process/area,
// lifecycle_state per-type validation, status derivation from lifecycle_state.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { runMigration006 } from "../src/infra/schema.js";

async function freshEnv() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE nodes (id TEXT PRIMARY KEY CHECK(length(id)=26), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, summary TEXT, summary_updated_at DATETIME, meta TEXT, status TEXT NOT NULL DEFAULT 'active', visibility TEXT NOT NULL DEFAULT 'team', pos_x REAL, pos_y REAL, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES nodes(id), target_id TEXT NOT NULL REFERENCES nodes(id), relation TEXT NOT NULL, meta TEXT, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`INSERT INTO users (id, email, name) VALUES ('U1','t@t','T')`);
  const orgId = ulid();
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'organization', 'Workflow', 'U1')`, args: [orgId] });
  await runMigration006(db);
  return { db, orgId };
}

describe("actors invariants", () => {
  it("rejects automation with is_placeholder=1", async () => {
    const { db } = await freshEnv();
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO actors (id, type, name, is_placeholder) VALUES (?, 'automation', 'X', 1)`,
        args: [ulid()],
      }),
      /CHECK/,
    );
  });

  it("rejects automation with user_id set", async () => {
    const { db } = await freshEnv();
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO actors (id, type, name, user_id) VALUES (?, 'automation', 'X', 'U1')`,
        args: [ulid()],
      }),
      /CHECK/,
    );
  });

  it("accepts a person actor with placeholder=1 and user_id=null", async () => {
    const { db } = await freshEnv();
    await db.execute({
      sql: `INSERT INTO actors (id, type, name, is_placeholder) VALUES (?, 'person', 'TBD', 1)`,
      args: [ulid()],
    });
    const rows = await db.execute("SELECT COUNT(*) as c FROM actors WHERE is_placeholder = 1");
    assert.equal(rows.rows[0].c, 1);
  });
});

describe("responsibilities, data_sources, tools invariants", () => {
  it("rejects responsibility on organization node", async () => {
    const { db, orgId } = await freshEnv();
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO responsibilities (id, node_id, title) VALUES (?, ?, 'x')`,
        args: [ulid(), orgId],
      }),
      /can only attach to project\/process\/area/,
    );
  });

  it("accepts responsibility on project node", async () => {
    const { db } = await freshEnv();
    const projectId = ulid();
    await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'project', 'P', 'U1')`, args: [projectId] });
    await db.execute({
      sql: `INSERT INTO responsibilities (id, node_id, title) VALUES (?, ?, 'x')`,
      args: [ulid(), projectId],
    });
    const rows = await db.execute("SELECT COUNT(*) as c FROM responsibilities");
    assert.equal(rows.rows[0].c, 1);
  });

  it("rejects data_source on principle node", async () => {
    const { db } = await freshEnv();
    const principleId = ulid();
    await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'principle', 'P', 'U1')`, args: [principleId] });
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO data_sources (id, node_id, name) VALUES (?, ?, 'X')`,
        args: [ulid(), principleId],
      }),
      /can only attach to project\/process\/area/,
    );
  });

  it("rejects tool on organization node", async () => {
    const { db, orgId } = await freshEnv();
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO tools (id, node_id, name) VALUES (?, ?, 'X')`,
        args: [ulid(), orgId],
      }),
      /can only attach to project\/process\/area/,
    );
  });
});

describe("lifecycle_state validation and status derivation", () => {
  it("rejects invalid lifecycle for project type", async () => {
    const { db } = await freshEnv();
    const projectId = ulid();
    await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'project', 'P', 'U1')`, args: [projectId] });
    await assert.rejects(
      db.execute({ sql: `UPDATE nodes SET lifecycle_state = 'operating' WHERE id = ?`, args: [projectId] }),
      /invalid lifecycle_state/,
    );
  });

  it("rejects invalid lifecycle for area type", async () => {
    const { db } = await freshEnv();
    const areaId = ulid();
    await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'area', 'A', 'U1')`, args: [areaId] });
    await assert.rejects(
      db.execute({ sql: `UPDATE nodes SET lifecycle_state = 'in_progress' WHERE id = ?`, args: [areaId] }),
      /invalid lifecycle_state/,
    );
  });

  it("derives status=completed from lifecycle=done on project", async () => {
    const { db } = await freshEnv();
    const projectId = ulid();
    await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'project', 'P', 'U1')`, args: [projectId] });
    await db.execute({ sql: `UPDATE nodes SET lifecycle_state = 'done' WHERE id = ?`, args: [projectId] });
    const r = await db.execute({ sql: `SELECT status FROM nodes WHERE id = ?`, args: [projectId] });
    assert.equal(r.rows[0].status, "completed");
  });

  it("derives status=archived from lifecycle=retired on process", async () => {
    const { db } = await freshEnv();
    const processId = ulid();
    await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'process', 'X', 'U1')`, args: [processId] });
    await db.execute({ sql: `UPDATE nodes SET lifecycle_state = 'retired' WHERE id = ?`, args: [processId] });
    const r = await db.execute({ sql: `SELECT status FROM nodes WHERE id = ?`, args: [processId] });
    assert.equal(r.rows[0].status, "archived");
  });

  it("derives status=active from lifecycle=operating on process", async () => {
    const { db } = await freshEnv();
    const processId = ulid();
    await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'process', 'X', 'U1')`, args: [processId] });
    await db.execute({ sql: `UPDATE nodes SET lifecycle_state = 'operating' WHERE id = ?`, args: [processId] });
    const r = await db.execute({ sql: `SELECT status FROM nodes WHERE id = ?`, args: [processId] });
    assert.equal(r.rows[0].status, "active");
  });
});
