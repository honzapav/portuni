// test/node-extensions.test.ts
// Task E1: TDD tests for extending portuni_update_node with goal,
// lifecycle_state, and owner_id. Exercises the exported updateNodeInternal
// pure function against an in-memory libsql + runMigration006 schema so
// the DB triggers from Task A3 are in effect.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { runMigration006 } from "../apps/server/infra/schema.js";
import { createActor } from "../apps/server/domain/actors.js";
import { updateNodeInternal } from "../apps/server/domain/nodes.js";

async function freshEnv() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE nodes (id TEXT PRIMARY KEY CHECK(length(id)=26), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, summary TEXT, summary_updated_at DATETIME, meta TEXT, status TEXT NOT NULL DEFAULT 'active', visibility TEXT NOT NULL DEFAULT 'team', pos_x REAL, pos_y REAL, sync_key TEXT, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, meta TEXT, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT, timestamp DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE node_access (node_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('group','user')), principal TEXT NOT NULL, display_email TEXT, added_by TEXT NOT NULL, added_at DATETIME NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (node_id, kind, principal))`);
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
    const { db, projectId } = await freshEnv();
    const honza = await createActor(db, "U1", { type: "person", name: "Honza", user_id: "U1" });
    await updateNodeInternal(db, "U1", { node_id: projectId, owner_id: honza.id });
    const n = await db.execute({ sql: "SELECT owner_id FROM nodes WHERE id = ?", args: [projectId] });
    assert.equal(n.rows[0].owner_id, honza.id);
  });

  it("accepts owner_id pointing to placeholder person", async () => {
    const { db, projectId } = await freshEnv();
    const placeholder = await createActor(db, "U1", { type: "person", name: "TBD", is_placeholder: true });
    await updateNodeInternal(db, "U1", { node_id: projectId, owner_id: placeholder.id });
    const n = await db.execute({ sql: "SELECT owner_id FROM nodes WHERE id = ?", args: [projectId] });
    assert.equal(n.rows[0].owner_id, placeholder.id);
  });

  it("accepts owner_id pointing to automation", async () => {
    const { db, projectId } = await freshEnv();
    const bot = await createActor(db, "U1", { type: "automation", name: "Bot" });
    await updateNodeInternal(db, "U1", { node_id: projectId, owner_id: bot.id });
    const n = await db.execute({ sql: "SELECT owner_id FROM nodes WHERE id = ?", args: [projectId] });
    assert.equal(n.rows[0].owner_id, bot.id);
  });

  // Task 14 point 6: visibility='group' is a derived state owned by
  // PUT /nodes/:id/access -- a plain node update must not be able to set it
  // manually (that would show the "shared" UI state with no ACL behind it).
  it("rejects visibility='group' on update", async () => {
    const { db, projectId } = await freshEnv();
    await assert.rejects(
      updateNodeInternal(db, "U1", { node_id: projectId, visibility: "group" }),
      /managed via the sharing ACL/,
    );
    const n = await db.execute({ sql: "SELECT visibility FROM nodes WHERE id = ?", args: [projectId] });
    assert.equal(n.rows[0].visibility, "team", "visibility must be unaffected by the rejected update");
  });

  // Finding 3 (wave-2 final review): visibility drift under live ACL. A node
  // with node_access rows must not be able to have its visibility column
  // PATCHed to anything (not just 'group') -- that would desync the
  // indicator column from the ACL until the next PUT /nodes/:id/access call.
  describe("visibility guard when node_access rows exist", () => {
    it("rejects visibility='team' on a node that has its own node_access rows", async () => {
      const { db, projectId } = await freshEnv();
      await db.execute({
        sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
              VALUES (?, 'group', 'GID_X', 'x@x.com', 'U1')`,
        args: [projectId],
      });
      await db.execute({ sql: "UPDATE nodes SET visibility = 'group' WHERE id = ?", args: [projectId] });

      await assert.rejects(
        updateNodeInternal(db, "U1", { node_id: projectId, visibility: "team" }),
        /managed via the sharing ACL/,
      );
      const n = await db.execute({ sql: "SELECT visibility FROM nodes WHERE id = ?", args: [projectId] });
      assert.equal(n.rows[0].visibility, "group", "rejected PATCH must not mutate visibility");
    });

    it("rejects visibility='private' on a node that has its own node_access rows", async () => {
      const { db, projectId } = await freshEnv();
      await db.execute({
        sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
              VALUES (?, 'user', 'U2', NULL, 'U1')`,
        args: [projectId],
      });
      await db.execute({ sql: "UPDATE nodes SET visibility = 'group' WHERE id = ?", args: [projectId] });

      await assert.rejects(
        updateNodeInternal(db, "U1", { node_id: projectId, visibility: "private" }),
        /managed via the sharing ACL/,
      );
    });

    it("allows an update without a visibility field on a node that has node_access rows", async () => {
      const { db, projectId } = await freshEnv();
      await db.execute({
        sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
              VALUES (?, 'group', 'GID_X', 'x@x.com', 'U1')`,
        args: [projectId],
      });
      await db.execute({ sql: "UPDATE nodes SET visibility = 'group' WHERE id = ?", args: [projectId] });

      await updateNodeInternal(db, "U1", { node_id: projectId, name: "Renamed" });
      const n = await db.execute({
        sql: "SELECT name, visibility FROM nodes WHERE id = ?",
        args: [projectId],
      });
      assert.equal(n.rows[0].name, "Renamed");
      assert.equal(n.rows[0].visibility, "group", "untouched visibility column must remain as-is");
    });

    it("allows visibility='private' on a node with no node_access rows", async () => {
      const { db, projectId } = await freshEnv();
      await updateNodeInternal(db, "U1", { node_id: projectId, visibility: "private" });
      const n = await db.execute({ sql: "SELECT visibility FROM nodes WHERE id = ?", args: [projectId] });
      assert.equal(n.rows[0].visibility, "private");
    });
  });
});

