// Tests for the read-scope module: pure decision logic + seed-from-home
// helper that runs against an in-memory libsql DB.
//
// Spec: docs/superpowers/specs/2026-04-24-scope-model.md (Phase A).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import {
  SessionScope,
  decideRead,
  parseScopeMode,
  seedScopeFromHome,
} from "../src/mcp/scope.js";

async function freshGraph() {
  const db = createClient({ url: ":memory:" });
  await db.execute(
    `CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, owner_id TEXT, visibility TEXT, meta TEXT)`,
  );
  await db.execute(
    `CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT, target_id TEXT, relation TEXT)`,
  );

  // Three nodes: A (home), B (neighbor), C (far)
  await db.execute(`INSERT INTO nodes VALUES ('A','project','A',NULL,'team',NULL)`);
  await db.execute(`INSERT INTO nodes VALUES ('B','process','B',NULL,'team',NULL)`);
  await db.execute(`INSERT INTO nodes VALUES ('C','area','C',NULL,'team',NULL)`);
  // A -- belongs_to --> ORG, B is sibling of A via related_to
  await db.execute(`INSERT INTO nodes VALUES ('ORG','organization','Org',NULL,'team',NULL)`);
  await db.execute(`INSERT INTO edges VALUES ('e1','A','ORG','belongs_to')`);
  await db.execute(`INSERT INTO edges VALUES ('e2','B','ORG','belongs_to')`);
  await db.execute(`INSERT INTO edges VALUES ('e3','A','B','related_to')`);
  // C is farther: only connects to ORG
  await db.execute(`INSERT INTO edges VALUES ('e4','C','ORG','belongs_to')`);
  return db;
}

describe("parseScopeMode", () => {
  it("defaults to strict on missing/unknown", () => {
    assert.equal(parseScopeMode(undefined), "strict");
    assert.equal(parseScopeMode(""), "strict");
    assert.equal(parseScopeMode("foo"), "strict");
  });
  it("recognises the three modes case-insensitively", () => {
    assert.equal(parseScopeMode("strict"), "strict");
    assert.equal(parseScopeMode("BALANCED"), "balanced");
    assert.equal(parseScopeMode("Permissive"), "permissive");
  });
});

describe("seedScopeFromHome", () => {
  it("seeds home + depth-1 neighbors", async () => {
    const db = await freshGraph();
    const scope = new SessionScope("strict");
    const seeded = await seedScopeFromHome(db, scope, "A");
    // A + ORG (via belongs_to) + B (via related_to)
    assert.equal(scope.has("A"), true);
    assert.equal(scope.has("ORG"), true);
    assert.equal(scope.has("B"), true);
    // C is not a depth-1 neighbor of A
    assert.equal(scope.has("C"), false);
    assert.equal(scope.homeNodeId, "A");
    assert.deepEqual(seeded.sort(), ["A", "B", "ORG"].sort());
  });
});

describe("decideRead – allow when in scope", () => {
  it("returns allow for in-scope nodes", () => {
    const scope = new SessionScope("strict");
    scope.add("A");
    const d = decideRead(scope, "A", { visibility: "team", ownerUserId: null, scopeSensitive: false }, "U1");
    assert.equal(d.kind, "allow");
  });
});

describe("decideRead – hard floors", () => {
  it("elicits on scope_sensitive=true regardless of mode", () => {
    for (const mode of ["strict", "balanced", "permissive"] as const) {
      const scope = new SessionScope(mode);
      const d = decideRead(scope, "X", { visibility: "team", ownerUserId: null, scopeSensitive: true }, "U1");
      assert.equal(d.kind, "elicit", `mode=${mode}`);
    }
  });

  it("elicits on visibility=private owned by other user", () => {
    const scope = new SessionScope("permissive");
    const d = decideRead(scope, "X", { visibility: "private", ownerUserId: "U_OTHER", scopeSensitive: false }, "U_SELF");
    assert.equal(d.kind, "elicit");
  });

  it("does NOT elicit on visibility=private owned by self", () => {
    const scope = new SessionScope("permissive");
    const d = decideRead(scope, "X", { visibility: "private", ownerUserId: "U_SELF", scopeSensitive: false }, "U_SELF");
    assert.equal(d.kind, "allow");
  });
});

describe("decideRead – mode behaviour", () => {
  it("strict elicits on out-of-scope", () => {
    const scope = new SessionScope("strict");
    const d = decideRead(scope, "X", { visibility: "team", ownerUserId: null, scopeSensitive: false }, "U1");
    assert.equal(d.kind, "elicit");
  });

  it("balanced elicits first time, allows after agent expansion seen", () => {
    const scope = new SessionScope("balanced");
    const meta = { visibility: "team", ownerUserId: null, scopeSensitive: false };
    let d = decideRead(scope, "X", meta, "U1");
    assert.equal(d.kind, "elicit");
    // Simulate agent-initiated expansion (the user confirmed).
    scope.recordExpansion({
      at: new Date().toISOString(),
      node_ids: ["X"],
      reason: "user-confirmed-in-chat",
      triggered_by: "agent",
    });
    // Don't add to scope.nodes — we want to test the seenAgentExpansion path.
    d = decideRead(scope, "X", meta, "U1");
    assert.equal(d.kind, "allow");
  });

  it("permissive auto-allows out-of-scope", () => {
    const scope = new SessionScope("permissive");
    const d = decideRead(scope, "X", { visibility: "team", ownerUserId: null, scopeSensitive: false }, "U1");
    assert.equal(d.kind, "allow");
  });
});

describe("SessionScope.add idempotence", () => {
  it("returns true on first add, false on duplicate", () => {
    const scope = new SessionScope("strict");
    assert.equal(scope.add("X"), true);
    assert.equal(scope.add("X"), false);
    assert.equal(scope.size(), 1);
  });
});
