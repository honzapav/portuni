// test/move-node.test.ts
// Atomic node-to-organization move. The org-invariant triggers
// (prevent_multi_parent_org on INSERT, prevent_orphan_on_edge_delete on
// DELETE) make a naive disconnect+connect or connect+disconnect impossible.
// moveNodeToOrganization() rebinds the existing belongs_to edge in place
// via UPDATE, which fires neither trigger and keeps the invariant intact
// every step of the way.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import {
  TRIGGER_PREVENT_MULTI_PARENT_ORG,
  TRIGGER_PREVENT_ORPHAN_ON_EDGE_DELETE,
} from "../src/infra/schema.js";
import { moveNodeToOrganization, disconnectEdgeById } from "../src/domain/edges.js";

async function freshEnv() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE nodes (id TEXT PRIMARY KEY CHECK(length(id)=26), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, summary TEXT, summary_updated_at DATETIME, meta TEXT, status TEXT NOT NULL DEFAULT 'active', visibility TEXT NOT NULL DEFAULT 'team', pos_x REAL, pos_y REAL, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, meta TEXT, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT, timestamp DATETIME DEFAULT (datetime('now')))`);
  await db.execute(TRIGGER_PREVENT_MULTI_PARENT_ORG);
  await db.execute(TRIGGER_PREVENT_ORPHAN_ON_EDGE_DELETE);
  await db.execute(`INSERT INTO users (id, email, name) VALUES ('U1','t@t','T')`);

  const orgA = ulid();
  const orgB = ulid();
  const node = ulid();
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'organization', 'Org A', 'U1')`, args: [orgA] });
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'organization', 'Org B', 'U1')`, args: [orgB] });
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'project', 'Project X', 'U1')`, args: [node] });
  const edgeId = ulid();
  await db.execute({
    sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', 'U1')`,
    args: [edgeId, node, orgA],
  });
  return { db, orgA, orgB, node, edgeId };
}

describe("moveNodeToOrganization", () => {
  it("rebinds the belongs_to edge to the new org and keeps the same edge id", async () => {
    const { db, orgA, orgB, node, edgeId } = await freshEnv();
    const result = await moveNodeToOrganization(db, "U1", node, orgB);
    assert.equal(result.moved, true);
    assert.equal(result.edge_id, edgeId);
    assert.equal(result.from_org_id, orgA);
    assert.equal(result.to_org_id, orgB);
    const after = await db.execute({
      sql: `SELECT id, target_id FROM edges WHERE source_id = ? AND relation = 'belongs_to'`,
      args: [node],
    });
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].id, edgeId);
    assert.equal(after.rows[0].target_id, orgB);
  });

  it("noop when node is already in the target org", async () => {
    const { db, orgA, node, edgeId } = await freshEnv();
    const result = await moveNodeToOrganization(db, "U1", node, orgA);
    assert.equal(result.moved, false);
    assert.equal(result.edge_id, edgeId);
  });

  it("rejects moving an organization node", async () => {
    const { db, orgA, orgB } = await freshEnv();
    await assert.rejects(
      () => moveNodeToOrganization(db, "U1", orgA, orgB),
      /organizations cannot belong to another organization/,
    );
  });

  it("rejects when the target is not an organization", async () => {
    const { db, node } = await freshEnv();
    const otherProject = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'project', 'Other', 'U1')`,
      args: [otherProject],
    });
    await assert.rejects(
      () => moveNodeToOrganization(db, "U1", node, otherProject),
      /not an organization/,
    );
  });

  it("rejects when source node does not exist", async () => {
    const { db, orgB } = await freshEnv();
    await assert.rejects(
      () => moveNodeToOrganization(db, "U1", ulid(), orgB),
      /not found/,
    );
  });

  it("writes an audit log entry on a real move", async () => {
    const { db, orgA, orgB, node, edgeId } = await freshEnv();
    await moveNodeToOrganization(db, "U1", node, orgB);
    const audit = await db.execute({
      sql: `SELECT action, target_id, detail FROM audit_log WHERE action = 'move_node'`,
      args: [],
    });
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].target_id, node);
    const detail = JSON.parse(audit.rows[0].detail as string);
    assert.equal(detail.edge_id, edgeId);
    assert.equal(detail.from_org_id, orgA);
    assert.equal(detail.to_org_id, orgB);
  });

  it("does not write an audit entry on a noop move", async () => {
    const { db, orgA, node } = await freshEnv();
    await moveNodeToOrganization(db, "U1", node, orgA);
    const audit = await db.execute({
      sql: `SELECT * FROM audit_log WHERE action = 'move_node'`,
      args: [],
    });
    assert.equal(audit.rows.length, 0);
  });
});

describe("disconnectEdgeById", () => {
  it("rejects removing the only belongs_to -> organization edge with code ORG_INVARIANT", async () => {
    const { db, edgeId } = await freshEnv();
    await assert.rejects(
      () => disconnectEdgeById(db, "U1", edgeId),
      (err: Error & { code?: string }) =>
        err.code === "ORG_INVARIANT" &&
        /cannot remove the only belongs_to/.test(err.message),
    );
  });

  it("rejects unknown edge id with code EDGE_NOT_FOUND", async () => {
    const { db } = await freshEnv();
    await assert.rejects(
      () => disconnectEdgeById(db, "U1", ulid()),
      (err: Error & { code?: string }) =>
        err.code === "EDGE_NOT_FOUND" && /not found/.test(err.message),
    );
  });

  it("removes a non-invariant edge cleanly", async () => {
    const { db, node, orgA } = await freshEnv();
    const otherEdge = ulid();
    await db.execute({
      sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'related_to', 'U1')`,
      args: [otherEdge, node, orgA],
    });
    const result = await disconnectEdgeById(db, "U1", otherEdge);
    assert.equal(result.deleted, otherEdge);
    const after = await db.execute({
      sql: "SELECT id FROM edges WHERE id = ?",
      args: [otherEdge],
    });
    assert.equal(after.rows.length, 0);
  });
});
