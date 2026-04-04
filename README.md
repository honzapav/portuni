# Portuni

Knowledge graph MCP server. TypeScript, Turso, Streamable HTTP.

## Setup

```bash
npm install
npm run build
```

### Environment

Managed via Varlock. Required variables (see `.env.schema`):

- `TURSO_URL` -- Turso database URL
- `TURSO_AUTH_TOKEN` -- Turso auth token
- `PORTUNI_WORKSPACE_ROOT` -- root for local mirror folders (e.g. `~/Workspaces/portuni`)

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

## MCP tools (15)

| Tool | Description |
|------|-------------|
| `portuni_create_node` | Create node |
| `portuni_update_node` | Update node fields |
| `portuni_list_nodes` | List/filter nodes |
| `portuni_get_node` | Node detail with edges, files, events, mirror |
| `portuni_connect` | Create edge |
| `portuni_disconnect` | Remove edge(s) |
| `portuni_get_context` | Recursive graph traversal |
| `portuni_log` | Log event on node |
| `portuni_resolve` | Resolve event |
| `portuni_supersede` | Replace event |
| `portuni_list_events` | Query events |
| `portuni_store` | Store file in node mirror |
| `portuni_pull` | List node files |
| `portuni_list_files` | List files across nodes |
| `portuni_mirror` | Create local folder for node |

## Project structure

```
src/
  server.ts          HTTP server, MCP setup, /context, /health
  schema.ts          DDL, ensureSchema(), SOLO_USER
  db.ts              Turso client
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

Turso (libsql cloud). Schema auto-migrated on startup via `ensureSchema()`.

Tables: `users`, `nodes`, `edges`, `events`, `files`, `local_mirrors`, `audit_log`.
