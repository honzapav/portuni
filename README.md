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

Server: `http://localhost:3001` (override with `PORT` env var).

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
      "url": "http://localhost:3001/mcp"
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

**Graph (15)**

| Tool | Description |
|------|-------------|
| `portuni_create_node` | Create node (accepts optional `goal`, `lifecycle_state`) |
| `portuni_update_node` | Update node (accepts `goal`, `lifecycle_state`, `owner_id`) |
| `portuni_list_nodes` | List/filter nodes |
| `portuni_get_node` | Node detail with edges, files, events, owner, responsibilities, data sources, tools, mirror |
| `portuni_connect` | Create edge |
| `portuni_disconnect` | Remove edge(s) |
| `portuni_get_context` | Recursive graph traversal (enriched with owner/responsibilities/data sources/tools at depth 0) |
| `portuni_log` | Log event on node |
| `portuni_resolve` | Resolve event |
| `portuni_supersede` | Replace event |
| `portuni_list_events` | Query events |
| `portuni_store` | Store file in node mirror |
| `portuni_pull` | List node files |
| `portuni_list_files` | List files across nodes |
| `portuni_mirror` | Create local folder for node |

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

Design spec: `docs/superpowers/specs/2026-04-21-people-responsibilities-design.md`.

## Project structure

```
src/
  server.ts          HTTP server, MCP setup, /context, /health
  schema.ts          DDL, ensureSchema(), SOLO_USER
  db.ts              libsql client (Turso for team, local SQLite fallback for solo)
  audit.ts           Audit logging helper
  types.ts           Zod row schemas for all DB tables
  tools/
    nodes.ts         create, update, list
    get-node.ts      get (with edges, files, events, mirror)
    edges.ts         connect, disconnect
    context.ts       get_context (recursive CTE)
    mirrors.ts       mirror
    files.ts         store, pull, list_files
    events.ts        log, resolve, supersede, list_events
scripts/
  portuni-context.sh SessionStart hook
test/
  schema-types.test.ts  DDL vs Zod schema validation
  events.test.ts        Event lifecycle tests
docs/
  specs.md              Full specification
  conceptual-map.md     Mental model
  implementation-plan.md Status and roadmap
  lessons-learned.md    Decisions and patterns
  artifacts-hosting.md  Artifact hosting spec (Later)
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
