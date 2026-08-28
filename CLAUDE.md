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

**Always build the installable `.app` signed — never adhoc/bare
`cargo tauri build`.** An adhoc build reads to macOS as a *different*
app (identity = binary hash), so every reinstall re-triggers the whole
Keychain "Always Allow" gauntlet and breaks Gatekeeper trust. Use the
wrapper, which signs with the Developer ID (identity stable across
rebuilds → Keychain grants persist) and verifies the bundle:

```bash
# local reinstall (signed, not notarized — Gatekeeper only checks
# downloaded apps, so notarization is unnecessary for your own machine)
APPLE_SIGNING_IDENTITY='Developer ID Application: JAN PÁV (98H25UC996)' \
  scripts/build-signed.sh --no-notarize
cp -R apps/desktop/target/release/bundle/macos/Portuni.app /Applications/

# distribution build (adds notarization + staples the DMG) — full run:
#   scripts/build-signed.sh   (needs APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID,
#   or the Keychain profile `portuni-notary`; secrets in Bitwarden
#   "Portuni Apple signing"). See docs/release-process.md.
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
| Ship new `.app` | Signed build | `scripts/build-signed.sh` + cp (never adhoc) |

~95% of changes are the first row.

## Agent loop (Sandcastle)

`.sandcastle/` is the RALPH harness: an autonomous Claude Code agent in a
Docker container working through GitHub issues labelled `ready-for-agent`
on a batch branch, PR only (never merges). It runs on the old Mac (ssh host
`honzas-macbook-pro`, clone `~/Dev/projekty/portuni`), started over ssh with
`launchctl kickstart gui/501/ooo.workflow.sandcastle.portuni` (LaunchAgent →
`start-loop.sh` → tmux session `sandcastle-portuni`);
secrets come from that Mac's Keychain (`sandcastle.claude-code.oauth-token`,
`sandcastle.portuni.github-pat`), never from disk. Docker image
`sandcastle:portuni`. Never provision those entries, the image or a worktree
for it on another machine. Details: `.sandcastle/README.md`.

The verification gate for agents and humans alike is `scripts/agent-gate.sh`
(server qa, web typecheck + build, `cargo test` + `cargo clippy -D warnings`,
docs site build), the same checks `ci.yml` runs. `scripts/desktop-dev-placeholders.sh`
creates the gitignored sidecar placeholder tauri-build validates, so
`cargo test`/`clippy` work without building the sidecar. `AGENTS.md` is a
symlink to this file.

## Releases & commit conventions

- **Conventional Commits are load-bearing, not style.** release-please parses
  `git log` to compute the next version and generate `CHANGELOG.md`. Use
  `feat:` (minor), `fix:` (patch), or `docs:`/`chore:`/`refactor:`/`test:`/
  `ci:` (no bump). On `0.x` a breaking change (`feat!:`) bumps minor, not
  major. Keep scopes consistent with `git log` (`sync`, `mcp`, `desktop`,
  `web`, `auth`, …).
- **Never hand-bump the version.** It lives in four manifests kept in lockstep
  — `package.json`, `apps/web/package.json`, `apps/desktop/tauri.conf.json`,
  `apps/desktop/Cargo.toml` — and release-please owns all four
  (`release-please-config.json`). The Cargo.toml line carries a
  `# x-release-please-version` annotation; don't remove it.
- **Don't manually tag `v*` or cut releases.** Merging to `main` makes
  release-please open a `chore: release X.Y.Z` PR; merging *that* tags the
  version and fires `release.yml` (signed DMG). Full flow + one-time PAT setup:
  `CONTRIBUTING.md`, `docs/release-process.md`.
