import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { runMigration006 } from "../src/schema.js";
import {
  addDataSource, removeDataSource, listDataSources,
  addTool, removeTool, listTools,
} from "../src/tools/entity-attributes.js";

async function freshEnv() {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, created_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE nodes (id TEXT PRIMARY KEY CHECK(length(id)=26), type TEXT NOT NULL, name TEXT NOT NULL, description TEXT, summary TEXT, summary_updated_at DATETIME, meta TEXT, status TEXT NOT NULL DEFAULT 'active', visibility TEXT NOT NULL DEFAULT 'team', pos_x REAL, pos_y REAL, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT, timestamp DATETIME DEFAULT (datetime('now')))`);
  await db.execute(`INSERT INTO users (id, email, name) VALUES ('U1','t@t','T')`);
  const orgId = ulid();
  const projectId = ulid();
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'organization', 'W', 'U1')`, args: [orgId] });
  await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'project', 'P', 'U1')`, args: [projectId] });
  await runMigration006(db);
  return { db, orgId, projectId };
}

describe("data_sources CRUD", () => {
  it("adds, lists, removes", async () => {
    const { db, projectId } = await freshEnv();
    const ds = await addDataSource(db, "U1", { node_id: projectId, name: "CRM Airtable", external_link: "https://airtable.com/xxx" });
    const list = await listDataSources(db, projectId);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "CRM Airtable");

    await removeDataSource(db, "U1", ds.id);
    const afterRemove = await listDataSources(db, projectId);
    assert.equal(afterRemove.length, 0);
  });

  it("rejects adding data_source to organization node", async () => {
    const { db, orgId } = await freshEnv();
    await assert.rejects(
      addDataSource(db, "U1", { node_id: orgId, name: "X" }),
      /can only attach to project\/process\/area/,
    );
  });

  it("rejects adding data_source to principle node", async () => {
    const { db } = await freshEnv();
    const principleId = ulid();
    await db.execute({ sql: `INSERT INTO nodes (id, type, name, created_by) VALUES (?, 'principle', 'Pr', 'U1')`, args: [principleId] });
    await assert.rejects(
      addDataSource(db, "U1", { node_id: principleId, name: "X" }),
      /can only attach to project\/process\/area/,
    );
  });
});

describe("tools CRUD", () => {
  it("adds, lists, removes a tool", async () => {
    const { db, projectId } = await freshEnv();
    const t = await addTool(db, "U1", { node_id: projectId, name: "Asana", external_link: "https://asana.com/..." });
    const list = await listTools(db, projectId);
    assert.equal(list.length, 1);
    await removeTool(db, "U1", t.id);
    const after = await listTools(db, projectId);
    assert.equal(after.length, 0);
  });

  it("stores description and external_link", async () => {
    const { db, projectId } = await freshEnv();
    const t = await addTool(db, "U1", { node_id: projectId, name: "N", description: "D", external_link: "https://x" });
    assert.equal(t.description, "D");
    assert.equal(t.external_link, "https://x");
  });
});
