// src/schema.ts
import { getDb } from "./db.js";

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS nodes (
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
  `CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES nodes(id),
    target_id TEXT NOT NULL REFERENCES nodes(id),
    relation TEXT NOT NULL,
    meta TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique ON edges(source_id, target_id, relation)`,
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
  `CREATE TABLE IF NOT EXISTS events (
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
  `CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)`,
];

const SOLO_USER_ID = "01SOLO0000000000000000000";

const soloEmail = process.env.PORTUNI_USER_EMAIL ?? "solo@localhost";
const soloName = process.env.PORTUNI_USER_NAME ?? "Solo User";

const SEED = [
  `INSERT OR IGNORE INTO users (id, email, name, created_at)
   VALUES ('${SOLO_USER_ID}', '${soloEmail}', '${soloName}', datetime('now'))`,
];

export const SOLO_USER = SOLO_USER_ID;

export async function ensureSchema(): Promise<void> {
  const db = getDb();
  for (const sql of [...DDL, ...SEED]) {
    await db.execute(sql);
  }
}
