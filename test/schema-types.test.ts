// test/schema-types.test.ts
// Validates that DDL in schema.ts and Zod row schemas in types.ts are in sync.
// Inserts a row into each table via in-memory SQLite, then parses through Zod.
// If a column is missing or mistyped, Zod.parse() throws.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { UserRow, NodeRow, EdgeRow, AuditLogRow, LocalMirrorRow, FileRow, EventRow } from "../src/types.js";

async function createTestDb() {
  const db = createClient({ url: ":memory:" });

  // Run DDL from schema.ts (duplicated here to test against actual DDL)
  // If schema.ts DDL changes, this test must be updated -- that's the point.
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
    `CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES nodes(id),
      target_id TEXT NOT NULL REFERENCES nodes(id),
      relation TEXT NOT NULL,
      meta TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      detail TEXT,
      timestamp DATETIME NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE local_mirrors (
      user_id TEXT NOT NULL REFERENCES users(id),
      node_id TEXT NOT NULL REFERENCES nodes(id),
      local_path TEXT NOT NULL,
      registered_at DATETIME NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, node_id)
    )`,
    `CREATE TABLE files (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id),
      filename TEXT NOT NULL,
      local_path TEXT,
      status TEXT NOT NULL DEFAULT 'wip',
      description TEXT,
      mime_type TEXT,
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
  ];

  for (const sql of ddl) {
    await db.execute(sql);
  }

  // Seed a user for FK constraints
  await db.execute({
    sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
    args: ["U1", "test@test.com", "Test"],
  });

  return db;
}

describe("DDL vs Zod row schemas", () => {
  it("UserRow matches users table", async () => {
    const db = await createTestDb();
    const res = await db.execute("SELECT * FROM users WHERE id = 'U1'");
    assert.doesNotThrow(() => UserRow.parse(res.rows[0]));
  });

  it("NodeRow matches nodes table", async () => {
    const db = await createTestDb();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, created_by) VALUES (?, ?, ?, ?)",
      args: ["N1", "project", "Test Project", "U1"],
    });
    const res = await db.execute("SELECT * FROM nodes WHERE id = 'N1'");
    assert.doesNotThrow(() => NodeRow.parse(res.rows[0]));
  });

  it("EdgeRow matches edges table", async () => {
    const db = await createTestDb();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, created_by) VALUES (?, ?, ?, ?)",
      args: ["N1", "project", "A", "U1"],
    });
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, created_by) VALUES (?, ?, ?, ?)",
      args: ["N2", "area", "B", "U1"],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, ?, ?)",
      args: ["E1", "N1", "N2", "belongs_to", "U1"],
    });
    const res = await db.execute("SELECT * FROM edges WHERE id = 'E1'");
    assert.doesNotThrow(() => EdgeRow.parse(res.rows[0]));
  });

  it("AuditLogRow matches audit_log table", async () => {
    const db = await createTestDb();
    await db.execute({
      sql: "INSERT INTO audit_log (id, user_id, action, target_type, target_id) VALUES (?, ?, ?, ?, ?)",
      args: ["A1", "U1", "create_node", "node", "N1"],
    });
    const res = await db.execute("SELECT * FROM audit_log WHERE id = 'A1'");
    assert.doesNotThrow(() => AuditLogRow.parse(res.rows[0]));
  });

  it("LocalMirrorRow matches local_mirrors table", async () => {
    const db = await createTestDb();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, created_by) VALUES (?, ?, ?, ?)",
      args: ["N1", "project", "Test", "U1"],
    });
    await db.execute({
      sql: "INSERT INTO local_mirrors (user_id, node_id, local_path) VALUES (?, ?, ?)",
      args: ["U1", "N1", "/tmp/test"],
    });
    const res = await db.execute("SELECT * FROM local_mirrors WHERE user_id = 'U1' AND node_id = 'N1'");
    assert.doesNotThrow(() => LocalMirrorRow.parse(res.rows[0]));
  });

  it("FileRow matches files table", async () => {
    const db = await createTestDb();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, created_by) VALUES (?, ?, ?, ?)",
      args: ["N1", "project", "Test", "U1"],
    });
    await db.execute({
      sql: "INSERT INTO files (id, node_id, filename, created_by) VALUES (?, ?, ?, ?)",
      args: ["F1", "N1", "test.md", "U1"],
    });
    const res = await db.execute("SELECT * FROM files WHERE id = 'F1'");
    assert.doesNotThrow(() => FileRow.parse(res.rows[0]));
  });

  it("EventRow matches events table", async () => {
    const db = await createTestDb();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, created_by) VALUES (?, ?, ?, ?)",
      args: ["N1", "project", "Test", "U1"],
    });
    await db.execute({
      sql: "INSERT INTO events (id, node_id, type, content, created_by) VALUES (?, ?, ?, ?, ?)",
      args: ["EV1", "N1", "note", "Something happened", "U1"],
    });
    const res = await db.execute("SELECT * FROM events WHERE id = 'EV1'");
    assert.doesNotThrow(() => EventRow.parse(res.rows[0]));
  });
});
