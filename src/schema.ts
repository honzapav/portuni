// src/schema.ts
import { getDb } from "./db.js";

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES nodes(id),
    target_id TEXT NOT NULL REFERENCES nodes(id),
    relation TEXT NOT NULL,
    meta TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    detail TEXT,
    timestamp DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`,
  `CREATE TABLE IF NOT EXISTS local_mirrors (
    user_id TEXT NOT NULL REFERENCES users(id),
    node_id TEXT NOT NULL REFERENCES nodes(id),
    local_path TEXT NOT NULL,
    registered_at DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, node_id)
  )`,
  `CREATE TABLE IF NOT EXISTS files (
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
  `CREATE INDEX IF NOT EXISTS idx_files_node ON files(node_id)`,
];

const SOLO_USER_ID = "01SOLO0000000000000000000";

const SEED = [
  `INSERT OR IGNORE INTO users (id, email, name, created_at)
   VALUES ('${SOLO_USER_ID}', 'honza@workflow.ooo', 'Honza', datetime('now'))`,
];

export const SOLO_USER = SOLO_USER_ID;

export async function ensureSchema(): Promise<void> {
  const db = getDb();
  for (const sql of [...DDL, ...SEED]) {
    await db.execute(sql);
  }
}
