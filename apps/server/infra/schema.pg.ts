// Postgres baseline DDL (batch B, docs/superpowers/plans/2026-09-12-infra-batch.md,
// B2). Mirrors the libsql schema as it exists after migration 036
// (schema-migrations.ts's highest id at the time of writing) -- i.e. every
// table/column/index a FRESH libsql install ends up with once
// ensureSchemaOn's DDL replay + full migration pass both finish, not a
// literal replay of the 35 migrations themselves (most of which only exist
// to bring an OLD sqlite database up to that same shape; see
// schema-migrations.ts's own "most are no-ops on a fresh install" comment).
// Triggers live in schema-triggers.pg.ts; applied together as the single
// `pg-001` migration (infra/migrations/pg.ts).
//
// Translation rules applied throughout, consistently:
// - DATETIME -> TIMESTAMPTZ; DEFAULT (datetime('now')) -> DEFAULT now().
// - REAL (SQLite's REAL is 8-byte, same precision as Postgres's own
//   double precision) -> DOUBLE PRECISION.
// - INTEGER ... CHECK(x IN (0,1)) booleans are kept as-is (not converted to
//   BOOLEAN) -- every call site still writes/reads 0/1, and that conversion
//   is dialect-neutral-SQL work (B3), out of scope here.
// - INTEGER PRIMARY KEY AUTOINCREMENT -> INTEGER GENERATED ALWAYS AS
//   IDENTITY PRIMARY KEY (remote_routing.id, the only site).
// - CHECK(json_valid(x)) -> CHECK(x::jsonb IS NOT NULL) (invalid JSON fails
//   the INSERT with a cast error rather than a constraint violation, same
//   net effect: the row is rejected).
// - A SQLite GENERATED ... VIRTUAL column (audit_log.audit_node_id, whose
//   source is `json_extract(detail, '$.node_id')`) becomes GENERATED
//   ALWAYS AS (...) STORED -- Postgres has no virtual generated columns
//   before PG18; STORED is transparent to every reader either way.
// - CHECK(length(id) = 26) is unchanged -- length() means the same thing
//   in both dialects for a TEXT column.
//
// One deliberate schema difference, per the issue: session_events' primary
// key is (session_id, seq) here, not a bare `id` column -- efficient
// per-session retention deletes and the natural read order the live
// channel and event-retention sweep both want. `id` stays a plain NOT NULL
// column (ulid()-generated, read by SessionEventRow, never looked up by
// itself) rather than the primary key.

import {
  NODE_TYPES,
  EDGE_RELATIONS,
  EVENT_TYPES,
  NODE_STATUSES,
  NODE_VISIBILITIES,
  EVENT_STATUSES,
  FILE_STATUSES,
} from "../shared/popp.js";

const sqlEnumList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(",");

const NODE_TYPES_SQL = sqlEnumList(NODE_TYPES);
const EDGE_RELATIONS_SQL = sqlEnumList(EDGE_RELATIONS);
const EVENT_TYPES_SQL = sqlEnumList(EVENT_TYPES);
const NODE_STATUSES_SQL = sqlEnumList(NODE_STATUSES);
const NODE_VISIBILITIES_SQL = sqlEnumList(NODE_VISIBILITIES);
const EVENT_STATUSES_SQL = sqlEnumList(EVENT_STATUSES);
const FILE_STATUSES_SQL = sqlEnumList(FILE_STATUSES);

