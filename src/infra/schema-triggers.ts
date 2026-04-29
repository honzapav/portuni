// Schema reference data: enum SQL literals, fresh-install DDL, and all
// trigger/table constants. Pure declarations, no side effects.
//
// Split off from schema.ts so the runtime/migration logic is not buried
// under 250 lines of SQL string blocks.

import {
  NODE_TYPES,
  EDGE_RELATIONS,
  EVENT_TYPES,
  NODE_STATUSES,
  NODE_VISIBILITIES,
  EVENT_STATUSES,
  FILE_STATUSES,
} from "../shared/popp.js";

// Render an enum array as a comma-separated SQL string-literal list,
// suitable for CHECK(col IN (...)) constraints.
const sqlEnumList = (xs: readonly string[]): string =>
  xs.map((x) => `'${x}'`).join(",");

// SQL enum literals for CHECK constraints. Built once at module load
// from the canonical POPP enum sets.
export const NODE_TYPES_SQL = sqlEnumList(NODE_TYPES);
export const EDGE_RELATIONS_SQL = sqlEnumList(EDGE_RELATIONS);
export const EVENT_TYPES_SQL = sqlEnumList(EVENT_TYPES);
export const NODE_STATUSES_SQL = sqlEnumList(NODE_STATUSES);
export const NODE_VISIBILITIES_SQL = sqlEnumList(NODE_VISIBILITIES);
export const EVENT_STATUSES_SQL = sqlEnumList(EVENT_STATUSES);
export const FILE_STATUSES_SQL = sqlEnumList(FILE_STATUSES);

// Ground-truth DDL for fresh installs. Includes all CHECK constraints.
// Existing installs get constraints via migrations.
export const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    type TEXT NOT NULL CHECK(type IN (${NODE_TYPES_SQL})),
    name TEXT NOT NULL,
    description TEXT,
    summary TEXT,
    summary_updated_at DATETIME,
    meta TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (${NODE_STATUSES_SQL})),
    visibility TEXT NOT NULL DEFAULT 'team' CHECK(visibility IN (${NODE_VISIBILITIES_SQL})),
    pos_x REAL,
    pos_y REAL,
    owner_id TEXT,
    lifecycle_state TEXT,
    goal TEXT,
    sync_key TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
    CHECK(updated_at >= created_at)
  )`,
  // The unique partial index on sync_key is intentionally created by
  // runMigration013 (not here), because on existing DBs the nodes table
  // pre-dates the sync_key column and this DDL would fail. The migration
  // is idempotent and creates the index on both fresh installs and upgrades.
  `CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL CHECK(relation IN (${EDGE_RELATIONS_SQL})),
    meta TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    CHECK(source_id != target_id)
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
  // NOTE: `local_mirrors` is NOT created in Turso. Per-device mirror paths
  // live in the local sync.db (see src/sync/local-db.ts). Migration 011
  // drops the legacy Turso `local_mirrors` table on existing installs.
  // NOTE: `local_path` is NOT a column on `files`. The path on the current
  // device is derived from the per-device mirror root + remote_path + sync_key
  // at read time. Migration 012 drops the legacy column on existing installs.
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    remote_name TEXT,
    remote_path TEXT,
    current_remote_hash TEXT,
    last_pushed_by TEXT,
    last_pushed_at DATETIME,
    is_native_format INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'wip' CHECK(status IN (${FILE_STATUSES_SQL})),
    description TEXT,
    mime_type TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_files_node ON files(node_id)`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN (${EVENT_TYPES_SQL})),
    content TEXT NOT NULL,
    meta TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (${EVENT_STATUSES_SQL})),
    refs TEXT CHECK(refs IS NULL OR json_valid(refs)),
    task_ref TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)`,
  `CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  // Migration 009 tables (pluggable remotes + routing). Kept in DDL so a
  // fresh install gets these tables before any migration runs.
  `CREATE TABLE IF NOT EXISTS remotes (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('gdrive','dropbox','s3','fs','webdav','sftp')),
    config_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS remote_routing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    priority INTEGER NOT NULL,
    node_type TEXT,
    org_slug TEXT,
    remote_name TEXT NOT NULL REFERENCES remotes(name) ON DELETE RESTRICT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_remote_routing_priority ON remote_routing(priority)`,
];

// Org-invariant trigger SQL. Shared by migration 002, 004, 005, and the
// portuni_delete_node tool (which temporarily drops/recreates them). Also
// referenced by tests directly — keep the export.
export const TRIGGER_PREVENT_MULTI_PARENT_ORG = `
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
`;

export const TRIGGER_PREVENT_ORPHAN_ON_EDGE_DELETE = `
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
`;

// --- Migration 006 trigger constants (shared by DDL_MIGRATION_006 + runMigration006) ---

export const TRIGGER_RESPONSIBILITIES_VALID_NODE_TYPE = `
  CREATE TRIGGER IF NOT EXISTS responsibilities_valid_node_type
  BEFORE INSERT ON responsibilities
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'responsibilities can only attach to project/process/area nodes')
      WHERE (SELECT type FROM nodes WHERE id = NEW.node_id) NOT IN ('project','process','area');
  END
