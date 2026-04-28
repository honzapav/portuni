// test/context-extensions.test.ts
// Task E3: TDD tests for buildContextPayload -- the pure function behind
// portuni_get_context (and reused by portuni_get_node at depth 0). Exercises
// the exported function against an in-memory libsql + runMigration006 schema
// so the DB triggers are in effect.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { runMigration006 } from "../src/infra/schema.js";
import { createActor } from "../src/domain/actors.js";
import { createResponsibility } from "../src/domain/responsibilities.js";
import { addDataSource, addTool } from "../src/domain/entity-attributes.js";
import { updateNodeInternal } from "../src/domain/nodes.js";
import { buildContextPayload } from "../src/mcp/tools/context.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";

// buildContextPayload now reads mirrors from the per-device sync.db (driven
// by PORTUNI_WORKSPACE_ROOT). Set up a temp workspace per test so
// listUserMirrors does not throw.
let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-ctx-ext-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
});

afterEach(async () => {
  resetLocalDbForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

async function freshEnv() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE nodes (id TEXT PRIMARY KEY CHECK(length(id)=26), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, summary TEXT, summary_updated_at DATETIME, meta TEXT, status TEXT NOT NULL DEFAULT 'active', visibility TEXT NOT NULL DEFAULT 'team', pos_x REAL, pos_y REAL, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, meta TEXT, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE events (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, status TEXT NOT NULL DEFAULT 'active', refs TEXT, task_ref TEXT, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE files (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, filename TEXT NOT NULL, remote_name TEXT, remote_path TEXT, current_remote_hash TEXT, last_pushed_by TEXT, last_pushed_at DATETIME, is_native_format INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'wip', description TEXT, mime_type TEXT, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT, timestamp DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE local_mirrors (user_id TEXT NOT NULL, node_id TEXT NOT NULL, local_path TEXT NOT NULL, registered_at DATETIME NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, node_id))`);
  await db.execute(`INSERT INTO users (id, email, name) VALUES ('U1','t@t','T')`);
  const orgId = ulid();
  const projectId = ulid();
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'organization', 'W', 'U1')`, args: [orgId] });
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'project', 'P', 'U1')`, args: [projectId] });
  await db.execute({ sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', 'U1')`, args: [ulid(), projectId, orgId] });
  await runMigration006(db);
  return { db, orgId, projectId };
}

describe("buildContextPayload at depth 0", () => {
  it("includes owner, responsibilities, goal, lifecycle_state, data_sources, tools", async () => {
    const { db, projectId } = await freshEnv();
    const honza = await createActor(db, "U1", { type: "person", name: "Honza", user_id: "U1" });
    await updateNodeInternal(db, "U1", { node_id: projectId, owner_id: honza.id, goal: "G", lifecycle_state: "in_progress" });
    await createResponsibility(db, "U1", { node_id: projectId, title: "R1", assignees: [honza.id] });
    await createResponsibility(db, "U1", { node_id: projectId, title: "R2" });
    await addDataSource(db, "U1", { node_id: projectId, name: "CRM" });
    await addTool(db, "U1", { node_id: projectId, name: "Asana" });

    const payload = await buildContextPayload(db, projectId, 0);
    assert.equal(payload.root.goal, "G");
    assert.equal(payload.root.lifecycle_state, "in_progress");
    assert.ok(payload.root.owner);
    assert.equal(payload.root.owner!.name, "Honza");
    assert.equal(payload.root.responsibilities.length, 2);
    const r1 = payload.root.responsibilities.find(
      (r: { title: string; assignees: { name: string }[] }) => r.title === "R1",
    );
    assert.equal(r1.assignees.length, 1);
    assert.equal(r1.assignees[0].name, "Honza");
    assert.equal(payload.root.data_sources.length, 1);
    assert.equal(payload.root.tools.length, 1);
  });

  it("owner is null when no owner set", async () => {
    const { db, projectId } = await freshEnv();
    const payload = await buildContextPayload(db, projectId, 0);
    assert.equal(payload.root.owner, null);
  });

  it("empty arrays when no responsibilities/data_sources/tools", async () => {
    const { db, projectId } = await freshEnv();
    const payload = await buildContextPayload(db, projectId, 0);
    assert.deepEqual(payload.root.responsibilities, []);
    assert.deepEqual(payload.root.data_sources, []);
    assert.deepEqual(payload.root.tools, []);
  });
});
