# Portuni – Claude guide

Knowledge graph for organisations (POPP: organisations, projects, processes,
areas, principles). Backend Node + libSQL (Turso), frontend React + Vite,
desktop shell Tauri 2.

## Daily dev workflow

Run backend and frontend separately. Stay out of Tauri unless shipping a new
`.app` or touching desktop-specific code. The installed
`/Applications/Portuni.app` is the daily driver for actual data work; update
it on release checkpoints, not per commit.

### Backend (tmux `portuni-mcp`, port 4011)

The standalone HTTP/MCP server – what Claude Code in mirror dirs talks to.

```bash
npm run build                                       # tsc -> dist/, ~2 s
tmux send-keys -t portuni-mcp C-c Up Enter          # restart server
```

Started once: `tmux new -d -s portuni-mcp 'varlock run -- node dist/server.js 2>&1 | tee /tmp/portuni-mcp.log'`.

Logs at `/tmp/portuni-mcp.log` and in the tmux pane.

### Frontend (Vite, port 4010)

```bash
varlock run -- npm --prefix app run dev
```

Open `http://portuni.test` (localias) or `http://localhost:4010`. Save a
`.tsx`, HMR pushes the change. Vite proxies `/api/*` to 4011 and injects the
auth token from env (hence varlock).

### Desktop (Tauri) – rare

Only when shipping a new `Portuni.app` or testing desktop-specific wiring
(sidecar boot, per-launch auth token, env passing, Tauri commands).

```bash
cargo tauri build
cp -R src-tauri/target/release/bundle/macos/Portuni.app /Applications/
```

First Rust build ~10–15 min, incremental 30–60 s.

For ad-hoc desktop dev: `cargo tauri dev` (Vite HMR for UI, sidecar binary
already in `src-tauri/binaries/`). Backend changes need
`npm run build:sidecar` + kill + restart `cargo tauri dev`. Prefer the tmux
loop for backend iteration.

### Rule of thumb

| Working on | Mode | Loop |
|---|---|---|
| MCP tools, scope, schema, REST | Backend tmux | `npm run build` + tmux restart |
| React in `app/` | Vite | save -> HMR |
| `src/desktop.ts`, Rust shell | Tauri dev | restart `cargo tauri dev` |
| Ship new `.app` | Tauri build | `cargo tauri build` + cp |

~95% of changes are the first row.

## Gotchas

- **Source of truth is Turso**, not the local SQLite at
  `~/Library/Application Support/ooo.workflow.portuni/portuni.db`. That file
  is the desktop sidecar's embedded replica and can be stale. To answer
  "does node X exist?" hit Turso, the MCP server, or the desktop app –
  never the local file.
- **Mirror `.mcp.json` is Portuni-managed** and rewritten on every
  `portuni_mirror` call. Don't hand-edit. If `Authorization` is missing,
  the regen ran without `PORTUNI_AUTH_TOKEN` in env – rerun under varlock.
- **Auto-seed runs on MCP connect** when the URL carries `?home_node_id=...`.
  Failures (DB unreachable, network) return 503 with the underlying reason
  rather than serving an empty-scope session – see `src/mcp/transport.ts`.
