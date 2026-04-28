// test/responsibilities.test.ts
// TDD tests for Task C1: 6 MCP tools for responsibilities and M:N
// assignments. Uses in-memory libsql + runMigration006 just like actors.test.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { runMigration006 } from "../src/infra/schema.js";
import { createActor } from "../src/domain/actors.js";
import {
  createResponsibility,
  listResponsibilities,
  assignResponsibility,
  unassignResponsibility,
  updateResponsibility,
  deleteResponsibility,
} from "../src/domain/responsibilities.js";

async function freshEnv() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE nodes (id TEXT PRIMARY KEY CHECK(length(id)=26), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, summary TEXT, summary_updated_at DATETIME, meta TEXT, status TEXT NOT NULL DEFAULT 'active', visibility TEXT NOT NULL DEFAULT 'team', pos_x REAL, pos_y REAL, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, meta TEXT, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT, timestamp DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`INSERT INTO users (id, email, name) VALUES ('U1','t@t','T')`);
  const orgId = ulid();
  const projectId = ulid();
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'organization', 'Workflow', 'U1')`, args: [orgId] });
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'project', 'ADAMAI', 'U1')`, args: [projectId] });
  await runMigration006(db);
  return { db, orgId, projectId };
}

describe("createResponsibility", () => {
  it("creates on project with no assignees", async () => {
    const { db, projectId } = await freshEnv();
    const r = await createResponsibility(db, "U1", { node_id: projectId, title: "Review kódu" });
    assert.equal(r.title, "Review kódu");
    assert.equal(r.sort_order, 0);
  });

  it("creates with initial assignees", async () => {
    const { db, projectId } = await freshEnv();
    const eva = await createActor(db, "U1", { type: "person", name: "Eva", user_id: "U1" });
    const _r = await createResponsibility(db, "U1", { node_id: projectId, title: "X", assignees: [eva.id] });
    const list = await listResponsibilities(db, { node_id: projectId });
    assert.equal(list[0].assignees.length, 1);
    assert.equal(list[0].assignees[0].id, eva.id);
  });
});

describe("assign / unassign", () => {
  it("is idempotent", async () => {
    const { db, projectId } = await freshEnv();
    const eva = await createActor(db, "U1", { type: "person", name: "Eva", user_id: "U1" });
    const r = await createResponsibility(db, "U1", { node_id: projectId, title: "X" });
    await assignResponsibility(db, "U1", { responsibility_id: r.id, actor_id: eva.id });
    await assignResponsibility(db, "U1", { responsibility_id: r.id, actor_id: eva.id }); // idempotent
    const list = await listResponsibilities(db, { node_id: projectId });
    assert.equal(list[0].assignees.length, 1);

    await unassignResponsibility(db, "U1", { responsibility_id: r.id, actor_id: eva.id });
    const after = await listResponsibilities(db, { node_id: projectId });
    assert.equal(after[0].assignees.length, 0);
  });
});

describe("updateResponsibility and deleteResponsibility", () => {
  it("updates title", async () => {
    const { db, projectId } = await freshEnv();
    const r = await createResponsibility(db, "U1", { node_id: projectId, title: "Old" });
    const updated = await updateResponsibility(db, "U1", { responsibility_id: r.id, title: "New" });
    assert.equal(updated.title, "New");
  });

  it("clears description when null is passed", async () => {
    const { db, projectId } = await freshEnv();
    const r = await createResponsibility(db, "U1", {
      node_id: projectId,
      title: "X",
      description: "old detail",
    });
    assert.equal(r.description, "old detail");
    const updated = await updateResponsibility(db, "U1", {
      responsibility_id: r.id,
      description: null,
    });
    assert.equal(updated.description, null);
  });

  it("deletes and cascades assignments", async () => {
    const { db, projectId } = await freshEnv();
    const eva = await createActor(db, "U1", { type: "person", name: "Eva", user_id: "U1" });
    const r = await createResponsibility(db, "U1", { node_id: projectId, title: "X", assignees: [eva.id] });
    await deleteResponsibility(db, "U1", r.id);
    const rows = await db.execute({ sql: "SELECT COUNT(*) as c FROM responsibility_assignments WHERE responsibility_id = ?", args: [r.id] });
    assert.equal(rows.rows[0].c, 0);
  });
});

describe("listResponsibilities filter by actor", () => {
  it("returns responsibilities for a given actor across entities", async () => {
    const { db, projectId } = await freshEnv();
    const processId = ulid();
    await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'process', 'P2', 'U1')`, args: [processId] });

    const eva = await createActor(db, "U1", { type: "person", name: "Eva", user_id: "U1" });
    const _r1 = await createResponsibility(db, "U1", { node_id: projectId, title: "R1", assignees: [eva.id] });
    const _r2 = await createResponsibility(db, "U1", { node_id: processId, title: "R2", assignees: [eva.id] });

    const evaResps = await listResponsibilities(db, { actor_id: eva.id });
    assert.equal(evaResps.length, 2);
    const titles = evaResps.map((r) => r.title).sort();
    assert.deepEqual(titles, ["R1", "R2"]);
  });
});