`;

export const TRIGGER_DATA_SOURCES_VALID_NODE_TYPE = `
  CREATE TRIGGER IF NOT EXISTS data_sources_valid_node_type
  BEFORE INSERT ON data_sources
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'data_sources can only attach to project/process/area nodes')
      WHERE (SELECT type FROM nodes WHERE id = NEW.node_id) NOT IN ('project','process','area');
  END
`;

export const TRIGGER_TOOLS_VALID_NODE_TYPE = `
  CREATE TRIGGER IF NOT EXISTS tools_valid_node_type
  BEFORE INSERT ON tools
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'tools can only attach to project/process/area nodes')
      WHERE (SELECT type FROM nodes WHERE id = NEW.node_id) NOT IN ('project','process','area');
  END
`;

// Legacy: previously restricted owner_id to real, user-linked persons.
// Dropped by migration 014 — ownership now accepts any actor (real
// person, placeholder, or automation). The FK constraint on owner_id
// already guarantees the referenced actor exists. Kept here only because
// migrations 007/008 reference it when rebuilding the actors table on
// pre-014 databases; migration 014 immediately drops it again.
export const TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON = `
  CREATE TRIGGER IF NOT EXISTS nodes_owner_must_be_real_person
  BEFORE UPDATE OF owner_id ON nodes
  FOR EACH ROW
  WHEN NEW.owner_id IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'owner_id must reference an actor of type=person with user_id set')
      WHERE NOT EXISTS (
        SELECT 1 FROM actors a
        WHERE a.id = NEW.owner_id
          AND a.type = 'person'
          AND a.user_id IS NOT NULL
          AND a.is_placeholder = 0
      );
  END
`;

// Derive coarse status from lifecycle_state after it changes.
// SQLite re-fires a trigger only for the specific column named in UPDATE OF,
// so updating status here does not re-enter this trigger.
export const TRIGGER_NODES_DERIVE_STATUS_FROM_LIFECYCLE = `
  CREATE TRIGGER IF NOT EXISTS nodes_derive_status_from_lifecycle
  AFTER UPDATE OF lifecycle_state ON nodes
  FOR EACH ROW
  WHEN NEW.lifecycle_state IS NOT NULL
  BEGIN
    UPDATE nodes SET status = CASE NEW.lifecycle_state
      WHEN 'done' THEN 'completed'
      WHEN 'archived' THEN 'archived'
      WHEN 'retired' THEN 'archived'
      WHEN 'cancelled' THEN 'archived'
      WHEN 'inactive' THEN 'archived'
      ELSE 'active'
    END WHERE id = NEW.id;
  END
