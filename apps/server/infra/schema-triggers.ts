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

// Migration 015: device_tokens table for agent/MCP auth (Google sub + PATs).
// Declared before DDL so it can be referenced in the array below.
export const DDL_DEVICE_TOKENS = `CREATE TABLE IF NOT EXISTS device_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    label TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    expires_at DATETIME,
    revoked_at DATETIME,
    last_used_at DATETIME,
    headless INTEGER NOT NULL DEFAULT 0 CHECK(headless IN (0,1))
  )`;

export const INDEX_DEVICE_TOKENS_USER = `CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id)`;

// Migration 019: node_access ACL table. Replaces the single
// meta.access_group string with per-node rows so a node can be shared with
// multiple groups/users independently of its coarse `visibility`. Declared
// before DDL so it can be referenced in the array below.
export const DDL_NODE_ACCESS = `CREATE TABLE IF NOT EXISTS node_access (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('group','user')),
    principal TEXT NOT NULL,
    display_email TEXT,
    added_by TEXT NOT NULL,
    added_at DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (node_id, kind, principal)
  )`;

export const INDEX_NODE_ACCESS_NODE = `CREATE INDEX IF NOT EXISTS idx_node_access_node ON node_access(node_id)`;

// Migration 024: in-app access requests for `access_mode='request'` nodes
// (spec: "Rezim omezeni" in 2026-07-04-node-sharing-design.md -- the
// request flow the locked chip was designed to lead to). One pending
// request per (node, user) at a time; resolved rows are kept as history.
// Approval writes a kind='user' node_access grant on the authoritative
// (possibly ancestor) node, see apps/server/api/access-requests.ts.
export const DDL_ACCESS_REQUESTS = `CREATE TABLE IF NOT EXISTS access_requests (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    resolved_at DATETIME,
    resolved_by TEXT
  )`;

export const INDEX_ACCESS_REQUESTS_PENDING = `CREATE UNIQUE INDEX IF NOT EXISTS idx_access_requests_pending
  ON access_requests(node_id, user_id) WHERE status = 'pending'`;

export const INDEX_ACCESS_REQUESTS_STATUS = `CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status)`;

// Migration 025: oauth_grants + oauth_codes for the OAuth 2.1 connector
// facade (spec: docs/superpowers/specs/2026-08-31-oauth-connectors-design.md
// "Data model"). Opaque, sha256-hashed tokens -- same shape as
// device_tokens, plus refresh rotation (prev_refresh_token_hash) and
// single-use authorization codes (grant_id links a redeemed code to the
// grant it minted, for replay detection). Declared before DDL so it can be
// referenced in the array below.
export const DDL_OAUTH_GRANTS = `CREATE TABLE IF NOT EXISTS oauth_grants (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    access_token_hash TEXT NOT NULL,
    access_expires_at DATETIME NOT NULL,
    refresh_token_hash TEXT NOT NULL,
    prev_refresh_token_hash TEXT,
    refresh_expires_at DATETIME NOT NULL,
    resource TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    rotated_at DATETIME,
    revoked_at DATETIME,
    last_used_at DATETIME
  )`;

export const INDEX_OAUTH_GRANTS_USER = `CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id)`;
export const INDEX_OAUTH_GRANTS_ACCESS_HASH = `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_grants_access_hash ON oauth_grants(access_token_hash)`;
export const INDEX_OAUTH_GRANTS_REFRESH_HASH = `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_grants_refresh_hash ON oauth_grants(refresh_token_hash)`;

export const DDL_OAUTH_CODES = `CREATE TABLE IF NOT EXISTS oauth_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    grant_id TEXT REFERENCES oauth_grants(id)
  )`;

export const INDEX_OAUTH_CODES_HASH = `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_codes_hash ON oauth_codes(code_hash)`;

