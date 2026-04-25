# Portuni

Portuni is a shared map of how your organization works – its processes, projects, areas, and principles – held as one graph that every tool and every AI agent can read. People and agents draw from the same picture instead of rebuilding context from scratch in every app.

Built for teams. TypeScript, Turso (shared team database) or local SQLite (solo / testing), Streamable HTTP. MCP is how agents plug in.

## Setup

```bash
npm install
npm run build
```

### Environment

Managed via Varlock. See `.env.schema` for the authoritative list.

- `PORTUNI_WORKSPACE_ROOT` (required) – root for local mirror folders (e.g. `~/Workspaces/portuni`)
- `TURSO_URL` – Turso database URL. Required for team setups. Leave empty only when running Portuni locally for testing or solo use (falls back to a local SQLite file at `./portuni.db`).
- `TURSO_AUTH_TOKEN` – Turso auth token. Required together with `TURSO_URL`.
- `PORTUNI_USER_EMAIL` (optional, default `solo@localhost`) – solo user email for Phase 1 single-user mode
- `PORTUNI_USER_NAME` (optional, default `Solo User`) – solo user display name

**Team vs solo.** Portuni is primarily a team tool. A shared Turso database is the only way multiple users can work against the same graph; the local SQLite mode exists so you can try Portuni out, develop against it, or run a personal graph, but it does not scale beyond a single machine. Plan to move to Turso as soon as more than one person needs the graph.

### Run

```bash
npx varlock run -- npm start       # production (dist/)
npx varlock run -- npm run dev     # development (tsx)
```

Server: `http://localhost:4011` (override with `PORT` env var).

Recommended: run in tmux session:

```bash
tmux new-session -d -s portuni 'cd ~/Dev/projekty/portuni && npx varlock run -- npm run dev'
```

### Tests

```bash
npm test
```

Uses `node:test` + tsx. No external test runner.

## Claude Code integration

Global MCP (`~/.claude.json`):

```json
{
  "mcpServers": {
    "portuni": {
      "type": "http",
      "url": "http://localhost:4011/mcp"
    }
  }
}
```

SessionStart hook (`~/.claude/settings.json`): `scripts/portuni-context.sh` -- injects graph context when cwd is a Portuni workspace folder.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP protocol (Streamable HTTP) |
| `/context?path=...` | GET | Resolve filesystem path to graph node |
| `/health` | GET | Health check |

## MCP tools

**Graph (17)**

| Tool | Description |
|------|-------------|
| `portuni_create_node` | Create node (accepts optional `goal`, `lifecycle_state`) |
| `portuni_update_node` | Update node (accepts `goal`, `lifecycle_state`, `owner_id`) |
| `portuni_move_node` | Reparent a node under a different parent |
| `portuni_delete_node` | Soft-delete or purge a node (purge cascades file removal) |
| `portuni_list_nodes` | List/filter nodes |
| `portuni_get_node` | Node detail with edges, files, events, owner, responsibilities, data sources, tools, mirror |
| `portuni_connect` | Create edge |
| `portuni_disconnect` | Remove edge(s) |
| `portuni_get_context` | Recursive graph traversal (enriched with owner/responsibilities/data sources/tools at depth 0) |
| `portuni_log` | Log event on node |
| `portuni_resolve` | Resolve event |
| `portuni_supersede` | Replace event |
| `portuni_list_events` | Query events |
| `portuni_mirror` | Create local folder for node and auto-scaffold the matching remote folder |
| `portuni_store` | Push a local file to the node's remote and register it |
| `portuni_pull` | Download a tracked file from the remote into the local mirror |
| `portuni_list_files` | List tracked files across nodes |

**File sync (10)** -- pluggable remote storage backed by hash identity and per-device state. See "File sync" section below.

| Tool | Description |
|------|-------------|
| `portuni_status` | Show sync state for a node: tracked + new local + new remote, with conflict classification |
| `portuni_snapshot` | Capture a point-in-time view of remote state for diagnostics |
| `portuni_setup_remote` | Register a remote (gdrive / dropbox / s3 / fs / webdav / sftp) with its config |
| `portuni_set_routing_policy` | Map (`node_type`, `org_slug`) -> remote with priority ordering |
| `portuni_list_remotes` | List configured remotes and their routing rules |
| `portuni_move_file` | Move a tracked file to a different node and/or path (confirm-first) |
| `portuni_rename_folder` | Rename a node's remote folder; updates `sync_key`-anchored paths atomically |
| `portuni_delete_file` | Delete a tracked file locally + remotely (confirm-first) |
| `portuni_adopt_files` | Adopt untracked files already present in the remote into the graph |