- **Update the public docs site (`sites/docs/`) in the SAME branch as any
  behaviour/tool/API change.** release-please only bumps the version and
  CHANGELOG — it never touches `sites/docs/`, so a change shipped without a
  docs edit leaves the published Netlify docs wrong. Before merging a release
  PR, grep `sites/docs/src` for the changed concept and `npm --prefix
  sites/docs run build`. Checklist: `docs/release-process.md` ("Before merging
  the release PR").

## Gotchas

- **Source of truth is Turso**, not the local SQLite at
  `~/Library/Application Support/ooo.workflow.portuni/portuni.db`. That file
  is the desktop sidecar's embedded replica and can be stale. To answer
  "does node X exist?" hit Turso, the MCP server, or the desktop app –
  never the local file.
- **File state is deterministic, not agent-driven.** A mirror watcher
  (`apps/server/domain/sync/mirror-watcher.ts` → `reconcile.ts`) registers new
  files and reconciles edits/deletes on every disk change, so the UI's sync
  status (fast-mode `statusScan`, which reads `file_state.cached_local_hash`)
  is current without anyone calling `portuni_store`/`portuni_status`.
  Registration is local-only (`registerLocalFile`, no upload); a file then
  reads as `push` until a deliberate "Synchronizovat"/`portuni_store` pushes
  it to the remote. The watcher runs in the desktop sidecar by default
  (`PORTUNI_WATCH_MIRRORS`, on the standalone server it is opt-in `=1`); for
  backend dev against the tmux server, set `PORTUNI_WATCH_MIRRORS=1` if you
  want the same behavior. Model:
  `docs/archive/specs/2026-06-28-deterministic-file-state-design.md`.
- **Drive sync has two auth paths sharing one adapter.** Desktop local
  workspaces connect via per-user OAuth: Settings → Synchronizace →
  `google_drive_connect` (`apps/desktop/src/auth.rs`, PKCE loopback) hands the
  refresh token to the sidecar's bearer-authed `POST /sync/drive/connect` over
  loopback — never through the webview (security rule 1). It lands as a
  `refresh_token`-mode TokenStore entry under the fixed remote name `gdrive`;
  `POST /sync/drive/target` upserts the remote and adds a wildcard routing rule
  **only if routing is empty**. Domain logic is `remote-service.ts`
  (`connectDrive/setDriveTarget/driveStatus/testDrive/disconnectDrive`), REST is
  `apps/server/api/sync-drive.ts` (`/sync/drive/{connect,targets,target,status,test,disconnect}`),
  web is `SyncSection.tsx` + `lib/sync-drive.ts`. The Drive adapter
  (`drive-adapter.ts`) picks auth by token mode: `refresh_token` →
  `drive-user-auth.ts`, else service-account → `drive-sa-auth.ts`
  (`assertSaDriveConfig` forces a `shared_drive_id` — SAs have no My Drive quota;
  OAuth may target My Drive via `root_folder_id`). The service-account path stays
  MCP-only (`portuni_setup_remote`; `setup-drive-remote` prompt) for headless /
  central / multi-remote. `driveStatus.routed` guards the "connected but nothing
  routes to gdrive" trap. Spec/plan:
  `docs/archive/{specs,plans}/2026-07-05-sync-settings*.md`.
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
  `data_mode: "central"` přepne desktop na centrální server pro graf i obsah
  souborů; lokální sidecar běží jako **sync agent** (teammate mirrors: lokální
  mirror složky + watcher + sync přes server, `PORTUNI_AGENT_MODE=1`, bez Turso
  tokenu a bez Drive credentials — vše jde přes device token na central).
  Teammate setup = onboarding wizard („Připojit se k týmu": zadá se jen server
  URL; app si stáhne OAuth client z veřejného `GET /auth/desktop-config` —
  `setup_central` command — a zapíše config.json s `data_mode: "central"`).
  Ruční config.json se stejnými klíči dál funguje jako fallback. Agent se
  spouští až po Google loginu
  (device token); před loginem vrací local-only cesty 501. V agent módu
  navíc per-mirror `.mcp.json` míří na lokální sidecar front door
  (`http://127.0.0.1:<port>/mcp`), ne na central: graf/scope nástroje se
  proxují na central beze změny, device-local nástroje (mirror/status/
  store/pull/adopt_files) běží lokálně. E2E harness:
  `scripts/e2e/teammate-mirrors.sh`. Model: `docs/architecture/data-modes.md`;
  plán: `docs/archive/plans/2026-07-03-teammate-mirrors.md`,
  `docs/archive/plans/2026-07-05-agent-mode-mcp-front-door.md`.

- **Multi-workspace desktop**: `config.json` v2 má `workspaces` mapu +
  `active_workspace`; sidecary všech zapnutých workspaces běží souběžně
  (každý vlastní port od 47011, data dir `workspaces/<id>/`, Keychain
  accounty `<base>.<id>`). UI přepíná jen pohled. Per-mirror configy
  referencují token přes `PORTUNI_MCP_TOKEN_<ID>` (server zná své ID z
  `PORTUNI_WORKSPACE_ID`; bez něj — standalone — zůstává
  `PORTUNI_MCP_TOKEN`). Globální MCP entries: `portuni-<id>`, migrovaný
  workspace drží historické `portuni`. Model:
  `docs/archive/specs/2026-07-04-desktop-multi-workspace-design.md`.

- **Env vars beyond `.env.schema`:** the server reads ~27 `process.env`
  keys; `.env.schema` declares only the 6 core ones. Full inventory with
  defaults: `docs/env-vars.md`. Watch out: `PORTUNI_ROOT` (write-scope
  tiering) is a different thing than `PORTUNI_WORKSPACE_ROOT` (mirrors).
- **Disk read scope = the session scope, on REAL paths (no more copies).** The
  MCP `SessionScope` is the single source of truth. The Seatbelt profile grants
  rw on the home mirror and **read-only on the REAL mirrors of the depth-1
  neighbour set** (the stable spawn scope), computed at spawn — locally from the
  graph, in central mode from `CentralClient.nodeNeighbours`
  (`sandbox-profile.ts` `readMirrors` / `resolveNeighbourReadMirrors`). Read
  tools (`get_node`/`get_context`/`list_files`) return those real paths;
  `readableMirrorRoot` returns the real mirror for home+seed nodes. **Ad-hoc
  nodes** (deeper than depth-1, added mid-session by `expand_scope`) are NOT on
  disk — read their content with **`portuni_read_file(node_id, path)`**
  (`read-node-file.ts`), the universal no-hooks channel. The old
  `.portuni-scope/` copy staging is **retired**; the `ScopeReconciler` survives
  only as a one-time sweeper of legacy staged dirs. Why real paths beat copies:
  no stale snapshot, no cleanup, edits land on the real mirror. Model:
  `docs/architecture/scope-disk-projection.md`;
  plan: `docs/superpowers/plans/2026-07-06-scope-real-paths.md`.

## Security rules (from the auth refactor post-mortem)

1. **No secret in webview JS, ever.** If a JS module needs to know it, it
   can be exfiltrated trivially. The webview calls the `api_request` Tauri
   command; the Rust proxy injects the bearer header.
2. **No secret in plaintext on disk.** OS keychain (or varlock) only.
3. **Webview ↔ backend through Tauri commands, not direct HTTP.** Tauri's
   capabilities allowlist already enforces the trust boundary.
