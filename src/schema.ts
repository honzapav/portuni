// src/schema.ts
import type { Client } from "@libsql/client";
import { getDb } from "./db.js";
import {
  NODE_TYPES,
  EDGE_RELATIONS,
  EVENT_TYPES,
  NODE_STATUSES,
  NODE_VISIBILITIES,
  EVENT_STATUSES,
  FILE_STATUSES,
} from "./popp.js";

// Re-export canonical sets so existing imports from "./schema.js" keep working.
export {
  NODE_TYPES,
  EDGE_RELATIONS,
  EVENT_TYPES,
  NODE_STATUSES,
  NODE_VISIBILITIES,
  EVENT_STATUSES,
  FILE_STATUSES,
};
export type {
  NodeType,
  EdgeRelation,
  EventType,
  NodeStatus,
  NodeVisibility,
  EventStatus,
  FileStatus,
} from "./popp.js";

// SQL enum literals for CHECK constraints.
const NODE_TYPES_SQL = NODE_TYPES.map((t) => `'${t}'`).join(",");
const EDGE_RELATIONS_SQL = EDGE_RELATIONS.map((r) => `'${r}'`).join(",");
const EVENT_TYPES_SQL = EVENT_TYPES.map((t) => `'${t}'`).join(",");
const NODE_STATUSES_SQL = NODE_STATUSES.map((s) => `'${s}'`).join(",");
const NODE_VISIBILITIES_SQL = NODE_VISIBILITIES.map((v) => `'${v}'`).join(",");
const EVENT_STATUSES_SQL = EVENT_STATUSES.map((s) => `'${s}'`).join(",");
const FILE_STATUSES_SQL = FILE_STATUSES.map((s) => `'${s}'`).join(",");

// Ground-truth DDL for fresh installs. Includes all CHECK constraints.
// Existing installs get constraints via migrations below.
const DDL = [
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
    created_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
    CHECK(updated_at >= created_at)
  )`,
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
  `CREATE TABLE IF NOT EXISTS local_mirrors (
    user_id TEXT NOT NULL REFERENCES users(id),
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    local_path TEXT NOT NULL,
    registered_at DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, node_id)
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    local_path TEXT,
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
];

const SOLO_USER_ID = "01SOLO0000000000000000000";

const soloEmail = process.env.PORTUNI_USER_EMAIL ?? "solo@localhost";
const soloName = process.env.PORTUNI_USER_NAME ?? "Solo User";

const SEED = [
  `INSERT OR IGNORE INTO users (id, email, name, created_at)
   VALUES ('${SOLO_USER_ID}', '${soloEmail}', '${soloName}', datetime('now'))`,
];

export const SOLO_USER = SOLO_USER_ID;

// ---------------------------------------------------------------------------
// Migration system
// ---------------------------------------------------------------------------

interface Migration {
  id: string;
  // For legacy migrations: detect if already applied before the migrations
  // table existed. Return true to skip and just mark as applied.
  isApplied?: (db: Client) => Promise<boolean>;
  up: (db: Client) => Promise<void>;
}

// Org-invariant trigger SQL, shared by migration 002, 004, 005, and the
// portuni_delete_node tool (which temporarily drops/recreates them).
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

// --- Migration 006 trigger constants (shared by DDL + runMigration006) ---

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

// Validate owner_id references a real, user-linked person. Actors are
// global (cross-organizational), so there is no same-org constraint --
// any real person can own any node.
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

