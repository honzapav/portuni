// test/events.test.ts
// Integration tests for event lifecycle: log, resolve, supersede, list.
// Uses in-memory libsql (same pattern as schema-types.test.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { EventRow } from "../src/types.js";

const SOLO_USER = "U1";

async function createTestDb() {
  const db = createClient({ url: ":memory:" });

  const ddl = [
    `CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      meta TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      visibility TEXT NOT NULL DEFAULT 'team',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE events (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id),
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      meta TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      refs TEXT,
      task_ref TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX idx_events_node ON events(node_id)`,
    `CREATE INDEX idx_events_status ON events(status)`,
  ];

  for (const sql of ddl) {
    await db.execute(sql);
  }

  await db.execute({
    sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
    args: [SOLO_USER, "test@test.com", "Test"],
  });

  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, created_by) VALUES (?, ?, ?, ?)",
    args: ["N1", "project", "Test Project", SOLO_USER],
  });

  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, created_by) VALUES (?, ?, ?, ?)",
    args: ["N2", "area", "Test Area", SOLO_USER],
  });

  return db;
}

describe("Event lifecycle", () => {
  it("portuni_log inserts event with all fields correctly", async () => {
    const db = await createTestDb();
    const id = "EV001";
    const now = new Date().toISOString();
    const meta = JSON.stringify({ priority: "high", source: "manual" });
    const refs = JSON.stringify(["REF1", "REF2"]);

    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, "N1", "decision", "We decided to use TypeScript", meta, "active", refs, "TASK-42", SOLO_USER, now],
    });

    const res = await db.execute({ sql: "SELECT * FROM events WHERE id = ?", args: [id] });
    assert.equal(res.rows.length, 1);

    const row = EventRow.parse(res.rows[0]);
    assert.equal(row.id, id);
    assert.equal(row.node_id, "N1");
    assert.equal(row.type, "decision");
    assert.equal(row.content, "We decided to use TypeScript");
    assert.equal(row.status, "active");
    assert.equal(row.task_ref, "TASK-42");
    assert.equal(row.created_by, SOLO_USER);

    const parsedMeta = JSON.parse(row.meta!);
    assert.equal(parsedMeta.priority, "high");

    const parsedRefs = JSON.parse(row.refs!);
    assert.deepEqual(parsedRefs, ["REF1", "REF2"]);
  });

  it("portuni_resolve sets status to resolved and merges resolution into meta", async () => {
    const db = await createTestDb();
    const id = "EV002";
    const originalMeta = JSON.stringify({ priority: "high" });

    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, meta, status, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, "N1", "issue", "Something is broken", originalMeta, "active", SOLO_USER],
    });

    // Simulate resolve: merge resolution into meta, set status
    const existing = await db.execute({ sql: "SELECT * FROM events WHERE id = ?", args: [id] });
    const row = EventRow.parse(existing.rows[0]);
    assert.equal(row.status, "active");

    const existingMeta = row.meta ? JSON.parse(row.meta) : {};
    const mergedMeta = { ...existingMeta, resolution: "Fixed the bug" };

    await db.execute({
      sql: "UPDATE events SET status = ?, meta = ? WHERE id = ?",
      args: ["resolved", JSON.stringify(mergedMeta), id],
    });

    const updated = await db.execute({ sql: "SELECT * FROM events WHERE id = ?", args: [id] });
    const updatedRow = EventRow.parse(updated.rows[0]);
    assert.equal(updatedRow.status, "resolved");

    const updatedMeta = JSON.parse(updatedRow.meta!);
    assert.equal(updatedMeta.priority, "high", "original meta key preserved");
    assert.equal(updatedMeta.resolution, "Fixed the bug", "resolution merged in");
  });

  it("portuni_supersede archives old event and creates new one with ref", async () => {
    const db = await createTestDb();
    const oldId = "EV003";
    const newId = "EV004";
    const now = new Date().toISOString();
    const oldMeta = JSON.stringify({ source: "manual" });

    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, meta, status, task_ref, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [oldId, "N1", "note", "Original content", oldMeta, "active", "TASK-10", SOLO_USER],
    });

    // Simulate supersede: mark old as superseded, create new with ref
    const oldRow = EventRow.parse(
      (await db.execute({ sql: "SELECT * FROM events WHERE id = ?", args: [oldId] })).rows[0],
    );

    await db.execute({
      sql: "UPDATE events SET status = ? WHERE id = ?",
      args: ["superseded", oldId],
    });

    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId,
        oldRow.node_id,
        oldRow.type,
        "Updated content",
        oldMeta, // preserve old meta when no new meta provided
        "active",
        JSON.stringify([oldId]),
        oldRow.task_ref,
        SOLO_USER,
        now,
      ],
    });

    // Verify old event is superseded
    const oldUpdated = EventRow.parse(
      (await db.execute({ sql: "SELECT * FROM events WHERE id = ?", args: [oldId] })).rows[0],
    );
    assert.equal(oldUpdated.status, "superseded");

    // Verify new event
    const newRow = EventRow.parse(
      (await db.execute({ sql: "SELECT * FROM events WHERE id = ?", args: [newId] })).rows[0],
    );
    assert.equal(newRow.status, "active");
    assert.equal(newRow.node_id, "N1");
    assert.equal(newRow.type, "note");
    assert.equal(newRow.content, "Updated content");
    assert.equal(newRow.task_ref, "TASK-10");
    assert.deepEqual(JSON.parse(newRow.refs!), [oldId]);
  });

  it("portuni_list_events filters by node_id and status", async () => {
    const db = await createTestDb();

    // Insert events for different nodes and statuses
    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, status, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["EV10", "N1", "note", "Active on N1", "active", SOLO_USER],
    });
    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, status, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["EV11", "N1", "issue", "Resolved on N1", "resolved", SOLO_USER],
    });
    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, status, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["EV12", "N2", "note", "Active on N2", "active", SOLO_USER],
    });

    // Filter by node_id only
    const byNode = await db.execute({
      sql: `SELECT e.*, n.name as node_name FROM events e JOIN nodes n ON e.node_id = n.id WHERE e.node_id = ? ORDER BY e.created_at DESC`,
      args: ["N1"],
    });
    assert.equal(byNode.rows.length, 2);

    // Filter by node_id and status
    const byNodeAndStatus = await db.execute({
      sql: `SELECT e.*, n.name as node_name FROM events e JOIN nodes n ON e.node_id = n.id WHERE e.node_id = ? AND e.status = ? ORDER BY e.created_at DESC`,
      args: ["N1", "active"],
    });
    assert.equal(byNodeAndStatus.rows.length, 1);
    assert.equal(byNodeAndStatus.rows[0].id, "EV10");
    assert.equal(byNodeAndStatus.rows[0].node_name, "Test Project");

    // Filter by status only
    const byStatus = await db.execute({
      sql: `SELECT e.*, n.name as node_name FROM events e JOIN nodes n ON e.node_id = n.id WHERE e.status = ? ORDER BY e.created_at DESC`,
      args: ["active"],
    });
    assert.equal(byStatus.rows.length, 2);

    // No filter -- all events
    const all = await db.execute({
      sql: `SELECT e.*, n.name as node_name FROM events e JOIN nodes n ON e.node_id = n.id ORDER BY e.created_at DESC`,
      args: [],
    });
    assert.equal(all.rows.length, 3);
  });
});