`;

export const TRIGGER_NODES_VALIDATE_LIFECYCLE_STATE = `
  CREATE TRIGGER IF NOT EXISTS nodes_validate_lifecycle_state
  BEFORE UPDATE OF lifecycle_state ON nodes
  FOR EACH ROW
  WHEN NEW.lifecycle_state IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'invalid lifecycle_state for node type')
      WHERE (NEW.type = 'organization' AND NEW.lifecycle_state NOT IN ('active','inactive','archived'))
         OR (NEW.type = 'area'         AND NEW.lifecycle_state NOT IN ('active','needs_attention','inactive','archived'))
         OR (NEW.type = 'process'      AND NEW.lifecycle_state NOT IN ('not_implemented','implementing','operating','at_risk','broken','retired'))
         OR (NEW.type = 'project'      AND NEW.lifecycle_state NOT IN ('backlog','planned','in_progress','on_hold','done','cancelled'))
         OR (NEW.type = 'principle'    AND NEW.lifecycle_state NOT IN ('active','archived'));
  END
`;

// --- Migration 006 table DDL constants ---

// Actors are global (cross-organizational) entities: a single person or
// automation can be assigned to responsibilities or own nodes across any
// number of organizations. No org_id column. No description column either
// — what an actor does is defined by their responsibilities on specific
// nodes, not by a generic role blurb. Internal notes live in `notes`.
export const DDL_ACTORS_TABLE = `CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY CHECK(length(id) = 26),
  type TEXT NOT NULL CHECK(type IN ('person','automation')),
  name TEXT NOT NULL,
  is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK(is_placeholder IN (0,1)),
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  external_id TEXT,
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
  CHECK(type = 'person' OR (is_placeholder = 0 AND user_id IS NULL))
)`;

export const DDL_RESPONSIBILITIES_TABLE = `CREATE TABLE IF NOT EXISTS responsibilities (
  id TEXT PRIMARY KEY CHECK(length(id) = 26),
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
)`;

export const DDL_RESPONSIBILITY_ASSIGNMENTS_TABLE = `CREATE TABLE IF NOT EXISTS responsibility_assignments (
  responsibility_id TEXT NOT NULL REFERENCES responsibilities(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (responsibility_id, actor_id)
)`;

export const DDL_DATA_SOURCES_TABLE = `CREATE TABLE IF NOT EXISTS data_sources (
  id TEXT PRIMARY KEY CHECK(length(id) = 26),
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  external_link TEXT,
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
)`;

export const DDL_TOOLS_TABLE = `CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY CHECK(length(id) = 26),
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  external_link TEXT,
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
)`;

// Seeds lifecycle_state for existing rows based on current status+type.
// Idempotent: only affects rows where lifecycle_state IS NULL.
export const SEED_LIFECYCLE_STATE_FROM_STATUS = `UPDATE nodes SET lifecycle_state = CASE
  WHEN type = 'organization' AND status = 'active' THEN 'active'
  WHEN type = 'organization' AND status = 'archived' THEN 'archived'
  WHEN type = 'area' AND status = 'active' THEN 'active'
  WHEN type = 'area' AND status = 'archived' THEN 'archived'
  WHEN type = 'process' AND status = 'active' THEN 'operating'
  WHEN type = 'process' AND status = 'archived' THEN 'retired'
  WHEN type = 'project' AND status = 'active' THEN 'in_progress'
  WHEN type = 'project' AND status = 'completed' THEN 'done'
  WHEN type = 'project' AND status = 'archived' THEN 'cancelled'
  WHEN type = 'principle' AND status = 'active' THEN 'active'
  WHEN type = 'principle' AND status = 'archived' THEN 'archived'
  ELSE lifecycle_state