// DDL for the five people/responsibilities tables (used by both fresh DDL
// and runMigration006). Kept as statement constants so the two callers stay
// in sync.
// Actors are global (cross-organizational) entities: a single person or
// automation can be assigned to responsibilities or own nodes across any
// number of organizations. No org_id column.
export const DDL_ACTORS_TABLE = `CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY CHECK(length(id) = 26),
  type TEXT NOT NULL CHECK(type IN ('person','automation')),
  name TEXT NOT NULL,
  description TEXT,
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

// Migration 006: add actors, responsibilities, responsibility_assignments,
// data_sources, tools; add owner_id/lifecycle_state/goal columns to nodes;
// install validation + lifecycle-derivation triggers; seed lifecycle_state.
export async function runMigration006(db: Client): Promise<void> {
  // 1. actors table + indexes. Actors are global (no org_id); external_id is
  // unique across the whole registry when set.
  await db.execute(DDL_ACTORS_TABLE);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_actors_type ON actors(type)");
  await db.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_external ON actors(external_id) WHERE external_id IS NOT NULL",
  );

  // 2. responsibilities + index + node_type trigger
  await db.execute(DDL_RESPONSIBILITIES_TABLE);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_responsibilities_node ON responsibilities(node_id)");
  await db.execute(TRIGGER_RESPONSIBILITIES_VALID_NODE_TYPE);

  // 3. responsibility_assignments (PK prevents duplicates)
  await db.execute(DDL_RESPONSIBILITY_ASSIGNMENTS_TABLE);

  // 4. data_sources + index + node_type trigger
  await db.execute(DDL_DATA_SOURCES_TABLE);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_data_sources_node ON data_sources(node_id)");
  await db.execute(TRIGGER_DATA_SOURCES_VALID_NODE_TYPE);

  // 5. tools + index + node_type trigger
  await db.execute(DDL_TOOLS_TABLE);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_tools_node ON tools(node_id)");
  await db.execute(TRIGGER_TOOLS_VALID_NODE_TYPE);

  // 6. Three new columns on nodes (additive ALTER TABLE).
  //    Must be idempotent: DDL_MIGRATION_006 runs before this migration on
  //    startup and creates the `actors` table, which in turn makes the old
  //    isApplied check return true before ALTER TABLE ran. If columns already
  //    exist (fresh install via updated DDL), skip — re-run must not crash.
  const info = await db.execute("PRAGMA table_info(nodes)");
  const existingCols = new Set(info.rows.map((r) => r.name as string));
  if (!existingCols.has("owner_id")) {
    await db.execute("ALTER TABLE nodes ADD COLUMN owner_id TEXT REFERENCES actors(id) ON DELETE SET NULL");
  }
  if (!existingCols.has("lifecycle_state")) {
    await db.execute("ALTER TABLE nodes ADD COLUMN lifecycle_state TEXT");
  }
  if (!existingCols.has("goal")) {
    await db.execute("ALTER TABLE nodes ADD COLUMN goal TEXT");
  }

  // 7. Owner validation trigger
  await db.execute(TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON);

  // 8. Status derivation trigger (AFTER UPDATE OF lifecycle_state)
  await db.execute(TRIGGER_NODES_DERIVE_STATUS_FROM_LIFECYCLE);

  // 9. Lifecycle-state validation trigger
  await db.execute(TRIGGER_NODES_VALIDATE_LIFECYCLE_STATE);

  // 10. Seed lifecycle_state for existing rows based on current status+type
  await db.execute(SEED_LIFECYCLE_STATE_FROM_STATUS);
}

const MIGRATIONS: Migration[] = [
  // Legacy migration 001: CHECK constraints on nodes.type and edges.relation.
  {
    id: "001_enforce_types",
    isApplied: async (db) => {
      const r = await db.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'",
        args: [],
      });
      return String(r.rows[0]?.sql ?? "").includes("CHECK(type IN");
    },
    up: async (db) => {
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
    },
  },

  // Legacy migration 002: org-invariant triggers.
  {
    id: "002_org_invariant",
    isApplied: async (db) => {
      const r = await db.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='trigger' AND name='prevent_multi_parent_org'",
        args: [],
      });
      return r.rows.length > 0;
    },
    up: async (db) => {
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
          .map(
            (r) =>
              `${r.type}:${r.name} (${r.id}) has ${r.org_count} belongs_to -> organization edges`,
          )
          .join("; ");
        throw new Error(
          `Organization invariant migration aborted: ${violations.rows.length} node(s) violate "exactly one belongs_to -> organization". Fix the data first, then restart. Offenders: ${details}`,
        );
      }
      await db.execute(TRIGGER_PREVENT_MULTI_PARENT_ORG);
      await db.execute(TRIGGER_PREVENT_ORPHAN_ON_EDGE_DELETE);
    },
  },

  // Legacy migration 003: pos_x, pos_y columns on nodes.
  {
    id: "003_positions",
    isApplied: async (db) => {
      const r = await db.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'",
        args: [],
      });
      return String(r.rows[0]?.sql ?? "").includes("pos_x");
    },
    up: async (db) => {
      await db.execute("ALTER TABLE nodes ADD COLUMN pos_x REAL");
      await db.execute("ALTER TABLE nodes ADD COLUMN pos_y REAL");
    },
  },

  // New migration 004: CHECK constraints on status/visibility/event-type
  // enums, ULID length, timestamp sanity, self-loop prevention, json_valid
  // on refs. Recreates nodes, edges, events, files tables.
  {
    id: "004_check_constraints",
    isApplied: async (db) => {
      const r = await db.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'",
        args: [],
      });
      return String(r.rows[0]?.sql ?? "").includes("CHECK(status IN");
    },
    up: async (db) => {
      // --- pre-migration data validation ---
      const badNodeStatuses = await db.execute(
        `SELECT DISTINCT status FROM nodes WHERE status NOT IN (${NODE_STATUSES_SQL})`,
      );
      if (badNodeStatuses.rows.length > 0) {
        throw new Error(
          `Migration 004 aborted: nodes contain invalid statuses: ${badNodeStatuses.rows.map((r) => r.status).join(", ")}`,
        );
      }
      const badVisibilities = await db.execute(
        `SELECT DISTINCT visibility FROM nodes WHERE visibility NOT IN (${NODE_VISIBILITIES_SQL})`,
      );
      if (badVisibilities.rows.length > 0) {
        throw new Error(
          `Migration 004 aborted: nodes contain invalid visibilities: ${badVisibilities.rows.map((r) => r.visibility).join(", ")}`,
        );
      }
      const badEventTypes = await db.execute(
        `SELECT DISTINCT type FROM events WHERE type NOT IN (${EVENT_TYPES_SQL})`,
      );
      if (badEventTypes.rows.length > 0) {
        throw new Error(
          `Migration 004 aborted: events contain invalid types: ${badEventTypes.rows.map((r) => r.type).join(", ")}`,
        );
      }
      const badEventStatuses = await db.execute(
        `SELECT DISTINCT status FROM events WHERE status NOT IN (${EVENT_STATUSES_SQL})`,
      );
      if (badEventStatuses.rows.length > 0) {
        throw new Error(
          `Migration 004 aborted: events contain invalid statuses: ${badEventStatuses.rows.map((r) => r.status).join(", ")}`,
        );
      }
      const badFileStatuses = await db.execute(
        `SELECT DISTINCT status FROM files WHERE status NOT IN (${FILE_STATUSES_SQL})`,
      );
      if (badFileStatuses.rows.length > 0) {
        throw new Error(
          `Migration 004 aborted: files contain invalid statuses: ${badFileStatuses.rows.map((r) => r.status).join(", ")}`,
        );
      }
      const selfLoops = await db.execute(
        "SELECT id FROM edges WHERE source_id = target_id",
      );
      if (selfLoops.rows.length > 0) {
        throw new Error(
          `Migration 004 aborted: ${selfLoops.rows.length} self-loop edge(s) found. Fix data first.`,
        );
      }
      const badTimestamps = await db.execute(
        "SELECT id, name FROM nodes WHERE updated_at < created_at",
      );
      if (badTimestamps.rows.length > 0) {
        throw new Error(
          `Migration 004 aborted: ${badTimestamps.rows.length} node(s) with updated_at < created_at. Fix data first.`,
        );
      }
      const badNodeIds = await db.execute(
        "SELECT id FROM nodes WHERE length(id) != 26",
      );
      if (badNodeIds.rows.length > 0) {
        throw new Error(
          `Migration 004 aborted: ${badNodeIds.rows.length} node(s) with non-ULID id (length != 26). Fix data first: ${badNodeIds.rows.map((r) => r.id).join(", ")}`,
        );
      }
      const badEdgeIds = await db.execute(
        "SELECT id FROM edges WHERE length(id) != 26",
      );
      if (badEdgeIds.rows.length > 0) {
        throw new Error(
          `Migration 004 aborted: ${badEdgeIds.rows.length} edge(s) with non-ULID id (length != 26). Fix data first: ${badEdgeIds.rows.map((r) => r.id).join(", ")}`,
        );
      }

      // --- recreate tables ---
      await db.execute("PRAGMA foreign_keys = OFF");
      try {
        // -- nodes --
        await db.execute(`CREATE TABLE nodes_new (
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
          created_by TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT (datetime('now')),
          updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
          CHECK(updated_at >= created_at)
        )`);
        await db.execute(`INSERT INTO nodes_new (
          id, type, name, description, summary, summary_updated_at, meta,
          status, visibility, pos_x, pos_y, created_by, created_at, updated_at
        ) SELECT
          id, type, name, description, summary, summary_updated_at, meta,
          status, visibility, pos_x, pos_y, created_by, created_at, updated_at
        FROM nodes`);
        await db.execute("DROP TABLE nodes");
        await db.execute("ALTER TABLE nodes_new RENAME TO nodes");

        // -- edges --
        await db.execute(`CREATE TABLE edges_new (
          id TEXT PRIMARY KEY CHECK(length(id) = 26),
          source_id TEXT NOT NULL REFERENCES nodes(id),
          target_id TEXT NOT NULL REFERENCES nodes(id),
          relation TEXT NOT NULL CHECK(relation IN (${EDGE_RELATIONS_SQL})),
          meta TEXT,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at DATETIME NOT NULL DEFAULT (datetime('now')),
          CHECK(source_id != target_id)
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
        await db.execute(
          "CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)",
        );
        await db.execute(
          "CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)",
        );

        // Recreate org-invariant triggers (dropped with edges table).
        await db.execute(TRIGGER_PREVENT_MULTI_PARENT_ORG);
        await db.execute(TRIGGER_PREVENT_ORPHAN_ON_EDGE_DELETE);

        // -- events --
        await db.execute(`CREATE TABLE events_new (
          id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL REFERENCES nodes(id),
          type TEXT NOT NULL CHECK(type IN (${EVENT_TYPES_SQL})),
          content TEXT NOT NULL,
          meta TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (${EVENT_STATUSES_SQL})),
          refs TEXT CHECK(refs IS NULL OR json_valid(refs)),
          task_ref TEXT,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
        )`);
        await db.execute(`INSERT INTO events_new (
          id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at
        ) SELECT
          id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at
        FROM events`);
        await db.execute("DROP TABLE events");
        await db.execute("ALTER TABLE events_new RENAME TO events");
        await db.execute(
          "CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id)",
        );
        await db.execute(
          "CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)",
        );

        // -- files --
        await db.execute(`CREATE TABLE files_new (
          id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL REFERENCES nodes(id),
          filename TEXT NOT NULL,
          local_path TEXT,
          status TEXT NOT NULL DEFAULT 'wip' CHECK(status IN (${FILE_STATUSES_SQL})),
          description TEXT,
          mime_type TEXT,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at DATETIME NOT NULL DEFAULT (datetime('now')),
          updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
        )`);
        await db.execute(`INSERT INTO files_new (
          id, node_id, filename, local_path, status, description, mime_type,
          created_by, created_at, updated_at
        ) SELECT
          id, node_id, filename, local_path, status, description, mime_type,
          created_by, created_at, updated_at
        FROM files`);
        await db.execute("DROP TABLE files");
        await db.execute("ALTER TABLE files_new RENAME TO files");
        await db.execute(
          "CREATE INDEX IF NOT EXISTS idx_files_node ON files(node_id)",
        );
      } finally {
        await db.execute("PRAGMA foreign_keys = ON");
      }
    },
  },

  // Migration 005: ON DELETE CASCADE on all node FK references.
  // Recreates edges, events, files, local_mirrors so that deleting a node
  // automatically cascades to child rows.
  {
    id: "005_cascade_delete",
    isApplied: async (db) => {
      const r = await db.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='edges'",
        args: [],
      });
      return String(r.rows[0]?.sql ?? "").includes("ON DELETE CASCADE");
    },
    up: async (db) => {
      await db.execute("PRAGMA foreign_keys = OFF");
      try {
        // -- edges --
        await db.execute(`CREATE TABLE edges_new (
          id TEXT PRIMARY KEY CHECK(length(id) = 26),
          source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          relation TEXT NOT NULL CHECK(relation IN (${EDGE_RELATIONS_SQL})),
          meta TEXT,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at DATETIME NOT NULL DEFAULT (datetime('now')),
          CHECK(source_id != target_id)
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
        await db.execute(
          "CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)",
        );
        await db.execute(
          "CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)",
        );
        // Recreate org-invariant triggers (dropped with edges table).
        await db.execute(TRIGGER_PREVENT_MULTI_PARENT_ORG);
        await db.execute(TRIGGER_PREVENT_ORPHAN_ON_EDGE_DELETE);

        // -- events --
        await db.execute(`CREATE TABLE events_new (
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
        )`);
        await db.execute(`INSERT INTO events_new (
          id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at
        ) SELECT
          id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at
        FROM events`);
        await db.execute("DROP TABLE events");
        await db.execute("ALTER TABLE events_new RENAME TO events");
        await db.execute(
          "CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id)",
        );
        await db.execute(
          "CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)",
        );

        // -- files --
        await db.execute(`CREATE TABLE files_new (
          id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          local_path TEXT,
          status TEXT NOT NULL DEFAULT 'wip' CHECK(status IN (${FILE_STATUSES_SQL})),
          description TEXT,
          mime_type TEXT,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at DATETIME NOT NULL DEFAULT (datetime('now')),
          updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
        )`);
        await db.execute(`INSERT INTO files_new (
          id, node_id, filename, local_path, status, description, mime_type,
          created_by, created_at, updated_at
        ) SELECT
          id, node_id, filename, local_path, status, description, mime_type,
          created_by, created_at, updated_at
        FROM files`);
        await db.execute("DROP TABLE files");
        await db.execute("ALTER TABLE files_new RENAME TO files");
        await db.execute(
          "CREATE INDEX IF NOT EXISTS idx_files_node ON files(node_id)",
        );

        // -- local_mirrors --
        await db.execute(`CREATE TABLE local_mirrors_new (
          user_id TEXT NOT NULL REFERENCES users(id),
          node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          local_path TEXT NOT NULL,
          registered_at DATETIME NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, node_id)
        )`);
        await db.execute(`INSERT INTO local_mirrors_new (
          user_id, node_id, local_path, registered_at
        ) SELECT
          user_id, node_id, local_path, registered_at
        FROM local_mirrors`);
        await db.execute("DROP TABLE local_mirrors");
        await db.execute("ALTER TABLE local_mirrors_new RENAME TO local_mirrors");
      } finally {
        await db.execute("PRAGMA foreign_keys = ON");
      }
    },
  },

  // Migration 006: people + responsibilities + data sources + tools.
  // Adds five new tables, three node columns (owner_id, lifecycle_state,
  // goal), and validation/derivation triggers. Fresh installs get the new
  // columns directly from DDL and the new tables via ensureSchema(); the
  // migration applies to existing databases.
  {
    id: "006_people_responsibilities",
    isApplied: async (db) => {
      // Check BOTH the new table AND the three new columns on nodes.
      // DDL_MIGRATION_006 runs before this migration during ensureSchema()
      // and unconditionally creates the `actors` table via CREATE TABLE IF
      // NOT EXISTS — so checking only that table would spuriously report
      // "applied" on databases where the ALTER TABLE statements never ran.
      const tableCheck = await db.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='actors'",
        args: [],
      });
      if (tableCheck.rows.length === 0) return false;
      const info = await db.execute("PRAGMA table_info(nodes)");
      const cols = new Set(info.rows.map((r) => r.name as string));
      return cols.has("owner_id") && cols.has("lifecycle_state") && cols.has("goal");
    },
    up: async (db) => {
      await runMigration006(db);
    },
  },

  // Migration 007: make actors global (cross-organizational).
  // Drops actors.org_id, the org-matching trigger and org-scoped indexes,
  // and rewrites the owner-validation trigger to drop its same-org check.
  // Idempotent -- isApplied returns true when actors.org_id no longer exists
  // (fresh installs via the updated DDL skip this migration entirely).
  {
    id: "007_actors_cross_org",
    isApplied: async (db) => {
      // If actors table missing, migration 006 hasn't run -- can't be
      // considered applied. Otherwise, applied iff org_id column is gone.
      const tableCheck = await db.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='actors'",
        args: [],
      });
      if (tableCheck.rows.length === 0) return false;
      const info = await db.execute("PRAGMA table_info(actors)");
      const cols = new Set(info.rows.map((r) => r.name as string));
      return !cols.has("org_id");
    },
    up: async (db) => {
      await db.execute("PRAGMA foreign_keys = OFF");
      try {
        // Drop dependents that reference actors or actors.org_id.
        await db.execute("DROP TRIGGER IF EXISTS actors_org_must_be_organization");
        await db.execute("DROP TRIGGER IF EXISTS nodes_owner_must_be_real_person");
        await db.execute("DROP INDEX IF EXISTS idx_actors_org");
        await db.execute("DROP INDEX IF EXISTS idx_actors_org_external");

        // Rebuild actors table without org_id via the standard table-copy
        // pattern (safer than ALTER TABLE DROP COLUMN across libsql versions).
        await db.execute(`CREATE TABLE actors_new (
          id TEXT PRIMARY KEY CHECK(length(id) = 26),
          type TEXT NOT NULL CHECK(type IN ('person','automation')),
          name TEXT NOT NULL,
          description TEXT,
          is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK(is_placeholder IN (0,1)),
          user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          notes TEXT,
          external_id TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now')),
          updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
          CHECK(type = 'person' OR (is_placeholder = 0 AND user_id IS NULL))
        )`);
        await db.execute(`INSERT INTO actors_new (
          id, type, name, description, is_placeholder, user_id, notes, external_id, created_at, updated_at
        ) SELECT
          id, type, name, description, is_placeholder, user_id, notes, external_id, created_at, updated_at
        FROM actors`);
        await db.execute("DROP TABLE actors");
        await db.execute("ALTER TABLE actors_new RENAME TO actors");

        // Recreate indexes -- type index as before, external_id now globally
        // unique (no longer scoped per organization).
        await db.execute("CREATE INDEX IF NOT EXISTS idx_actors_type ON actors(type)");
        await db.execute(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_external ON actors(external_id) WHERE external_id IS NOT NULL",
        );

        // Reinstall the owner-validation trigger without the same-org check.
        await db.execute(TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON);
      } finally {
        await db.execute("PRAGMA foreign_keys = ON");
      }
    },
  },
];

async function runMigrations(db: Client): Promise<void> {
  // Ensure the migrations table exists (DDL already has it for fresh
  // installs, but this covers databases created before the table existed).
  await db.execute(
    `CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )`,
  );

  for (const migration of MIGRATIONS) {
    // Already tracked?
    const tracked = await db.execute({
      sql: "SELECT id FROM migrations WHERE id = ?",
      args: [migration.id],
    });
    if (tracked.rows.length > 0) continue;

    // Legacy migration: detect if applied before the tracking table existed.
    if (migration.isApplied) {
      const applied = await migration.isApplied(db);
      if (applied) {
        await db.execute({
          sql: "INSERT INTO migrations (id) VALUES (?)",
          args: [migration.id],
        });
        continue;
      }
    }

    // Run migration.
    console.log(`Running migration ${migration.id}...`);
    await migration.up(db);

    // D2: FK validation after schema-changing migrations. Non-fatal for
    // now -- migrations that recreate tables with PRAGMA foreign_keys=OFF
    // can produce false-positive FK violations in libsql/Turso because
    // the FK system doesn't always refresh after table renames. Log a
    // warning so we notice real corruption, but don't block startup.
    const fkViolations = await db.execute("PRAGMA foreign_key_check");
    if (fkViolations.rows.length > 0) {
      console.warn(
        `FK check after migration ${migration.id}: ${fkViolations.rows.length} violation(s) detected (non-fatal). Run PRAGMA foreign_key_check manually to verify.`,
      );
    }

    // Track as applied.
    await db.execute({
      sql: "INSERT INTO migrations (id) VALUES (?)",
      args: [migration.id],
    });
    console.log(`Migration ${migration.id} applied.`);
  }
}

// Migration 006 table DDL, indexes, and triggers — applied on fresh installs
// so ensureSchema() on a brand-new DB has the complete schema without
// running the migration. (The nodes table in DDL already includes owner_id,
// lifecycle_state, and goal columns.)
const DDL_MIGRATION_006 = [
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
  TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON,
  TRIGGER_NODES_DERIVE_STATUS_FROM_LIFECYCLE,
  TRIGGER_NODES_VALIDATE_LIFECYCLE_STATE,
];

export async function ensureSchema(): Promise<void> {
  const db = getDb();
  for (const sql of [...DDL, ...DDL_MIGRATION_006, ...SEED]) {
    await db.execute(sql);
  }
  await runMigrations(db);
}