// Table order is a topological sort of the FK graph -- Postgres, unlike
// SQLite, requires a referenced table to already exist at CREATE TABLE
// time (no forward references).
export const PG_BASELINE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Migration 016 on the libsql side (per-user identity, Google auth).
    google_sub TEXT,
    avatar_url TEXT,
    last_login_at TIMESTAMPTZ
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    type TEXT NOT NULL CHECK(type IN (${NODE_TYPES_SQL})),
    name TEXT NOT NULL,
    description TEXT,
    meta TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (${NODE_STATUSES_SQL})),
    visibility TEXT NOT NULL DEFAULT 'team' CHECK(visibility IN (${NODE_VISIBILITIES_SQL})),
    access_mode TEXT NOT NULL DEFAULT 'private' CHECK(access_mode IN ('private','request')),
    pos_x DOUBLE PRECISION,
    pos_y DOUBLE PRECISION,
    -- No FK on owner_id: the fresh libsql DDL doesn't have one either (only
    -- migration 006's ALTER on an upgraded DB adds
    -- REFERENCES actors(id) ON DELETE SET NULL) -- faithfully ported as-is,
    -- not a place to fix a pre-existing inconsistency in this batch.
    owner_id TEXT,
    lifecycle_state TEXT,
    health TEXT NOT NULL DEFAULT 'on_track' CHECK(health IN ('on_track','at_risk','off_track')),
    goal TEXT,
    sync_key TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK(updated_at >= created_at)
  )`,
  // Migration 013 on the libsql side: sync_key uniqueness is a partial
  // index (empty-string rejection is a trigger, schema-triggers.pg.ts).
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_sync_key ON nodes(sync_key) WHERE sync_key IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS device_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    label TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    headless INTEGER NOT NULL DEFAULT 0 CHECK(headless IN (0,1))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id)`,

  `CREATE TABLE IF NOT EXISTS node_access (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('group','user')),
    principal TEXT NOT NULL,
    display_email TEXT,
    added_by TEXT NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (node_id, kind, principal)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_node_access_node ON node_access(node_id)`,

  `CREATE TABLE IF NOT EXISTS access_requests (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_access_requests_pending ON access_requests(node_id, user_id) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status)`,

  `CREATE TABLE IF NOT EXISTS oauth_grants (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    access_token_hash TEXT NOT NULL,
    access_expires_at TIMESTAMPTZ NOT NULL,
    refresh_token_hash TEXT NOT NULL,
    prev_refresh_token_hash TEXT,
    refresh_expires_at TIMESTAMPTZ NOT NULL,
    resource TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_grants_access_hash ON oauth_grants(access_token_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_grants_refresh_hash ON oauth_grants(refresh_token_hash)`,

  `CREATE TABLE IF NOT EXISTS oauth_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    grant_id TEXT REFERENCES oauth_grants(id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_codes_hash ON oauth_codes(code_hash)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    session_type TEXT NOT NULL CHECK(session_type IN ('interactive_task','interactive_chat','headless','env')),
    cli TEXT,
    instance_id TEXT,
    agent_session_id TEXT,
    terminal_id TEXT,
    brief TEXT,
    runner TEXT,
    host_id TEXT,
    waiting_since TEXT,
    state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','suspended','closed','archived','draft')),
    handoff_path TEXT,
    handoff_hash TEXT,
    handoff_inline TEXT,
    name TEXT NOT NULL DEFAULT '',
    name_is_custom INTEGER NOT NULL DEFAULT 0 CHECK(name_is_custom IN (0,1)),
    model TEXT,
    effort TEXT CHECK(effort IS NULL OR effort IN ('low','medium','high','xhigh','max')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_node ON sessions(node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_terminal ON sessions(terminal_id)`,

  `CREATE TABLE IF NOT EXISTS session_runs (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    runner TEXT NOT NULL,
    instance_id TEXT,
    host_id TEXT,
    agent_session_id TEXT,
    resumed_from_run_id TEXT REFERENCES session_runs(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    end_reason TEXT CHECK(end_reason IN ('completed','interrupted','suspended','error','limit','host_lost')),
    usage TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_runs_session ON session_runs(session_id)`,

  // (session_id, seq) primary key -- see the file header. `id` stays a
  // plain, non-unique-constrained NOT NULL column.
  `CREATE TABLE IF NOT EXISTS session_events (
    id TEXT NOT NULL CHECK(length(id) = 26),
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES session_runs(id) ON DELETE SET NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, seq)
  )`,

  `CREATE TABLE IF NOT EXISTS session_scope (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    added_via TEXT NOT NULL CHECK(added_via IN ('seed','edge','disconnected','created','elicited')),
    reason TEXT,
    writable INTEGER NOT NULL DEFAULT 0 CHECK(writable IN (0,1)),
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, node_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_scope_session ON session_scope(session_id)`,

  `CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL CHECK(relation IN (${EDGE_RELATIONS_SQL})),
    meta TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    audit_node_id TEXT GENERATED ALWAYS AS ((detail::jsonb ->> 'node_id')) STORED
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_file_action_ts ON audit_log(target_type, action, timestamp)`,
  // Migration 033 on the libsql side.
  `CREATE INDEX IF NOT EXISTS idx_audit_file_node_ts ON audit_log(audit_node_id, timestamp DESC) WHERE target_type = 'file'`,

  `CREATE TABLE IF NOT EXISTS pending_file_ops (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_file_ops_node ON pending_file_ops(node_id)`,

  // Remote watcher (#338). Migration 037 on the libsql side.
  `CREATE TABLE IF NOT EXISTS remote_cursors (
    remote_name TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS remote_folder_cache (
    remote_name TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    path TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (remote_name, folder_id)
  )`,

  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    remote_name TEXT,
    remote_path TEXT,
    current_remote_hash TEXT,
    last_pushed_by TEXT,
    last_pushed_at TIMESTAMPTZ,
    is_native_format INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'wip' CHECK(status IN (${FILE_STATUSES_SQL})),
    mime_type TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_files_node ON files(node_id)`,
  // Migration 031 on the libsql side: remote_name deliberately dropped from
  // the key (#201) -- see the libsql DDL's own comment for the full reason.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_files_unique_remote ON files(node_id, remote_path) WHERE remote_path IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN (${EVENT_TYPES_SQL})),
    content TEXT NOT NULL,
    meta TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (${EVENT_STATUSES_SQL})),
    refs TEXT CHECK(refs IS NULL OR refs::jsonb IS NOT NULL),
    task_ref TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)`,

  // Shared by both the pg-native migration framework (infra/migrations/pg.ts)
  // and, on the libsql side, schema-migrations.ts -- same table shape,
  // disjoint id namespaces ("pg-NNN" here vs "NNN_name" there), never both
  // populated in the same database.
  `CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS remotes (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('gdrive','dropbox','s3','fs','webdav','sftp')),
    config_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // BY DEFAULT, not ALWAYS: the Postgres cutover import tool (#334,
  // scripts/db-import.ts) inserts rows with their original exported id --
  // GENERATED ALWAYS rejects any explicit value outright. BY DEFAULT
  // accepts one (falling back to the sequence only when omitted), matching
  // SQLite's own AUTOINCREMENT, which always allowed an explicit id.
  `CREATE TABLE IF NOT EXISTS remote_routing (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    priority INTEGER NOT NULL,
    node_type TEXT,
    org_slug TEXT,
    remote_name TEXT NOT NULL REFERENCES remotes(name) ON DELETE RESTRICT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_remote_routing_priority ON remote_routing(priority)`,

  // Migration 006 on the libsql side (actors/responsibilities/data_sources/tools).
  `CREATE TABLE IF NOT EXISTS actors (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    type TEXT NOT NULL CHECK(type IN ('person','automation')),
    name TEXT NOT NULL,
    is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK(is_placeholder IN (0,1)),
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    notes TEXT,
    external_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK(type = 'person' OR (is_placeholder = 0 AND user_id IS NULL))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_actors_type ON actors(type)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_actors_external ON actors(external_id) WHERE external_id IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS responsibilities (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_responsibilities_node ON responsibilities(node_id)`,

  `CREATE TABLE IF NOT EXISTS responsibility_assignments (
    responsibility_id TEXT NOT NULL REFERENCES responsibilities(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (responsibility_id, actor_id)
  )`,

  `CREATE TABLE IF NOT EXISTS data_sources (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    external_link TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_data_sources_node ON data_sources(node_id)`,

  `CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    external_link TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tools_node ON tools(node_id)`,
];
