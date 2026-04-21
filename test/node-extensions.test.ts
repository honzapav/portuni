// test/node-extensions.test.ts
// Task E1: TDD tests for extending portuni_update_node with goal,
// lifecycle_state, and owner_id. Exercises the exported updateNodeInternal
// pure function against an in-memory libsql + runMigration006 schema so
// the DB triggers from Task A3 are in effect.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { runMigration006 } from "../src/schema.js";
import { createActor } from "../src/tools/actors.js";
import { updateNodeInternal } from "../src/tools/nodes.js";

async function freshEnv() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE nodes (id TEXT PRIMARY KEY CHECK(length(id)=26), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, summary TEXT, summary_updated_at DATETIME, meta TEXT, status TEXT NOT NULL DEFAULT 'active', visibility TEXT NOT NULL DEFAULT 'team', pos_x REAL, pos_y REAL, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, meta TEXT, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT, timestamp DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`INSERT INTO users (id, email, name) VALUES ('U1','t@t','T')`);
  const orgId = ulid();
  const projectId = ulid();
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'organization', 'W', 'U1')`, args: [orgId] });
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'project', 'P', 'U1')`, args: [projectId] });
  await db.execute({ sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', 'U1')`, args: [ulid(), projectId, orgId] });
  await runMigration006(db);
  return { db, orgId, projectId };
}

describe("updateNodeInternal: goal, lifecycle_state, owner_id", () => {
  it("sets goal and lifecycle_state on a project", async () => {
    const { db, projectId } = await freshEnv();
    await updateNodeInternal(db, "U1", { node_id: projectId, goal: "Automatizovat onboarding", lifecycle_state: "in_progress" });
    const n = await db.execute({ sql: "SELECT goal, lifecycle_state, status FROM nodes WHERE id = ?", args: [projectId] });
    assert.equal(n.rows[0].goal, "Automatizovat onboarding");
    assert.equal(n.rows[0].lifecycle_state, "in_progress");
    assert.equal(n.rows[0].status, "active");
  });

  it("derives status=archived when lifecycle_state set to cancelled", async () => {
    const { db, projectId } = await freshEnv();
    await updateNodeInternal(db, "U1", { node_id: projectId, lifecycle_state: "cancelled" });
    const n = await db.execute({ sql: "SELECT status FROM nodes WHERE id = ?", args: [projectId] });
    assert.equal(n.rows[0].status, "archived");
  });

  it("rejects invalid lifecycle for node type", async () => {
    const { db, projectId } = await freshEnv();
    await assert.rejects(
      updateNodeInternal(db, "U1", { node_id: projectId, lifecycle_state: "operating" }),
      /invalid lifecycle/i,
    );
  });

  it("sets owner_id to a real registered person", async () => {
    const { db, orgId, projectId } = await freshEnv();
    const honza = await createActor(db, "U1", { org_id: orgId, type: "person", name: "Honza", user_id: "U1" });
    await updateNodeInternal(db, "U1", { node_id: projectId, owner_id: honza.id });
    const n = await db.execute({ sql: "SELECT owner_id FROM nodes WHERE id = ?", args: [projectId] });
    assert.equal(n.rows[0].owner_id, honza.id);
  });

  it("rejects owner_id pointing to placeholder actor", async () => {
    const { db, orgId, projectId } = await freshEnv();
    const placeholder = await createActor(db, "U1", { org_id: orgId, type: "person", name: "TBD", is_placeholder: true });
    await assert.rejects(
      updateNodeInternal(db, "U1", { node_id: projectId, owner_id: placeholder.id }),
      /owner_id must reference/,
    );
  });

  it("rejects owner_id pointing to automation", async () => {
    const { db, orgId, projectId } = await freshEnv();
    const bot = await createActor(db, "U1", { org_id: orgId, type: "automation", name: "Bot" });
    await assert.rejects(
      updateNodeInternal(db, "U1", { node_id: projectId, owner_id: bot.id }),
      /owner_id must reference/,
    );
  });
});