END WHERE lifecycle_state IS NULL`;

// --- Migration 009 / 010 / 013 DDL constants (file-sync foundation) ---

// Migration 009: pluggable remote backends + routing rules. A `remote` is a
// named storage adapter (gdrive, dropbox, etc.) with backend-specific
// config_json. `remote_routing` maps node-type / org-slug filters to a
// remote, applied in priority order so different node types can land on
// different remotes.
export const DDL_REMOTES_TABLE = `
  CREATE TABLE IF NOT EXISTS remotes (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('gdrive','dropbox','s3','fs','webdav','sftp')),
    config_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )
`;

export const DDL_REMOTE_ROUTING_TABLE = `
  CREATE TABLE IF NOT EXISTS remote_routing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    priority INTEGER NOT NULL,
    node_type TEXT,
    org_slug TEXT,
    remote_name TEXT NOT NULL REFERENCES remotes(name) ON DELETE RESTRICT
  )
`;

export const INDEX_REMOTE_ROUTING_PRIORITY =
  "CREATE INDEX IF NOT EXISTS idx_remote_routing_priority ON remote_routing(priority)";

// --- Migration 013 trigger constants (sync_key NOT-NULL enforcement) ---
//
// SQLite ALTER TABLE cannot add a NOT NULL column to a table that already
// has rows, and rebuilding `nodes` to add NOT NULL would force re-creating
// every CHECK constraint and trigger. Instead, migration 013 adds the
// column as nullable, backfills it, then enforces non-emptiness via two
// BEFORE triggers — INSERT and UPDATE OF sync_key. Combined with the
// partial UNIQUE index, this gives the full UNIQUE NOT NULL semantics.

export const TRIGGER_NODES_SYNC_KEY_NOT_NULL_INSERT = `
  CREATE TRIGGER IF NOT EXISTS nodes_sync_key_not_null_insert
  BEFORE INSERT ON nodes
  FOR EACH ROW
  WHEN NEW.sync_key IS NULL OR NEW.sync_key = ''
  BEGIN
    SELECT RAISE(ABORT, 'nodes.sync_key must be a non-empty string');
  END
`;

export const TRIGGER_NODES_SYNC_KEY_NOT_NULL_UPDATE = `
  CREATE TRIGGER IF NOT EXISTS nodes_sync_key_not_null_update
  BEFORE UPDATE OF sync_key ON nodes
  FOR EACH ROW
  WHEN NEW.sync_key IS NULL OR NEW.sync_key = ''
  BEGIN
    SELECT RAISE(ABORT, 'nodes.sync_key must be a non-empty string');
  END
`;

// Migration 006 table DDL, indexes, and triggers — applied on fresh installs
// so ensureSchema() on a brand-new DB has the complete schema without
// running the migration. (The nodes table in DDL already includes owner_id,
// lifecycle_state, and goal columns.)
export const DDL_MIGRATION_006 = [
  DDL_ACTORS_TABLE,
  "CREATE INDEX IF NOT EXISTS idx_actors_type ON actors(type)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_external ON actors(external_id) WHERE external_id IS NOT NULL",
  DDL_RESPONSIBILITIES_TABLE,
  "CREATE INDEX IF NOT EXISTS idx_responsibilities_node ON responsibilities(node_id)",
  TRIGGER_RESPONSIBILITIES_VALID_NODE_TYPE,
  DDL_RESPONSIBILITY_ASSIGNMENTS_TABLE,
  DDL_DATA_SOURCES_TABLE,
  "CREATE INDEX IF NOT EXISTS idx_data_sources_node ON data_sources(node_id)",
  TRIGGER_DATA_SOURCES_VALID_NODE_TYPE,
  DDL_TOOLS_TABLE,
  "CREATE INDEX IF NOT EXISTS idx_tools_node ON tools(node_id)",
  TRIGGER_TOOLS_VALID_NODE_TYPE,
  // owner-validation trigger intentionally omitted — migration 014
  // dropped the "owner must be real registered person" restriction.
  TRIGGER_NODES_DERIVE_STATUS_FROM_LIFECYCLE,
  TRIGGER_NODES_VALIDATE_LIFECYCLE_STATE,
];
