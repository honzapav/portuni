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
    pos_x REAL,
    pos_y REAL,
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
  await migrateOrgInvariant(db);
  await migratePositions(db);
}

// Adds nullable pos_x, pos_y columns to installs that predate position
// persistence. Null means "no saved position yet" -- the frontend will
// compute one on first layout and save it back. Idempotent: we probe
// sqlite_master before altering so reruns are no-ops.
//
// SQLite's ALTER TABLE ADD COLUMN is safe for nullable columns without
// defaults (it's an O(1) metadata change, not a table rewrite). We can
// use it directly instead of the full recreate dance that
// migrateEnforceTypes does.
async function migratePositions(db: Client): Promise<void> {
  const result = await db.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'",
    args: [],
  });
  const existingSql = String(result.rows[0]?.sql ?? "");
  if (!existingSql.includes("pos_x")) {
    await db.execute("ALTER TABLE nodes ADD COLUMN pos_x REAL");
  }
  if (!existingSql.includes("pos_y")) {
    await db.execute("ALTER TABLE nodes ADD COLUMN pos_y REAL");
  }
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

// Organization invariant: every non-organization node must have exactly one
// `belongs_to` edge pointing to an organization. No orphans, no multi-parent.
//
// The POPP framework treats organizations as the scoping unit for all work.
// A project, process, area, or principle must belong to exactly one
// organization. This keeps ownership unambiguous, makes local mirror paths
// deterministic, and prevents the "where does this live" confusion that
// motivated Portuni in the first place.
//
// Enforced at three layers:
//   1. Tool layer (portuni_create_node): atomically creates the node and
//      its belongs_to edge in a single batch. The `organization_id` param
//      is required for non-organization types.
//   2. Tool layer (portuni_connect / portuni_disconnect): runtime checks
//      reject attempts to add a second belongs_to -> org or to remove the
//      only belongs_to -> org for a non-org source.
//   3. DB layer (this migration): two triggers on `edges` that catch any
//      direct SQL that bypasses the tool layer. Defense in depth for seed
//      scripts, manual fixups, and future REST endpoints.
//
// There is no BEFORE INSERT trigger on `nodes` because SQLite has no
// deferred constraints: the trigger would fire before the companion edge
// exists, and always fail. Create-time enforcement therefore lives in the
// tool layer, which bundles node + edge into one atomic batch.
async function migrateOrgInvariant(db: Client): Promise<void> {
  // Idempotent: both triggers use CREATE TRIGGER IF NOT EXISTS so reruns
  // are no-ops. Installing triggers on a database whose data already
  // violates the invariant would succeed (triggers only fire on future
  // changes), so we guard with an explicit invariant check first -- if any
  // non-org node is an orphan or has multiple belongs_to -> org edges,
  // abort the migration and surface the offending rows so a human can fix
  // them before enforcement kicks in.
  // The invariant applies to every non-organization node regardless of
  // status -- archived and completed nodes count too. An archived project
  // that lost its belongs_to would become an undetected orphan after a
  // restart, which is how "CRUD Test 2" slipped past the first version of
  // this check. Every startup re-runs this query as an integrity sweep.
  const violations = await db.execute({
    sql: `
      SELECT id, type, name, org_count FROM (
        SELECT n.id AS id, n.type AS type, n.name AS name,
               (SELECT COUNT(*)
                  FROM edges e
                  JOIN nodes t ON t.id = e.target_id
                 WHERE e.source_id = n.id
                   AND e.relation = 'belongs_to'
                   AND t.type = 'organization') AS org_count
          FROM nodes n
         WHERE n.type != 'organization'
      ) WHERE org_count != 1
    `,
    args: [],
  });
  if (violations.rows.length > 0) {
    const details = violations.rows
      .map((r) => `${r.type}:${r.name} (${r.id}) has ${r.org_count} belongs_to -> organization edges`)
      .join("; ");
    throw new Error(
      `Organization invariant migration aborted: ${violations.rows.length} node(s) violate "exactly one belongs_to -> organization". Fix the data first, then restart. Offenders: ${details}`,
    );
  }

  // Prevent multi-parent: a non-organization node cannot gain a second
  // belongs_to -> organization edge. Fires on INSERT to edges.
  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS prevent_multi_parent_org
    BEFORE INSERT ON edges
    FOR EACH ROW
    WHEN NEW.relation = 'belongs_to'
    BEGIN
      SELECT RAISE(ABORT, 'non-organization node already belongs to an organization; disconnect the existing belongs_to edge first')
        WHERE (SELECT type FROM nodes WHERE id = NEW.source_id) != 'organization'
          AND (SELECT type FROM nodes WHERE id = NEW.target_id) = 'organization'
          AND EXISTS (
            SELECT 1 FROM edges e
              JOIN nodes t ON t.id = e.target_id
             WHERE e.source_id = NEW.source_id
               AND e.relation = 'belongs_to'
               AND t.type = 'organization'
          );
    END
  `);

  // Prevent orphan: the only belongs_to -> organization edge of a
  // non-organization node cannot be deleted. Fires on DELETE from edges.
  await db.execute(`
    CREATE TRIGGER IF NOT EXISTS prevent_orphan_on_edge_delete
    BEFORE DELETE ON edges
    FOR EACH ROW
    WHEN OLD.relation = 'belongs_to'
    BEGIN
      SELECT RAISE(ABORT, 'cannot remove last belongs_to -> organization edge; every non-organization node must belong to exactly one organization')
        WHERE (SELECT type FROM nodes WHERE id = OLD.source_id) != 'organization'
          AND (SELECT type FROM nodes WHERE id = OLD.target_id) = 'organization'
          AND (
            SELECT COUNT(*) FROM edges e
              JOIN nodes t ON t.id = e.target_id
             WHERE e.source_id = OLD.source_id
               AND e.relation = 'belongs_to'
               AND t.type = 'organization'
          ) <= 1;
    END
  `);
}