describe("createNodeInternal with goal and lifecycle_state", () => {
  it("accepts goal at create time", async () => {
    const { db, orgId } = await freshEnv();
    const { createNodeInternal } = await import("../apps/server/domain/nodes.js");
    const id = await createNodeInternal(db, "U1", {
      type: "project",
      name: "Nový projekt",
      organization_id: orgId,
      goal: "Dodat ve 2 týdnech",
      lifecycle_state: "planned",
    });
    const n = await db.execute({ sql: "SELECT goal, lifecycle_state, status FROM nodes WHERE id = ?", args: [id] });
    assert.equal(n.rows[0].goal, "Dodat ve 2 týdnech");
    assert.equal(n.rows[0].lifecycle_state, "planned");
    // status is derived; 'planned' maps to 'active'
    assert.equal(n.rows[0].status, "active");
  });

  it("rejects invalid lifecycle_state at create time", async () => {
    const { db, orgId } = await freshEnv();
    const { createNodeInternal } = await import("../apps/server/domain/nodes.js");
    await assert.rejects(
      createNodeInternal(db, "U1", {
        type: "project",
        name: "X",
        organization_id: orgId,
        lifecycle_state: "operating",
      }),
      /invalid lifecycle/i,
    );
  });

  it("default lifecycle_state null when not provided", async () => {
    const { db, orgId } = await freshEnv();
    const { createNodeInternal } = await import("../apps/server/domain/nodes.js");
    const id = await createNodeInternal(db, "U1", {
      type: "project",
      name: "X",
      organization_id: orgId,
    });
    const n = await db.execute({ sql: "SELECT goal, lifecycle_state FROM nodes WHERE id = ?", args: [id] });
    assert.equal(n.rows[0].goal, null);
    assert.equal(n.rows[0].lifecycle_state, null);
  });

  // Task 14 point 6: same guard at create time -- a node cannot be born
  // with visibility='group' outside the sharing ACL flow either.
  it("rejects visibility='group' at create time", async () => {
    const { db, orgId } = await freshEnv();
    const { createNodeInternal } = await import("../apps/server/domain/nodes.js");
    await assert.rejects(
      createNodeInternal(db, "U1", {
        type: "project",
        name: "X",
        organization_id: orgId,
        visibility: "group",
      }),
      /managed via the sharing ACL/,
    );
  });
});
