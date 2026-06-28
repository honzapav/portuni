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

Started once: `tmux new -d -s portuni-mcp 'varlock run -- node dist/index.js 2>&1 | tee /tmp/portuni-mcp.log'`.

Logs at `/tmp/portuni-mcp.log` and in the tmux pane.

### Frontend (Vite, port 4010)

```bash
varlock run -- npm --prefix apps/web run dev
```

Open `http://portuni.test` (localias) or `http://localhost:4010`. Save a
`.tsx`, HMR pushes the change. Vite proxies `/api/*` to 4011 and injects the
auth token from env (hence varlock).

### Desktop (Tauri) – rare

Only when shipping a new `Portuni.app` or testing desktop-specific wiring
(sidecar boot, per-launch auth token, env passing, Tauri commands).

```bash
# run from the Tauri project dir (Tauri finds the project by cwd)
cd apps/desktop && cargo tauri build
cp -R apps/desktop/target/release/bundle/macos/Portuni.app /Applications/
```

First Rust build ~10–15 min, incremental 30–60 s. Tauri runs the
`beforeBuildCommand` from `apps/` (the parent of `apps/desktop`), so the
web build + `scripts/build-sidecar.mjs` are wired relative to that; the
sidecar script resolves all paths from the repo root, so `npm run
build:sidecar` from the repo root works too.

For ad-hoc desktop dev: `cd apps/desktop && cargo tauri dev` (Vite HMR for
UI, sidecar binary already in `apps/desktop/binaries/`). Backend changes
need `npm run build:sidecar` + kill + restart `cargo tauri dev`. Prefer the
tmux loop for backend iteration.

### Rule of thumb

| Working on | Mode | Loop |
|---|---|---|
| MCP tools, scope, schema, REST | Backend tmux | `npm run build` + tmux restart |
| React in `apps/web/` | Vite | save -> HMR |
| `apps/server/desktop.ts`, Rust shell (`apps/desktop`) | Tauri dev | restart `cargo tauri dev` |
| Ship new `.app` | Tauri build | `cargo tauri build` + cp |

~95% of changes are the first row.

## Gotchas

- **Source of truth is Turso**, not the local SQLite at
  `~/Library/Application Support/ooo.workflow.portuni/portuni.db`. That file
  is the desktop sidecar's embedded replica and can be stale. To answer
  "does node X exist?" hit Turso, the MCP server, or the desktop app –
  never the local file.
- **Mirror scope configs are Portuni-managed.** `portuni_mirror` materializes
  `.mcp.json`, `.claude/settings.local.json`, `.codex/config.toml`,
  `.vibe/config.toml`, `.cursor/rules`, `PORTUNI_SCOPE.md` and marker blocks
  in CLAUDE.md/AGENTS.md – don't hand-edit those blocks
  (`apps/server/domain/scope-materialize.ts`). The per-mirror `.mcp.json` (Claude)
  and `.vibe/config.toml` (Mistral Vibe) carry `?home_node_id=…` (scope
  auto-seed) and reference the token via env var – never a literal. The
  desktop app injects `PORTUNI_MCP_TOKEN` into spawned terminals; manual
  shells outside the app must export it themselves (Settings → Copy token).
  User-scoped fallbacks for sessions outside any mirror:
  `~/.claude.json` (`install_claude_global`), `~/.codex/config.toml`
  (`install_codex_global`), `~/.vibe/config.toml` (`install_vibe_global`).
- **Mistral Vibe needs `--trust`.** Vibe only loads the per-mirror
  `.vibe/config.toml` (and thus auto-seeds) when the folder is trusted, so
  the desktop "Mistral Vibe" preset launches `vibe --trust {prompt}`
  (session-only trust). Without it Vibe falls back to `~/.vibe/config.toml`
  (no `home_node_id`) and starts unscoped. Vibe merges project over user
  config (union-merge of `mcp_servers` by `name`), so the per-mirror file is
  minimal and never clobbers the user's models/providers.
- **Auto-seed runs on MCP connect** when the URL carries `?home_node_id=...`.
  Failures (DB unreachable, network) return 503 with the underlying reason
  rather than serving an empty-scope session – see `apps/server/mcp/transport.ts`.
- **Auth mode**: `PORTUNI_AUTH_MODE=env` (default) = solo bearer token; `google` = Google OAuth + Groups. Enforcement lives server-side in `apps/server/auth/` (min-scopes per tool, node-access for group visibility).
- **Desktop central-server config**: `server_url` + `google_client_id` in
  `config.json` (non-secret) enable Settings → Účet (Google login, device
  tokens). Refresh token + session JWT live in Keychain; webview reaches the
  central server only via the `central_request` Tauri command. E2E login
  requires the Workspace OAuth client (admin checklist in the design spec §6).
  `data_mode: "central"` přepne desktop plně na centrální server (sidecar se
  nespouští, mirror/sync/file content = fáze B, "local only"); teammate setup =
  config.json se `server_url`, `google_client_id`, `data_mode`. Pozor, je to
  jiná osa než "sync vs Drive": "sync" = dvě roviny (graf v Turso vs. file bytes
  na Drive), central mód umí dnes jen graf. Model: `docs/architecture/data-modes.md`;
  scope nedostavěné buňky (file content přes server): `docs/architecture/central-file-content-phase-b.md`.

- **Env vars beyond `.env.schema`:** the server reads ~27 `process.env`
  keys; `.env.schema` declares only the 6 core ones. Full inventory with
  defaults: `docs/env-vars.md`. Watch out: `PORTUNI_ROOT` (write-scope
  tiering) is a different thing than `PORTUNI_WORKSPACE_ROOT` (mirrors).

## Security rules (from the auth refactor post-mortem)

1. **No secret in webview JS, ever.** If a JS module needs to know it, it
   can be exfiltrated trivially. The webview calls the `api_request` Tauri
   command; the Rust proxy injects the bearer header.
2. **No secret in plaintext on disk.** OS keychain (or varlock) only.
3. **Webview ↔ backend through Tauri commands, not direct HTTP.** Tauri's
   capabilities allowlist already enforces the trust boundary.