// Migration 027: persistent sessions + session_scope (phase 2 of
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md,
// "Persistent sessions" -- data model sketch). SessionScope (mcp/scope.ts)
// becomes a live cache over these rows via
// apps/server/mcp/session-persistence.ts; the domain module is
// apps/server/domain/sessions.ts. node_id is nullable: interactive_chat
// sessions have no anchor. state's terminal value is 'archived' -- a view
// filter (domain/sessions.ts's autoArchiveClosedSessions), never a delete.
// name/name_is_custom added by migration 028 -- see there for the
// default-name / handoff-enrichment / rename model. node_id is ON DELETE
// SET NULL (migration 030 fixes this on existing DBs): the durable session
// record and its session_scope audit outlive the anchor node's deletion --
// CASCADE here would silently destroy the audit trail the spec calls
// "durable core outlives every CLI's transcript retention by design".
// terminal_id (#218, phase 0 of docs/superpowers/specs/
// 2026-09-01-desktop-multi-window-design.md, "Sessions follow PTY exit"):
// correlates a durable session row with the desktop PTY that spawned its
// CLI (PORTUNI_TERMINAL_ID -> X-Portuni-Terminal header, Claude only for
// now -- see buildClaudeMcpJson). NULL for every non-Claude/non-desktop
// connection. POST /terminals/:terminal_id/exit closes every 'running'
// session sharing a terminal_id when that PTY exits, closing the "rows
// stuck in running" gap the 30-minute idle GC used to be the only backstop
// for.
export const DDL_SESSIONS = `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    session_type TEXT NOT NULL CHECK(session_type IN ('interactive_task','interactive_chat','headless','env')),
    cli TEXT,
    profile_id TEXT,
    agent_session_id TEXT,
    terminal_id TEXT,
    state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','suspended','closed','archived')),
    handoff_path TEXT,
    handoff_hash TEXT,
    name TEXT NOT NULL DEFAULT '',
    name_is_custom INTEGER NOT NULL DEFAULT 0 CHECK(name_is_custom IN (0,1)),
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    last_active_at DATETIME NOT NULL DEFAULT (datetime('now')),
    closed_at DATETIME
  )`;

export const INDEX_SESSIONS_NODE = `CREATE INDEX IF NOT EXISTS idx_sessions_node ON sessions(node_id)`;
export const INDEX_SESSIONS_USER = `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`;
export const INDEX_SESSIONS_STATE = `CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state)`;
export const INDEX_SESSIONS_TERMINAL = `CREATE INDEX IF NOT EXISTS idx_sessions_terminal ON sessions(terminal_id)`;

// One row per (session, node) currently in the session's read-scope set --
// membership, not an append-only event log (an expansion that re-adds an
// already-in-scope node upserts added_via/reason rather than inserting a
// second row). writable mirrors SessionScope.canWrite(node_id).
export const DDL_SESSION_SCOPE = `CREATE TABLE IF NOT EXISTS session_scope (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    added_via TEXT NOT NULL CHECK(added_via IN ('seed','edge','disconnected','created','elicited')),
    reason TEXT,
    writable INTEGER NOT NULL DEFAULT 0 CHECK(writable IN (0,1)),
    added_at DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, node_id)
  )`;

export const INDEX_SESSION_SCOPE_SESSION = `CREATE INDEX IF NOT EXISTS idx_session_scope_session ON session_scope(session_id)`;

