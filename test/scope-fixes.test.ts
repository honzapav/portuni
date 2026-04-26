// Regression tests for the post-review scope fixes:
//   - decideGlobalQuery: strict refuses, balanced first-time refuses,
//     permissive auto-allows.
//   - violatesHardFloor matches what decideRead's hard-floor branch checks.
//   - guardNodeRead: returns elicit/allow with audit + auto-add.
//   - loadNodeScopeMeta: pulls visibility / owner.user_id / scope_sensitive.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import {
  SessionScope,
  decideGlobalQuery,
  guardNodeRead,
  loadNodeScopeMeta,
  violatesHardFloor,
} from "../src/scope.js";

async function freshDb() {
  const db = createClient({ url: ":memory:" });
  await db.execute(
    `CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, owner_id TEXT, visibility TEXT NOT NULL DEFAULT 'team', meta TEXT)`,
  );
  await db.execute(
    `CREATE TABLE actors (id TEXT PRIMARY KEY, type TEXT, name TEXT, user_id TEXT, is_placeholder INTEGER DEFAULT 0)`,
  );
  return db;
}

describe("decideGlobalQuery", () => {
  it("strict always elicits", () => {
    const s = new SessionScope("strict");
    s.add("X");
    assert.equal(decideGlobalQuery(s).kind, "elicit");
  });
  it("balanced elicits first time, allows after globalQuerySeen flips", () => {
    const s = new SessionScope("balanced");
    assert.equal(decideGlobalQuery(s).kind, "elicit");
    s.globalQuerySeen = true;
    assert.equal(decideGlobalQuery(s).kind, "allow");
  });
  it("permissive auto-allows", () => {
    const s = new SessionScope("permissive");
    assert.equal(decideGlobalQuery(s).kind, "allow");
  });
});

describe("violatesHardFloor", () => {
  it("flags scope_sensitive=true", () => {
    assert.equal(
      violatesHardFloor(
        { exists: true, visibility: "team", ownerUserId: null, scopeSensitive: true },
        "U1",
      ),
      true,
    );
  });
  it("flags private owned by another user", () => {
    assert.equal(
      violatesHardFloor(
        { exists: true, visibility: "private", ownerUserId: "U_OTHER", scopeSensitive: false },
        "U_SELF",
      ),
      true,
    );
  });
  it("does not flag private owned by self", () => {
    assert.equal(
      violatesHardFloor(
        { exists: true, visibility: "private", ownerUserId: "U_SELF", scopeSensitive: false },
        "U_SELF",
      ),
      false,
    );
  });
  it("does not flag team visibility", () => {
    assert.equal(
      violatesHardFloor(
        { exists: true, visibility: "team", ownerUserId: "U_OTHER", scopeSensitive: false },
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

  it("resolves owner -> actor.user_id and scope_sensitive flag", async () => {
    const db = await freshDb();
    await db.execute(
      `INSERT INTO actors (id, type, name, user_id) VALUES ('A1','person','Honza','U1')`,
    );
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, owner_id, visibility, meta) VALUES (?,?,?,?,?,?)`,
      args: ["N1", "project", "P", "A1", "private", JSON.stringify({ scope_sensitive: true })],
    });
    const m = await loadNodeScopeMeta(db, "N1");
    assert.equal(m.exists, true);
    assert.equal(m.visibility, "private");
    assert.equal(m.ownerUserId, "U1");
    assert.equal(m.scopeSensitive, true);
  });

  it("tolerates malformed meta JSON", async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, owner_id, visibility, meta) VALUES (?,?,?,?,?,?)`,
      args: ["N1", "project", "P", null, "team", "{not json"],
    });
    const m = await loadNodeScopeMeta(db, "N1");
    assert.equal(m.exists, true);
    assert.equal(m.scopeSensitive, false);
  });
});

describe("guardNodeRead", () => {
  it("returns not_found for missing node", async () => {
    const db = await freshDb();
    const scope = new SessionScope("strict");
    let audited = 0;
    const r = await guardNodeRead(db, scope, "MISSING", "U1", async () => {
      audited++;
    });
    assert.equal(r.kind, "not_found");
    assert.equal(audited, 0);
  });

  it("auto-adds and audits the new in-scope node on allow", async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, owner_id, visibility, meta) VALUES (?,?,?,?,?,?)`,
      args: ["N1", "project", "P", null, "team", null],
    });
    const scope = new SessionScope("permissive");
    let audited = 0;
    const r = await guardNodeRead(db, scope, "N1", "U1", async () => {
      audited++;
    });
    assert.equal(r.kind, "allow");
    assert.equal(scope.has("N1"), true);
    assert.equal(audited, 1);
  });

  it("elicits in strict mode for out-of-scope node", async () => {
    const db = await freshDb();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, owner_id, visibility, meta) VALUES (?,?,?,?,?,?)`,
      args: ["N1", "project", "P", null, "team", null],
    });
    const scope = new SessionScope("strict");
    let audited = 0;
    const r = await guardNodeRead(db, scope, "N1", "U1", async () => {
      audited++;
    });
    assert.equal(r.kind, "elicit");
    assert.equal(audited, 0);
    assert.equal(scope.has("N1"), false);
  });
});