**Actors, responsibilities, tools (17)** -- distribution of work across people and automations.

| Tool | Description |
|------|-------------|
| `portuni_create_actor` | Create a person or automation actor in an organization |
| `portuni_update_actor` | Update actor name/description/notes/placeholder/user link |
| `portuni_list_actors` | List actors, filter by org/type/placeholder |
| `portuni_get_actor` | Get actor + their responsibility assignments across entities |
| `portuni_archive_actor` | Hard-delete actor (cascades assignments) |
| `portuni_create_responsibility` | Create responsibility (unit of work) on project/process/area with optional initial assignees |
| `portuni_update_responsibility` | Update title/description/sort order |
| `portuni_delete_responsibility` | Delete responsibility (cascades assignments) |
| `portuni_list_responsibilities` | List responsibilities, filter by node or actor |
| `portuni_assign_responsibility` | Attach actor to responsibility (idempotent) |
| `portuni_unassign_responsibility` | Remove actor from responsibility |
| `portuni_add_data_source` | Attach a data source (CRM, BQ, report) to project/process/area |
| `portuni_remove_data_source` | Remove a data source |
| `portuni_list_data_sources` | List data sources for a node |
| `portuni_add_tool` | Attach a tool (Asana, Figma, ...) to project/process/area |
| `portuni_remove_tool` | Remove a tool |
| `portuni_list_tools` | List tools for a node |

### Aktéři, úlohy, stav entit

Portuni mapuje nejen strukturu organizace, ale také distribuci odpovědností:

- **Aktéři** (lidé a automatizace) -- registr per organizace. Lidé mohou být reální nebo placeholder (hiring need). Automatizace jsou pojmenované funkční jednotky bez technických detailů.
- **Úlohy** (responsibilities) na entitě (project/process/area) -- jednotka práce, kterou někdo vykonává. M:N přiřazení k aktérům. Úloha bez assignee = validní "tohle se musí dělat, ale zatím nikdo".
- **Vlastník** entity -- explicit FK na aktéra typu person s `user_id` (reálný registrovaný uživatel, ne placeholder, ne automatizace).
- **Lifecycle_state** (type-specific) -- primární viditelný stav entity, color-coded ve frontendu. Coarse `status` (active/completed/archived) je derivovaný triggerem.
- **Účel** entity, **datové zdroje**, **nástroje** -- kontext, co entita dělá a s čím pracuje. `external_link` je plain URL, nikdy connection string s credentials.

## File sync

Files attached to graph nodes (reports, transcripts, code, notes) travel with the graph through a pluggable sync layer. Phase 1 ships with a Google Drive (Service Account) adapter; the adapter interface (`src/sync/`) is backend-agnostic and designed for Dropbox, S3, WebDAV, SFTP, or local filesystem implementations.

**Core concepts**

- **Hash is identity.** Files are identified by content hash (SHA-256 local, MD5 from remote metadata where available). Paths and names are labels; conflicts are deterministic, moves are free.
- **Two-layer state.** Shared canonical state lives in Turso (`files.current_remote_hash`). Per-device memory of "what I last saw" lives in a local SQLite at `~/.portuni/sync.db`. No `device_id` columns; each machine owns its cache.
- **`sync_key` anchors paths.** Every node has an immutable, slugified `sync_key` (migration 013). All filesystem and remote paths are derived from it, so renaming a node never breaks the mirror.
- **Routing policy.** Remote selection is data-driven via `remotes` and `remote_routing` tables. Priority-ordered rules map (`node_type`, `org_slug`) -> remote name with `NULL` wildcards.
- **TokenStore tiers.** Per-device credentials use a pluggable store: `file` (default, mode 0600), `keychain` (OS-level), or `varlock` (PM integration). Service Account JSON never lives in Turso.
- **Confirm-first ops.** Destructive tools (`portuni_delete_file`, `portuni_move_file`, `portuni_rename_folder`) require explicit confirmation and report `repair_needed` semantics for partial failures.

**Phase 1 limitations**

- Service Account auth only (no OAuth user flow yet). Drive remotes must be **Shared Drives** -- "My Drive" is not supported because Service Accounts cannot own files there.
- One user across N devices is the validated topology. Small-team multi-user works through shared SA, but per-user OAuth and domain-wide delegation are roadmap.

The user-facing summary lives at `src/sync/README.md`.

## Project structure

