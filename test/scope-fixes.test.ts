// Regression tests for the scope-decision helpers:
//   - violatesHardFloor matches what decideRead's hard-floor branch checks.
//   - guardNodeRead: returns elicit/allow with audit + auto-add.
//   - loadNodeScopeMeta: pulls visibility / created_by / scope_sensitive.
// (decideGlobalQuery is gone -- search and global list_nodes are
// permission-only now, see docs/superpowers/specs/
// 2026-08-31-scope-sessions-redesign-design.md, "Search is discovery, not
// ingestion".)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import {
  SessionScope,
  guardNodeRead,
  isEdgeReachable,
  loadNodeScopeMeta,
  violatesHardFloor,
} from "../apps/server/mcp/scope.js";

async function freshDb() {
  const db = createClient({ url: ":memory:" });
  await db.execute(
    `CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, owner_id TEXT, created_by TEXT, visibility TEXT NOT NULL DEFAULT 'team', meta TEXT)`,
  );
  await db.execute(
    `CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT, target_id TEXT, relation TEXT)`,
  );
  await db.execute(
    `CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, timestamp TEXT)`,
  );
  return db;
}

describe("violatesHardFloor", () => {
  it("flags scope_sensitive=true", () => {
    assert.equal(
      violatesHardFloor(
        { exists: true, visibility: "team", creatorUserId: null, scopeSensitive: true },
        "U1",
      ),
      true,
    );
  });
  it("flags private owned by another user", () => {
    assert.equal(
      violatesHardFloor(
        { exists: true, visibility: "private", creatorUserId: "U_OTHER", scopeSensitive: false },
        "U_SELF",
      ),
      true,
    );
  });
  it("does not flag private owned by self", () => {
    assert.equal(
      violatesHardFloor(
        { exists: true, visibility: "private", creatorUserId: "U_SELF", scopeSensitive: false },
        "U_SELF",
      ),
      false,
    );
  });
  it("does not flag team visibility", () => {
    assert.equal(
      violatesHardFloor(
        { exists: true, visibility: "team", creatorUserId: "U_OTHER", scopeSensitive: false },
        "U_SELF",
      ),
      false,
    );
  });
});

describe("loadNodeScopeMeta", () => {
  it("returns exists=false for missing node", async () => {
    const db = await freshDb();
    const m = await loadNodeScopeMeta(db, "MISSING");
    assert.equal(m.exists, false);
  });

  it("reads created_by as the creator and the scope_sensitive flag", async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, owner_id, created_by, visibility, meta) VALUES (?,?,?,?,?,?,?)`,
      args: ["N1", "project", "P", null, "U1", "private", JSON.stringify({ scope_sensitive: true })],
    });
    const m = await loadNodeScopeMeta(db, "N1");
    assert.equal(m.exists, true);
    assert.equal(m.visibility, "private");
    assert.equal(m.creatorUserId, "U1");
    assert.equal(m.scopeSensitive, true);
  });

  it("tolerates malformed meta JSON", async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, owner_id, created_by, visibility, meta) VALUES (?,?,?,?,?,?,?)`,
      args: ["N1", "project", "P", null, "U1", "team", "{not json"],
    });
    const m = await loadNodeScopeMeta(db, "N1");
    assert.equal(m.exists, true);
    assert.equal(m.scopeSensitive, false);
  });
});

describe("guardNodeRead", () => {
  it("returns not_found for missing node", async () => {
    const db = await freshDb();
    const scope = new SessionScope("interactive_task");
    const r = await guardNodeRead(db, scope, "MISSING", "U1");
    assert.equal(r.kind, "not_found");
  });

  it("allow for a node already in scope", async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, owner_id, created_by, visibility, meta) VALUES (?,?,?,?,?,?,?)`,
      args: ["N1", "project", "P", null, "U1", "team", null],
    });
    const scope = new SessionScope("interactive_task");
    scope.add("N1"); // already in scope: allow without an elicit round-trip
    const r = await guardNodeRead(db, scope, "N1", "U1");
    assert.equal(r.kind, "allow");
    assert.equal(scope.has("N1"), true);
  });

  it("elicits for a disconnected out-of-scope node (no edge to anything in scope)", async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, owner_id, created_by, visibility, meta) VALUES (?,?,?,?,?,?,?)`,
      args: ["N1", "project", "P", null, "U1", "team", null],
    });
    const scope = new SessionScope("interactive_task");
    const r = await guardNodeRead(db, scope, "N1", "U1");
    assert.equal(r.kind, "elicit");
    assert.equal(scope.has("N1"), false);
  });

  it("auto-expands an edge-reachable out-of-scope node without an elicit round-trip", async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, owner_id, created_by, visibility, meta) VALUES (?,?,?,?,?,?,?)`,
      args: ["N1", "project", "P", null, "U1", "team", null],
    });
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, owner_id, created_by, visibility, meta) VALUES (?,?,?,?,?,?,?)`,
      args: ["N2", "project", "Q", null, "U1", "team", null],
    });
    await db.execute({
      sql: `INSERT INTO edges (id, source_id, target_id, relation) VALUES (?,?,?,?)`,
      args: ["e1", "N1", "N2", "related_to"],
    });
    const scope = new SessionScope("interactive_task");
    scope.add("N1");
    const r = await guardNodeRead(db, scope, "N2", "U1");
    assert.equal(r.kind, "allow");
    assert.equal(scope.has("N2"), true, "reachable node is added to scope as a side effect");
    const expansions = scope.expansions();
    assert.equal(expansions.length, 1);
    assert.equal(expansions[0].addedVia, "edge");
  });

  it("refuses (not elicits) a headless session hitting a hard floor", async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, owner_id, created_by, visibility, meta) VALUES (?,?,?,?,?,?,?)`,
      args: ["N1", "project", "P", null, "U_OTHER", "private", null],
    });
    const scope = new SessionScope("headless");
    const r = await guardNodeRead(db, scope, "N1", "U_SELF");
    assert.equal(r.kind, "refused");
    assert.equal(scope.has("N1"), false);
  });
});

describe("isEdgeReachable", () => {
  it("false when the scope set is empty", async () => {
    const db = await freshDb();
    const scope = new SessionScope("interactive_task");
    assert.equal(await isEdgeReachable(db, scope, "N1"), false);
  });

  it("true when the target shares an edge with an in-scope node", async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO edges (id, source_id, target_id, relation) VALUES (?,?,?,?)`,
      args: ["e1", "A", "B", "related_to"],
    });
    const scope = new SessionScope("interactive_task");
    scope.add("A");
    assert.equal(await isEdgeReachable(db, scope, "B"), true);
  });

  it("false for a node two hops away with nothing in between in scope", async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO edges (id, source_id, target_id, relation) VALUES (?,?,?,?)`,
      args: ["e1", "A", "B", "related_to"],
    });
    await db.execute({
      sql: `INSERT INTO edges (id, source_id, target_id, relation) VALUES (?,?,?,?)`,
      args: ["e2", "B", "C", "related_to"],
    });
    const scope = new SessionScope("interactive_task");
    scope.add("A");
    assert.equal(await isEdgeReachable(db, scope, "C"), false);
  });
});
