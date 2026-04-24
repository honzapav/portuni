// test/schema-types.test.ts
// Validates that DDL in schema.ts and Zod row schemas in types.ts are in sync.
// Inserts a row into each table via in-memory SQLite, then parses through Zod.
// If a column is missing or mistyped, Zod.parse() throws.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { UserRow, NodeRow, EdgeRow, AuditLogRow, LocalMirrorRow, FileRow, EventRow } from "../src/types.js";
import { ulid } from "ulid";

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
      id TEXT PRIMARY KEY CHECK(length(id) = 26),
      type TEXT NOT NULL CHECK(type IN ('organization','project','process','area','principle')),
      name TEXT NOT NULL,
      description TEXT,
      summary TEXT,
      summary_updated_at DATETIME,
      meta TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','archived')),
      visibility TEXT NOT NULL DEFAULT 'team' CHECK(visibility IN ('team','private')),
      pos_x REAL,
      pos_y REAL,
      owner_id TEXT,
      lifecycle_state TEXT,
      goal TEXT,
      sync_key TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
      CHECK(updated_at >= created_at)
    )`,
    `CREATE TABLE edges (
      id TEXT PRIMARY KEY CHECK(length(id) = 26),
      source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      relation TEXT NOT NULL CHECK(relation IN ('related_to','belongs_to','applies','informed_by')),
      meta TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      CHECK(source_id != target_id)
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
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      local_path TEXT NOT NULL,
      registered_at DATETIME NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, node_id)
    )`,
    `CREATE TABLE files (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      local_path TEXT,
      status TEXT NOT NULL DEFAULT 'wip' CHECK(status IN ('wip','output')),
      description TEXT,
      mime_type TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE events (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('decision','discovery','blocker','reference','milestone','note','change')),
      content TEXT NOT NULL,
      meta TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','resolved','superseded','archived')),
      refs TEXT CHECK(refs IS NULL OR json_valid(refs)),
      task_ref TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE migrations (
      id TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
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
    const id = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [id, "project", "Test Project", id, "U1"],
    });
    const res = await db.execute({ sql: "SELECT * FROM nodes WHERE id = ?", args: [id] });
    assert.doesNotThrow(() => NodeRow.parse(res.rows[0]));
  });

  it("EdgeRow matches edges table", async () => {
    const db = await createTestDb();
    const n1 = ulid();
    const n2 = ulid();
    const e1 = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [n1, "project", "A", n1, "U1"],
    });
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [n2, "area", "B", n2, "U1"],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [e1, n1, n2, "belongs_to", "U1"],
    });
    const res = await db.execute({ sql: "SELECT * FROM edges WHERE id = ?", args: [e1] });
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
    const n1 = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [n1, "project", "Test", n1, "U1"],
    });
    await db.execute({
      sql: "INSERT INTO local_mirrors (user_id, node_id, local_path) VALUES (?, ?, ?)",
      args: ["U1", n1, "/tmp/test"],
    });
    const res = await db.execute({
      sql: "SELECT * FROM local_mirrors WHERE user_id = 'U1' AND node_id = ?",
      args: [n1],
    });
    assert.doesNotThrow(() => LocalMirrorRow.parse(res.rows[0]));
  });

  it("FileRow matches files table", async () => {
    const db = await createTestDb();
    const n1 = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [n1, "project", "Test", n1, "U1"],
    });
    await db.execute({
      sql: "INSERT INTO files (id, node_id, filename, created_by) VALUES (?, ?, ?, ?)",
      args: ["F1", n1, "test.md", "U1"],
    });
    const res = await db.execute("SELECT * FROM files WHERE id = 'F1'");
    assert.doesNotThrow(() => FileRow.parse(res.rows[0]));
  });

  it("EventRow matches events table", async () => {
    const db = await createTestDb();
    const n1 = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [n1, "project", "Test", n1, "U1"],
    });
    await db.execute({
      sql: "INSERT INTO events (id, node_id, type, content, created_by) VALUES (?, ?, ?, ?, ?)",
      args: ["EV1", n1, "note", "Something happened", "U1"],
    });
    const res = await db.execute("SELECT * FROM events WHERE id = 'EV1'");
    assert.doesNotThrow(() => EventRow.parse(res.rows[0]));
  });

  it("nodes rejects invalid type", async () => {
    const db = await createTestDb();
    const id = ulid();
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
        args: [id, "invalid_type", "Bad", id, "U1"],
      }),
    );
  });

  it("nodes rejects invalid status", async () => {
    const db = await createTestDb();
    const id = ulid();
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO nodes (id, type, name, status, sync_key, created_by) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, "project", "Bad", "deleted", id, "U1"],
      }),
    );
  });

  it("nodes rejects non-ULID id", async () => {
    const db = await createTestDb();
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
        args: ["short", "project", "Bad", "short-key", "U1"],
      }),
    );
  });

  it("edges rejects self-loop", async () => {
    const db = await createTestDb();
    const n1 = ulid();
    const e1 = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [n1, "project", "A", n1, "U1"],
    });
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, ?, ?)",
        args: [e1, n1, n1, "related_to", "U1"],
      }),
    );
  });

  it("events rejects invalid type", async () => {
    const db = await createTestDb();
    const n1 = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [n1, "project", "Test", n1, "U1"],
    });
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO events (id, node_id, type, content, created_by) VALUES (?, ?, ?, ?, ?)",
        args: ["EV2", n1, "invalid_type", "Bad", "U1"],
      }),
    );
  });

  it("events rejects invalid refs JSON", async () => {
    const db = await createTestDb();
    const n1 = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [n1, "project", "Test", n1, "U1"],
    });
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO events (id, node_id, type, content, refs, created_by) VALUES (?, ?, ?, ?, ?, ?)",
        args: ["EV3", n1, "note", "Bad refs", "not-json", "U1"],
      }),
    );
  });

  it("files rejects invalid status", async () => {
    const db = await createTestDb();
    const n1 = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [n1, "project", "Test", n1, "U1"],
    });
    await assert.rejects(
      db.execute({
        sql: "INSERT INTO files (id, node_id, filename, status, created_by) VALUES (?, ?, ?, ?, ?)",
        args: ["F2", n1, "bad.md", "draft", "U1"],
      }),
    );
  });

  it("ON DELETE CASCADE removes edges, events, files when node is deleted", async () => {
    const db = await createTestDb();
    await db.execute("PRAGMA foreign_keys = ON");
    const n1 = ulid();
    const n2 = ulid();
    const e1 = ulid();
    // Create two nodes and an edge between them
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [n1, "organization", "Org", n1, "U1"],
    });
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [n2, "project", "Proj", n2, "U1"],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [e1, n2, n1, "belongs_to", "U1"],
    });
    await db.execute({
      sql: "INSERT INTO events (id, node_id, type, content, created_by) VALUES (?, ?, ?, ?, ?)",
      args: ["EV_C", n2, "note", "test", "U1"],
    });
    await db.execute({
      sql: "INSERT INTO files (id, node_id, filename, created_by) VALUES (?, ?, ?, ?)",
      args: ["F_C", n2, "test.md", "U1"],
    });
    await db.execute({
      sql: "INSERT INTO local_mirrors (user_id, node_id, local_path) VALUES (?, ?, ?)",
      args: ["U1", n2, "/tmp/proj"],
    });

    // Delete the project node -- cascade should remove edge, event, file, mirror
    await db.execute({ sql: "DELETE FROM nodes WHERE id = ?", args: [n2] });

    const edges = await db.execute({ sql: "SELECT id FROM edges WHERE id = ?", args: [e1] });
    assert.equal(edges.rows.length, 0, "edge should be cascade-deleted");
    const events = await db.execute("SELECT id FROM events WHERE id = 'EV_C'");
    assert.equal(events.rows.length, 0, "event should be cascade-deleted");
    const files = await db.execute("SELECT id FROM files WHERE id = 'F_C'");
    assert.equal(files.rows.length, 0, "file should be cascade-deleted");
    const mirrors = await db.execute({
      sql: "SELECT node_id FROM local_mirrors WHERE node_id = ?",
      args: [n2],
    });
    assert.equal(mirrors.rows.length, 0, "mirror should be cascade-deleted");
  });
});