```
src/
  server.ts          HTTP server, MCP setup, /context, /health
  schema.ts          DDL, ensureSchema(), SOLO_USER, migrations
  db.ts              libsql client (Turso for team, local SQLite fallback for solo)
  audit.ts           Audit logging helper
  types.ts           Zod row schemas for all DB tables
  sync/              Pluggable file-sync layer (see src/sync/README.md)
    engine.ts          hash diff, status scan, store/pull, conflict classification
    adapter-cache.ts   per-remote FileAdapter instance cache
    drive-adapter.ts   Google Drive backend (Service Account)
    drive-sa-auth.ts   SA JSON loader + token mint
    drive-config.ts    shared-drive resolution
    opendal-adapter.ts OpenDAL-backed adapter (future-facing)
    routing.ts         remote selection from remote_routing table
    sync-key.ts        immutable node identifier helpers
    remote-path.ts     sync_key + org_slug -> remote path
    mirror-registry.ts per-device local_mirrors (sync.db) wrapper
    local-db.ts        per-device SQLite at ~/.portuni/sync.db
    hash.ts            SHA-256 / MD5 normalization
    native-format.ts   Drive native-format (Docs/Sheets) detection
    token-store-{file,keychain,varlock}.ts  per-device credential tiers
    device-tokens.ts   TokenStore facade for the engine
  tools/
    nodes.ts           create, update, move, delete, list
    get-node.ts        get (with edges, files, events, mirror)
    edges.ts           connect, disconnect
    context.ts         get_context (recursive CTE)
    mirrors.ts         portuni_mirror (auto-scaffold remote folder)
    files.ts           store, pull, list_files, move_file, delete_file, rename_folder, adopt_files
    sync-status.ts     portuni_status
    sync-snapshot.ts   portuni_snapshot
    sync-remotes.ts    setup_remote, set_routing_policy, list_remotes
    actors.ts          actor + responsibility tools
    responsibilities.ts
    entity-attributes.ts data_sources, tools
    events.ts          log, resolve, supersede, list_events
scripts/
  portuni-context.sh   SessionStart hook
  bulk-promote.ts      Promote untracked local files into tracked files
  cleanup-ignored-files.ts  Remove .portuniignore-matched files from remote + DB
  move-rogue-files.ts  Reorganize mirror tree (root files -> wip/, custom dirs -> resources/)
test/
  schema-types.test.ts    DDL vs Zod schema validation
  events.test.ts          Event lifecycle tests
  migration-*.test.ts     Per-migration invariants (006, 009, 010, 011, 012, 013)
  sync-*.test.ts          Sync engine, Drive adapter, two-device regressions
```

## Database

Two deployment modes, same schema:

- **Team / production:** Turso (libsql cloud) via `TURSO_URL` + `TURSO_AUTH_TOKEN`. This is the intended long-term mode – a shared cloud database is what lets multiple users and agents operate against the same graph.
- **Solo / testing:** local SQLite at `./portuni.db`, used automatically when `TURSO_URL` is empty. Good for trying Portuni out or running a personal graph on one machine; does not scale beyond that.

Schema auto-migrated on startup via `ensureSchema()` in both modes.

### Tables (Turso / shared)

| Table | Purpose |
|-------|---------|
| `users` | Registered users (single solo user in Phase 1). |
| `nodes` | POPP entities. New column `sync_key` (immutable, slugified, unique) anchors filesystem and remote paths so renames do not break sync. |
| `edges` | Typed relations between nodes. |
| `events` | Time-ordered knowledge attached to nodes. |
| `files` | File metadata bound to a node + remote. New columns: `remote_name`, `remote_path`, `current_remote_hash`, `last_pushed_by`, `last_pushed_at`, `is_native_format`. The legacy `local_path` column was removed (migration 012); the path on the current device is derived from the per-device mirror + `remote_path` + `sync_key` at read time. |
| `remotes` | Pluggable remote backends (gdrive, dropbox, s3, fs, webdav, sftp). One row per configured remote. |
| `remote_routing` | Priority-ordered routing rules that map (`node_type`, `org_slug`) to a remote. Wildcards via `NULL`. |
| `audit_log` | Append-only audit trail of every mutation. |
| `actors`, `responsibilities`, `responsibility_assignments`, `data_sources`, `tools` | People/automation registry and the distribution of work over POPP entities. |

The shared DB no longer stores per-device mirror paths. Each device keeps
its own mirror registry in a local SQLite at `~/.portuni/sync.db`
(see `src/sync/local-db.ts`); migration 011 dropped the legacy Turso
`local_mirrors` table.