// Ground-truth DDL for fresh installs. Includes all CHECK constraints.
// Existing installs get constraints via migrations.
export const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  DDL_DEVICE_TOKENS,
  INDEX_DEVICE_TOKENS_USER,
  DDL_NODE_ACCESS,
  INDEX_NODE_ACCESS_NODE,
  DDL_ACCESS_REQUESTS,
  INDEX_ACCESS_REQUESTS_PENDING,
  INDEX_ACCESS_REQUESTS_STATUS,
  DDL_OAUTH_GRANTS,
  INDEX_OAUTH_GRANTS_USER,
  INDEX_OAUTH_GRANTS_ACCESS_HASH,
  INDEX_OAUTH_GRANTS_REFRESH_HASH,
  DDL_OAUTH_CODES,
  INDEX_OAUTH_CODES_HASH,
  DDL_SESSIONS,
  INDEX_SESSIONS_NODE,
  INDEX_SESSIONS_USER,
  INDEX_SESSIONS_STATE,
  INDEX_SESSIONS_TERMINAL,
  DDL_SESSION_SCOPE,
  INDEX_SESSION_SCOPE_SESSION,
  `CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    type TEXT NOT NULL CHECK(type IN (${NODE_TYPES_SQL})),
    name TEXT NOT NULL,
    description TEXT,
    meta TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (${NODE_STATUSES_SQL})),
    visibility TEXT NOT NULL DEFAULT 'team' CHECK(visibility IN (${NODE_VISIBILITIES_SQL})),
    access_mode TEXT NOT NULL DEFAULT 'private' CHECK(access_mode IN ('private','request')),
    pos_x REAL,
    pos_y REAL,
    owner_id TEXT,
    lifecycle_state TEXT,
    health TEXT NOT NULL DEFAULT 'on_track' CHECK(health IN ('on_track','at_risk','off_track')),
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
    timestamp DATETIME NOT NULL DEFAULT (datetime('now')),
    -- Virtual: costs no storage, exists only so the tombstone lookups below
    -- can be indexed. Every tombstone query filters on the node id buried in
    -- \`detail\`, and no index can cover a json_extract() in a WHERE clause.
    audit_node_id TEXT GENERATED ALWAYS AS (json_extract(detail, '$.node_id')) VIRTUAL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`,
  // File tombstone lookups (sync-info's time-bounded window, and the local
  // matcher's per-candidate-path query) filter on target_type + action and
  // order by timestamp. Without this they are a full table scan of a log
  // that only grows.
  `CREATE INDEX IF NOT EXISTS idx_audit_file_action_ts ON audit_log(target_type, action, timestamp)`,
  // NOTE: the companion index on audit_node_id (idx_audit_file_node_ts) is
  // deliberately NOT here — it references the generated column above, which
  // on an existing pre-033 database does not exist when the DDL loop runs
  // (CREATE TABLE IF NOT EXISTS is a no-op there, so it adds no column).
  // Migration 033 creates the column and the index together. Same reason the
  // 013 sync_key triggers are not in the DDL loop; see schema.ts.
  // Task 6: intents for the remote+local+DB mutations (moveFile, renameFile,
  // renameFolder, deleteFile, deleteFileRemote). A row is written before the
  // first side effect and cleared on success; leftovers are retried
  // idempotently by retryPendingFileOps at the start of every sync run.
  `CREATE TABLE IF NOT EXISTS pending_file_ops (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_file_ops_node ON pending_file_ops(node_id)`,
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
    mime_type TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_files_node ON files(node_id)`,
  // One files row per remote_path (migration 031 dropped remote_name from
  // the key, #201). Concurrent writers (sidecar + tmux server + agents) do
  // SELECT-then-INSERT; without this index a lost race registers the same
  // object twice and a later delete of either row trashes the remote while
  // stranding the other. remote_name is deliberately NOT part of the key:
  // remote_path is derived purely from the node's own identity (section,
  // subpath, filename), never from which remote is routed, so it alone
  // already identifies "the same file" -- a row registered before any
  // remote was configured (remote_name NULL) and the same file registered
  // again after routing resolves must collide on this index so the upsert
  // backfills remote_name onto the existing row instead of duplicating it.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_files_unique_remote
     ON files(node_id, remote_path) WHERE remote_path IS NOT NULL`,
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
    -- created_at is the semantic event date: editable / backdatable so events
    -- can be logged retroactively. It drives ordering, grouping and display.
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    -- logged_at is the immutable technical timestamp: when the row was actually
    -- written. Set once on insert, never overridden. For audit/forensics only.
    logged_at DATETIME NOT NULL DEFAULT (datetime('now'))
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
