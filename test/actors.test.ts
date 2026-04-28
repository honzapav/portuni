// test/actors.test.ts
// TDD tests for Task B1: 5 MCP tools for actors (person/automation) registry.
// Uses in-memory libsql + runMigration006 to exercise the real schema.
// Actors are global (cross-organizational) -- no org_id.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { runMigration006 } from "../src/infra/schema.js";
import { createActor, listActors, getActor, updateActor, archiveActor } from "../src/domain/actors.js";

async function freshEnv() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE nodes (id TEXT PRIMARY KEY CHECK(length(id)=26), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, summary TEXT, summary_updated_at DATETIME, meta TEXT, status TEXT NOT NULL DEFAULT 'active', visibility TEXT NOT NULL DEFAULT 'team', pos_x REAL, pos_y REAL, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, meta TEXT, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT, timestamp DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`INSERT INTO users (id, email, name) VALUES ('U1','t@t','T')`);
  const orgId = ulid();
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'organization', 'Workflow', 'U1')`, args: [orgId] });
  await runMigration006(db);
  return { db, orgId };
}

describe("createActor", () => {
  it("creates a real person and returns id", async () => {
    const { db } = await freshEnv();
    const res = await createActor(db, "U1", { type: "person", name: "Honza", user_id: "U1" });
    assert.ok(res.id);
    assert.equal(res.is_placeholder, 0);
  });

  it("creates a placeholder person (no user_id)", async () => {
    const { db } = await freshEnv();
    const res = await createActor(db, "U1", { type: "person", name: "Chybí nám právník", is_placeholder: true });
    assert.equal(res.is_placeholder, 1);
    assert.equal(res.user_id, null);
  });

  it("creates an automation without user_id", async () => {
    const { db } = await freshEnv();
    const res = await createActor(db, "U1", { type: "automation", name: "Stripe sync", notes: "Daily reports" });
    assert.equal(res.type, "automation");
  });

  it("rejects automation with is_placeholder=true", async () => {
    const { db } = await freshEnv();
    await assert.rejects(
      createActor(db, "U1", { type: "automation", name: "X", is_placeholder: true }),
    );
  });
});

describe("listActors", () => {
  it("filters by type", async () => {
    const { db } = await freshEnv();
    await createActor(db, "U1", { type: "person", name: "A", user_id: "U1" });
    await createActor(db, "U1", { type: "automation", name: "B" });
    const persons = await listActors(db, { type: "person" });
    assert.equal(persons.length, 1);
    assert.equal(persons[0].name, "A");
  });
});

describe("getActor, updateActor, archiveActor", () => {
  it("getActor returns null when missing", async () => {
    const { db } = await freshEnv();
    const r = await getActor(db, ulid());
    assert.equal(r, null);
  });

  it("updateActor changes name and notes", async () => {
    const { db } = await freshEnv();
    const a = await createActor(db, "U1", { type: "person", name: "A", user_id: "U1" });
    const u = await updateActor(db, "U1", { actor_id: a.id, name: "Alice", notes: "VIP" });
    assert.equal(u.name, "Alice");
    assert.equal(u.notes, "VIP");
  });

  it("archiveActor removes the row", async () => {
    const { db } = await freshEnv();
    const a = await createActor(db, "U1", { type: "person", name: "A", user_id: "U1" });
    await archiveActor(db, "U1", a.id);
    const after = await getActor(db, a.id);
    assert.equal(after, null);
  });
});
