// src/schema.ts
import type { Client } from "@libsql/client";
import { getDb } from "./db.js";
import { NODE_TYPES, EDGE_RELATIONS } from "./popp.js";

// Re-export the canonical sets so existing imports from "./schema.js" keep
// working. The actual source of truth lives in src/popp.ts, which is also
// imported by the frontend (app/src/types.ts) via a relative path. This
// guarantees backend and frontend cannot drift.
export { NODE_TYPES, EDGE_RELATIONS };
export type { NodeType, EdgeRelation } from "./popp.js";

const NODE_TYPES_SQL = NODE_TYPES.map((t) => `'${t}'`).join(",");
const EDGE_RELATIONS_SQL = EDGE_RELATIONS.map((r) => `'${r}'`).join(",");

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN (${NODE_TYPES_SQL})),
    name TEXT NOT NULL,
    description TEXT,
    summary TEXT,
    summary_updated_at DATETIME,
    meta TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    visibility TEXT NOT NULL DEFAULT 'team',
    created_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES nodes(id),
    target_id TEXT NOT NULL REFERENCES nodes(id),
    relation TEXT NOT NULL CHECK(relation IN (${EDGE_RELATIONS_SQL})),
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
  await migrateEnforceTypes(db);
}

// One-shot migration: adds CHECK constraints to `nodes.type` and
// `edges.relation` on installs that predate enforcement. Idempotent --
// detects existing CHECK by inspecting sqlite_master and skips if present.
//
// SQLite cannot ALTER TABLE to add CHECK constraints, so we recreate both
// tables. The new `nodes` table preserves all existing columns (including
// `summary` and `summary_updated_at` used by planned embedding features).
async function migrateEnforceTypes(db: Client): Promise<void> {
  const result = await db.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'",
    args: [],
  });
  const existingSql = String(result.rows[0]?.sql ?? "");
  if (existingSql.includes("CHECK(type IN")) {
    return;
  }

  // Foreign keys must be disabled during table recreation: DROP TABLE nodes
  // would otherwise fail because edges/files/events/local_mirrors/audit_log
  // reference it. FK references in those tables are resolved by name at
  // query time, so recreating `nodes` with the same name re-attaches them.
  await db.execute("PRAGMA foreign_keys = OFF");
  try {
    await db.execute(`CREATE TABLE nodes_new (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN (${NODE_TYPES_SQL})),
      name TEXT NOT NULL,
      description TEXT,
      summary TEXT,
      summary_updated_at DATETIME,
      meta TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      visibility TEXT NOT NULL DEFAULT 'team',
      created_by TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )`);
    await db.execute(`INSERT INTO nodes_new (
      id, type, name, description, summary, summary_updated_at, meta,
      status, visibility, created_by, created_at, updated_at
    ) SELECT
      id, type, name, description, summary, summary_updated_at, meta,
      status, visibility, created_by, created_at, updated_at
    FROM nodes`);
    await db.execute("DROP TABLE nodes");
    await db.execute("ALTER TABLE nodes_new RENAME TO nodes");

    await db.execute(`CREATE TABLE edges_new (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES nodes(id),
      target_id TEXT NOT NULL REFERENCES nodes(id),
      relation TEXT NOT NULL CHECK(relation IN (${EDGE_RELATIONS_SQL})),
      meta TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )`);
    await db.execute(`INSERT INTO edges_new (
      id, source_id, target_id, relation, meta, created_by, created_at
    ) SELECT
      id, source_id, target_id, relation, meta, created_by, created_at
    FROM edges`);
    await db.execute("DROP TABLE edges");
    await db.execute("ALTER TABLE edges_new RENAME TO edges");

    await db.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique ON edges(source_id, target_id, relation)",
    );
    await db.execute("CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)");
    await db.execute("CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)");
  } finally {
    await db.execute("PRAGMA foreign_keys = ON");
  }
}
