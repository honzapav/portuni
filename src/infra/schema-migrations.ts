// Migration system: numbered, idempotent steps that bring an existing
// database up to the current schema. Fresh installs run all migrations
// (most are no-ops because the DDL already creates the target shape).
//
// Each migration has an id, an optional isApplied() probe (used for
// legacy migrations that landed before the migrations tracking table
// existed), and an up() that performs the change. runMigrations is the
// loop that iterates the array.
//
// Split off from schema.ts so the file that has to be edited every time
// we change schema is not 1400 lines long.

import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { slugifyForSyncKey } from "../domain/sync/sync-key.js";
import {
  NODE_TYPES_SQL,
  EDGE_RELATIONS_SQL,
  EVENT_TYPES_SQL,
  NODE_STATUSES_SQL,
  NODE_VISIBILITIES_SQL,
  EVENT_STATUSES_SQL,
  FILE_STATUSES_SQL,
  TRIGGER_PREVENT_MULTI_PARENT_ORG,
  TRIGGER_PREVENT_ORPHAN_ON_EDGE_DELETE,
  TRIGGER_RESPONSIBILITIES_VALID_NODE_TYPE,
  TRIGGER_DATA_SOURCES_VALID_NODE_TYPE,
  TRIGGER_TOOLS_VALID_NODE_TYPE,
  TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON,
  TRIGGER_NODES_DERIVE_STATUS_FROM_LIFECYCLE,
  TRIGGER_NODES_VALIDATE_LIFECYCLE_STATE,
  TRIGGER_NODES_SYNC_KEY_NOT_NULL_INSERT,
  TRIGGER_NODES_SYNC_KEY_NOT_NULL_UPDATE,
  DDL_ACTORS_TABLE,
  DDL_RESPONSIBILITIES_TABLE,
  DDL_RESPONSIBILITY_ASSIGNMENTS_TABLE,
  DDL_DATA_SOURCES_TABLE,
  DDL_TOOLS_TABLE,
  DDL_REMOTES_TABLE,
  DDL_REMOTE_ROUTING_TABLE,
  INDEX_REMOTE_ROUTING_PRIORITY,
  SEED_LIFECYCLE_STATE_FROM_STATUS,
} from "./schema-triggers.js";

interface Migration {
  id: string;
  // For legacy migrations: detect if already applied before the migrations
  // table existed. Return true to skip and just mark as applied.
  isApplied?: (db: Client) => Promise<boolean>;
  up: (db: Client) => Promise<void>;
}

// Migration 009 runner. Idempotent via IF NOT EXISTS clauses.
export async function runMigration009(db: Client): Promise<void> {
  await db.execute(DDL_REMOTES_TABLE);
  await db.execute(DDL_REMOTE_ROUTING_TABLE);
  await db.execute(INDEX_REMOTE_ROUTING_PRIORITY);
}

// Migration 013: nodes.sync_key (immutable path identity).
//
// 1. Add `sync_key TEXT` column (nullable initially — ALTER TABLE limit).
// 2. Backfill existing rows with collision-free slugs derived from name.
// 3. Install a partial UNIQUE index (`WHERE sync_key IS NOT NULL`).
// 4. Install BEFORE INSERT/UPDATE triggers that reject NULL or empty
//    string, giving the column the same enforcement as NOT NULL without
//    rebuilding the table.
//
// Idempotent and recoverable: each step checks current state before acting.
export async function runMigration013(db: Client): Promise<void> {
  const info = await db.execute("PRAGMA table_info(nodes)");
  const cols = new Set(info.rows.map((r) => r.name as string));

  if (!cols.has("sync_key")) {
    await db.execute("ALTER TABLE nodes ADD COLUMN sync_key TEXT");
  }

  // Backfill rows with NULL sync_key, deterministic order so re-runs match.
  const nullRows = await db.execute(
    "SELECT id, name FROM nodes WHERE sync_key IS NULL ORDER BY created_at ASC",
  );
  if (nullRows.rows.length > 0) {
    const existing = await db.execute(
      "SELECT sync_key FROM nodes WHERE sync_key IS NOT NULL",
    );
    const used = new Set<string>(existing.rows.map((r) => r.sync_key as string));
    for (const row of nullRows.rows) {
      const name = row.name as string;
      const id = row.id as string;
      const base = slugifyForSyncKey(name);
      let key = base.length > 0 ? base : `node-${ulid().toLowerCase().slice(-8)}`;
      while (used.has(key)) {
        key = `${base.length > 0 ? base : "node"}-${ulid().toLowerCase().slice(-6)}`;
      }
      used.add(key);
      await db.execute({
        sql: "UPDATE nodes SET sync_key = ? WHERE id = ?",
        args: [key, id],
      });
    }
  }

  await db.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_sync_key ON nodes(sync_key) WHERE sync_key IS NOT NULL",
  );

  await db.execute(TRIGGER_NODES_SYNC_KEY_NOT_NULL_INSERT);
  await db.execute(TRIGGER_NODES_SYNC_KEY_NOT_NULL_UPDATE);
}

