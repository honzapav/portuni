// Tests for the read-scope module: session-type derivation + pure decision
// logic + seed-from-home helper that runs against an in-memory libsql DB.
//
// Spec: docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Concepts" -- session types table).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import {
  SessionScope,
  decideRead,
  deriveSessionType,
  seedScopeFromHome,
} from "../apps/server/mcp/scope.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

function identity(overrides: Partial<RequestIdentity>): RequestIdentity {
  return {
    userId: "U1",
    email: "u1@example.com",
    name: "U1",
    globalScope: "write",
    groups: [],
    groupIds: [],
    via: "device_token",
    ...overrides,
  };
}

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

describe("deriveSessionType", () => {
  it("env: identity.via === 'env' regardless of home_node_id", () => {
    assert.equal(deriveSessionType(identity({ via: "env" }), null), "env");
    assert.equal(deriveSessionType(identity({ via: "env" }), "A"), "env");
  });

  it("interactive_chat: identity.via === 'oauth_grant'", () => {
    assert.equal(deriveSessionType(identity({ via: "oauth_grant" }), null), "interactive_chat");
    assert.equal(deriveSessionType(identity({ via: "oauth_grant" }), "A"), "interactive_chat");
  });

  it("headless: device token minted with the headless flag", () => {
    assert.equal(
      deriveSessionType(identity({ via: "device_token", headless: true }), "A"),
      "headless",
    );
  });

  it("interactive_task: default for a plain device token (with or without home_node_id)", () => {
    assert.equal(
      deriveSessionType(identity({ via: "device_token", headless: false }), "A"),
      "interactive_task",
    );
    assert.equal(
      deriveSessionType(identity({ via: "device_token" }), null),
      "interactive_task",
    );
  });

  it("headless takes precedence over a present/absent home_node_id in the derivation itself", () => {
    // Refusal for headless + no home_node_id is enforced by the transport,
    // not by deriveSessionType -- the function is a pure classification.
    assert.equal(
      deriveSessionType(identity({ via: "device_token", headless: true }), null),
      "headless",
    );
  });

  it("session_jwt (desktop UI human session) falls back to interactive_task", () => {
    assert.equal(deriveSessionType(identity({ via: "session_jwt" }), null), "interactive_task");
  });
});

describe("seedScopeFromHome", () => {
  it("seeds home + depth-1 neighbors", async () => {
    const db = await freshGraph();
    const scope = new SessionScope("interactive_task");
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
    const scope = new SessionScope("interactive_task");
    scope.add("A");
    const d = decideRead(scope, "A", { visibility: "team", creatorUserId: null, scopeSensitive: false }, "U1");
    assert.equal(d.kind, "allow");
  });
});

describe("decideRead – hard floors", () => {
  it("elicits on scope_sensitive=true regardless of session type", () => {
    for (const sessionType of ["interactive_task", "interactive_chat", "headless", "env"] as const) {
      const scope = new SessionScope(sessionType);
      const d = decideRead(scope, "X", { visibility: "team", creatorUserId: null, scopeSensitive: true }, "U1");
      assert.equal(d.kind, "elicit", `session_type=${sessionType}`);
    }
  });

  it("elicits on visibility=private owned by other user", () => {
    const scope = new SessionScope("interactive_task");
    const d = decideRead(scope, "X", { visibility: "private", creatorUserId: "U_OTHER", scopeSensitive: false }, "U_SELF");
    assert.equal(d.kind, "elicit");
  });

  it("private owned by self is not routed through the hard-floor branch (still elicits as a plain out-of-scope read)", () => {
    const scope = new SessionScope("interactive_task");
    const d = decideRead(scope, "X", { visibility: "private", creatorUserId: "U_SELF", scopeSensitive: false }, "U_SELF");
    assert.equal(d.kind, "elicit");
    assert.match(d.message ?? "", /outside the session scope/);
  });
});

describe("decideRead – out-of-scope always elicits", () => {
  it("elicits regardless of session type (modes are gone; strict is the model)", () => {
    for (const sessionType of ["interactive_task", "interactive_chat", "headless", "env"] as const) {
      const scope = new SessionScope(sessionType);
      const d = decideRead(scope, "X", { visibility: "team", creatorUserId: null, scopeSensitive: false }, "U1");
      assert.equal(d.kind, "elicit", `session_type=${sessionType}`);
    }
  });
});

describe("SessionScope.add idempotence", () => {
  it("returns true on first add, false on duplicate", () => {
    const scope = new SessionScope("interactive_task");
    assert.equal(scope.add("X"), true);
    assert.equal(scope.add("X"), false);
    assert.equal(scope.size(), 1);
  });
});

describe("SessionScope.onAdd", () => {
  it("fires a listener once per newly-added node, with the node id", () => {
    const scope = new SessionScope("interactive_task");
    const seen: string[] = [];
    scope.onAdd((id) => seen.push(id));
    assert.equal(scope.add("A"), true);
    assert.equal(scope.add("A"), false); // duplicate: no second fire
    assert.equal(scope.add("B"), true);
    assert.deepEqual(seen, ["A", "B"]);
  });

  it("supports multiple listeners", () => {
    const scope = new SessionScope("interactive_task");
    let a = 0, b = 0;
    scope.onAdd(() => a++);
    scope.onAdd(() => b++);
    scope.add("X");
    assert.equal(a, 1);
    assert.equal(b, 1);
  });

  it("never throws out of add() when a listener throws", () => {
    const scope = new SessionScope("interactive_task");
    scope.onAdd(() => { throw new Error("boom"); });
    assert.doesNotThrow(() => scope.add("X"));
    assert.equal(scope.has("X"), true);
  });
});