// Migration 011: drop the legacy Turso `local_mirrors` table. Per-device
// mirror paths now live exclusively in the local sync.db. Safe to run on
// any DB (DROP TABLE IF EXISTS is a no-op when the table is already gone).
export async function runMigration011(db: Client): Promise<void> {
  await db.execute("DROP TABLE IF EXISTS local_mirrors");
}

// Migration 012: drop the legacy `files.local_path` column.
//
// The path on the current device is now derived from the per-device mirror
// root + remote_path + sync_key at read time, so the persisted column is
// redundant and (worse) goes stale across devices and renames. libSQL /
// SQLite 3.35+ supports native ALTER TABLE DROP COLUMN; we gate on
// PRAGMA table_info so the migration is idempotent.
export async function runMigration012(db: Client): Promise<void> {
  const info = await db.execute("PRAGMA table_info(files)");
  const cols = new Set(info.rows.map((r) => r.name as string));
  if (cols.has("local_path")) {
    await db.execute("ALTER TABLE files DROP COLUMN local_path");
  }
}

// Migration 010: additively extend `files` with the columns needed to track
// the remote source-of-truth. Does NOT drop `local_path` — that happens in
// a later plan (migration 012). Each ALTER is gated by a column-existence
// check so the migration is safe to re-run.
export async function runMigration010(db: Client): Promise<void> {
  const info = await db.execute("PRAGMA table_info(files)");
  const existing = new Set(info.rows.map((r) => r.name as string));
  const additions: Array<[string, string]> = [
    ["remote_name", "ALTER TABLE files ADD COLUMN remote_name TEXT"],
    ["remote_path", "ALTER TABLE files ADD COLUMN remote_path TEXT"],
    ["current_remote_hash", "ALTER TABLE files ADD COLUMN current_remote_hash TEXT"],
    ["last_pushed_by", "ALTER TABLE files ADD COLUMN last_pushed_by TEXT"],
    ["last_pushed_at", "ALTER TABLE files ADD COLUMN last_pushed_at DATETIME"],
    ["is_native_format", "ALTER TABLE files ADD COLUMN is_native_format INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [col, sql] of additions) {
    if (!existing.has(col)) await db.execute(sql);
  }
}

// Migration 006: add actors, responsibilities, responsibility_assignments,
// data_sources, tools; add owner_id/lifecycle_state/goal columns to nodes;
// install validation + lifecycle-derivation triggers; seed lifecycle_state.
export async function runMigration006(db: Client): Promise<void> {
  // 1. actors table + indexes. Actors are global (no org_id, no description);
  // external_id is unique across the whole registry when set.
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

  // 7. (legacy) Owner validation trigger — dropped by migration 014.
  // Owners may now be any actor; FK already enforces existence.

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
  {
    id: "006_people_responsibilities",
    isApplied: async (db) => {
      // Check BOTH the new table AND the three new columns on nodes.
      // DDL_MIGRATION_006 runs before this migration during ensureSchema()
      // and unconditionally creates the `actors` table, so checking only
      // that table would spuriously report "applied" on databases where
      // the ALTER TABLE statements never ran.
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
  {
    id: "007_actors_cross_org",
    isApplied: async (db) => {
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
        await db.execute("DROP TRIGGER IF EXISTS actors_org_must_be_organization");
        await db.execute("DROP TRIGGER IF EXISTS nodes_owner_must_be_real_person");
        await db.execute("DROP INDEX IF EXISTS idx_actors_org");
        await db.execute("DROP INDEX IF EXISTS idx_actors_org_external");

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

        await db.execute("CREATE INDEX IF NOT EXISTS idx_actors_type ON actors(type)");
        await db.execute(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_external ON actors(external_id) WHERE external_id IS NOT NULL",
        );

        await db.execute(TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON);
      } finally {
        await db.execute("PRAGMA foreign_keys = ON");
      }
    },
  },

  // Migration 008: drop actors.description.
  {
    id: "008_actors_drop_description",
    isApplied: async (db) => {
      const tableCheck = await db.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='actors'",
        args: [],
      });
      if (tableCheck.rows.length === 0) return false;
      const info = await db.execute("PRAGMA table_info(actors)");
      const cols = new Set(info.rows.map((r) => r.name as string));
      return !cols.has("description");
    },
    up: async (db) => {
      await db.execute("PRAGMA foreign_keys = OFF");
      try {
        await db.execute("DROP TRIGGER IF EXISTS nodes_owner_must_be_real_person");
        await db.execute("DROP INDEX IF EXISTS idx_actors_type");
        await db.execute("DROP INDEX IF EXISTS idx_actors_external");

        await db.execute(`CREATE TABLE actors_new (
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
        )`);
        await db.execute(`INSERT INTO actors_new (
          id, type, name, is_placeholder, user_id, notes, external_id, created_at, updated_at
        ) SELECT
          id, type, name, is_placeholder, user_id, notes, external_id, created_at, updated_at
        FROM actors`);
        await db.execute("DROP TABLE actors");
        await db.execute("ALTER TABLE actors_new RENAME TO actors");

        await db.execute("CREATE INDEX IF NOT EXISTS idx_actors_type ON actors(type)");
        await db.execute(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_external ON actors(external_id) WHERE external_id IS NOT NULL",
        );
        await db.execute(TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON);
      } finally {
        await db.execute("PRAGMA foreign_keys = ON");
      }
    },
  },

  // Migration 009: pluggable remote backends + routing rules.
  {
    id: "009_remotes_and_routing",
    isApplied: async (db) => {
      const r = await db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='remotes'",
      );
      if (r.rows.length === 0) return false;
      const r2 = await db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='remote_routing'",
      );
      return r2.rows.length > 0;
    },
    up: runMigration009,
  },

  // Migration 010: extend `files` with the columns needed to track the
  // remote source-of-truth. Additive only.
  {
    id: "010_files_remote_columns",
    isApplied: async (db) => {
      const info = await db.execute("PRAGMA table_info(files)");
      const cols = new Set(info.rows.map((r) => r.name as string));
      return [
        "remote_name",
        "remote_path",
        "current_remote_hash",
        "last_pushed_by",
        "last_pushed_at",
        "is_native_format",
      ].every((c) => cols.has(c));
    },
    up: runMigration010,
  },

  // Migration 011: drop the legacy Turso `local_mirrors` table.
  {
    id: "011_drop_turso_local_mirrors",
    isApplied: async (db) => {
      const r = await db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='local_mirrors'",
      );
      return r.rows.length === 0;
    },
    up: runMigration011,
  },

  // Migration 012: drop the legacy `files.local_path` column.
  {
    id: "012_drop_files_local_path",
    isApplied: async (db) => {
      const info = await db.execute("PRAGMA table_info(files)");
      const cols = new Set(info.rows.map((r) => r.name as string));
      return !cols.has("local_path");
    },
    up: runMigration012,
  },

  // Migration 013: nodes.sync_key (immutable path identity).
  {
    id: "013_nodes_sync_key",
    isApplied: async (db) => {
      const info = await db.execute("PRAGMA table_info(nodes)");
      const cols = new Set(info.rows.map((r) => r.name as string));
      if (!cols.has("sync_key")) return false;
      const nulls = await db.execute(
        "SELECT COUNT(*) AS c FROM nodes WHERE sync_key IS NULL",
      );
      if (Number(nulls.rows[0].c) > 0) return false;
      const idx = await db.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_nodes_sync_key'",
      );
      if (idx.rows.length === 0) return false;
      const trg = await db.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='nodes_sync_key_not_null_insert'",
      );
      return trg.rows.length > 0;
    },
    up: runMigration013,
  },

  // Migration 014: drop the "owner must be a real registered person" trigger.
  // Owners may now be any actor; FK on owner_id already guarantees existence.
  {
    id: "014_drop_owner_real_person_trigger",
    isApplied: async (db) => {
      const r = await db.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='nodes_owner_must_be_real_person'",
      );
      return r.rows.length === 0;
    },
    up: async (db) => {
      await db.execute("DROP TRIGGER IF EXISTS nodes_owner_must_be_real_person");
    },
  },
];

export async function runMigrations(db: Client): Promise<void> {
  // Ensure the migrations table exists (DDL already has it for fresh
  // installs, but this covers databases created before the table existed).
  await db.execute(
    `CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
    )`,
  );

  for (const migration of MIGRATIONS) {
    const tracked = await db.execute({
      sql: "SELECT id FROM migrations WHERE id = ?",
      args: [migration.id],
    });
    if (tracked.rows.length > 0) continue;

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

    console.log(`Running migration ${migration.id}...`);
    await migration.up(db);

    // FK validation after schema-changing migrations. Non-fatal — migrations
    // that recreate tables with PRAGMA foreign_keys=OFF can produce
    // false-positive FK violations in libsql/Turso because the FK system
    // doesn't always refresh after table renames.
    const fkViolations = await db.execute("PRAGMA foreign_key_check");
    if (fkViolations.rows.length > 0) {
      console.warn(
        `FK check after migration ${migration.id}: ${fkViolations.rows.length} violation(s) detected (non-fatal). Run PRAGMA foreign_key_check manually to verify.`,
      );
    }

    await db.execute({
      sql: "INSERT INTO migrations (id) VALUES (?)",
      args: [migration.id],
    });
    console.log(`Migration ${migration.id} applied.`);
  }
}
