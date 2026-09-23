# Portuni – Claude guide

Knowledge graph for organisations (POPP: organisations, projects, processes,
areas, principles). Backend Node + libSQL (Turso), frontend React + Vite,
desktop shell Tauri 2.

**Workspace rule, before anything else.** A workspace is either a **team
workspace** or a **personal workspace**, named by what it is for, not by
where its database sits. The team workspace is the primary one: a team runs
the central server, every teammate's desktop is a team workspace whose
sidecar is a sync agent, and that is where every real task, mirror and MCP
session happens. A personal workspace is the same server in a box for one
person; it must keep working, but it is not the reference. Every change to
the server, a REST route, an MCP tool or the session runtime works in
**both** before its issue closes. A half that is missing is an **open issue
named in the PR title**, never a "known gap" note in the docs. New behaviour
is written once as domain code that runs on the central server and in the
sidecar; where the device lacks the graph db, it takes a `CentralClient`
seam, not a second implementation. Words kept apart: **team workspace**
(`data_mode: "central"`), **personal workspace** (`data_mode: "local"`), the
**central server** (the process at `api.portuni.com`), the **sync agent**
(the device's sidecar in a team workspace, `PORTUNI_AGENT_MODE=1`) and
**device-local** (what the sync agent serves itself, `device_local` in code).
Model and checklist: `docs/architecture/data-modes.md`.

## Where the rules live

Detailed behaviour and invariants are in `docs/architecture/`; this file keeps
the workflow and one-line rules with pointers. Read the doc before touching
its area.

| Doc | Read when touching |
|---|---|
| `data-modes.md` | anything that behaves differently on the central server, on a team-workspace device, or in a personal workspace; request routing; the workspace checklist |
| `file-state-and-sync-runs.md` | mirrors, watcher, reconcile, sync runs and jobs, remote watcher, locking, delete/move/rename, `repair_needed` |
| `file-sync.md`, `file-mutation-propagation.md` | the file-bytes plane design, adapters, tombstones |
| `sessions-and-runner.md` | sessions, tasks, runs, the Claude adapter, live channel server side, provider instances |
| `task-surface-web.md` | Práce, SessionChat, sidebar threads, the sessions client, AI Elements |
| `desktop-shell.md` | `config.json`, workspaces, windows, quit, events, localStorage, `api_request` routing, the WS bridge, updates |
| `mcp-scope-and-integrations.md` | MCP connect and scope configs, disk read scope, orientation, elicitation deadlines, Showtime, Vibe |
| `database-and-dialects.md` | schema, migrations, dialect-neutral SQL, tests on both drivers, export/import |
| `docs/env-vars.md` | any `process.env` read (`PORTUNI_ROOT` is write-scope tiering, `PORTUNI_WORKSPACE_ROOT` is mirrors) |
| `docs/lessons-learned.md` §7 | before every migration |
| `docs/vision/portuni-as-workspace.md` | product direction, "Local vs. central" table |

## Daily dev workflow

Run backend and frontend separately. Stay out of Tauri unless shipping a new
`.app` or touching desktop-specific code. The installed
`/Applications/Portuni.app` is the daily driver for actual data work; update
it on release checkpoints, not per commit.

### Backend (tmux `portuni-mcp`, port 4011)

The standalone HTTP/MCP server, what Claude Code in mirror dirs talks to.

```bash
npm run build                                       # tsc -> dist/, ~2 s
tmux send-keys -t portuni-mcp C-c Up Enter          # restart server
```

Started once: `tmux new -d -s portuni-mcp 'varlock run -- node dist/index.js 2>&1 | tee /tmp/portuni-mcp.log'`.
Logs at `/tmp/portuni-mcp.log` and in the tmux pane. This loop is a local
workspace; set `PORTUNI_WATCH_MIRRORS=1` for the watcher. The central half of
a change is proven against the fake `CentralClient` in the tests, not here.

### Frontend (Vite, port 4010)

```bash
varlock run -- npm --prefix apps/web run dev
```

Open `http://portuni.test` (localias) or `http://localhost:4010`. Vite proxies
`/api/*` (REST and the `/sessions/ws` upgrade) to 4011 and injects the auth
token from env, hence varlock.

### Desktop (Tauri), rare

Only when shipping a new `Portuni.app` or testing desktop-specific wiring
(sidecar boot, per-launch auth token, env passing, Tauri commands).

**Always build the installable `.app` signed, never adhoc `cargo tauri
build`.** An adhoc build reads to macOS as a different app, so every
reinstall re-triggers the Keychain "Always Allow" gauntlet and breaks
Gatekeeper trust. Address the identity by its SHA-1 (the name carries a
diacritic that `codesign` mangles; `security find-identity -v -p codesigning`
prints the hash):

```bash
# cargo lives in the brew rustup keg, not linked into /opt/homebrew/bin;
# node comes from nvm, missing in a spawned shell.
PATH="/opt/homebrew/opt/rustup/bin:$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" \
  APPLE_SIGNING_IDENTITY=85E1645A46A7F888A8CB7D3025B48FAD6DF8757F \
  scripts/build-signed.sh --no-notarize

# Quit the app first and REMOVE the old bundle: cp -R over a live bundle
# merges the two and breaks the signature.
rm -rf /Applications/Portuni.app
cp -R apps/desktop/target/release/bundle/macos/Portuni.app /Applications/
```

Distribution build (notarized, stapled DMG): `scripts/build-signed.sh` with
`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or the Keychain profile
`portuni-notary` (secrets in Bitwarden "Portuni Apple signing"). Updater
artefacts (`Portuni.app.tar.gz`, `.sig`, `latest.json`) are CI-only
(`release.yml`); a local build never produces them. First Rust build about
10 to 15 min, incremental 30 to 60 s. Ad-hoc desktop dev: `cd apps/desktop &&
cargo tauri dev`; backend changes need `npm run build:sidecar` and a restart.
`scripts/desktop-dev-placeholders.sh` creates the gitignored sidecar
placeholder so `cargo test`/`clippy` work without building the sidecar.

### Rule of thumb

| Working on | Mode | Loop |
|---|---|---|
| MCP tools, scope, schema, REST | Backend tmux | `npm run build` + tmux restart |
| React in `apps/web/` | Vite | save, HMR |
| `apps/server/desktop.ts`, Rust shell (`apps/desktop`) | Tauri dev | restart `cargo tauri dev` |
| Ship new `.app` | Signed build | `scripts/build-signed.sh` + `rm -rf` + cp (never adhoc) |

## Agent loop (Sandcastle)

`.sandcastle/` is the RALPH harness: an autonomous Claude Code agent in a
Docker container working through GitHub issues labelled `ready-for-agent`
on a batch branch, PR only (never merges). It runs on the old Mac (ssh host
`honzas-macbook-pro`, clone `~/Dev/projekty/portuni`), started over
`ssh -t … ./.sandcastle/node_modules/.bin/sandcastle-loop start` (tmux
session `sandcastle-portuni` on its own socket; `watch`/`stop`/`status` are
the other subcommands). Launcher, supervisor and prompt core come from the
pinned package `honzapav/sandcastle-harness`; `.sandcastle/` holds only
`config.json`, `prompt.project.md` and the Dockerfile. `config.json`'s
`promptVars.runtimeTargets` is what puts the workspace rule into the agent's
prompt. Secrets come from that Mac's Keychain, read by the loop process,
never from disk. Never provision those entries, the image or a worktree for
it on another machine. Details: `.sandcastle/README.md`.

Issues for the loop use `.github/ISSUE_TEMPLATE/agent-task.md` (a "Workspace:
osobní / týmový" section is mandatory); a batch's tracking issue uses
`tracking.md`, whose "Pravidla" block is the loop's contract.

The verification gate for agents and humans alike is `scripts/agent-gate.sh`
(server qa, web typecheck + build, `cargo test` +
`cargo clippy -D warnings`, docs site build), the same checks `ci.yml` runs.
`AGENTS.md` is a symlink to this file.

## Releases & commit conventions

- **Conventional Commits are load-bearing.** release-please parses `git log`
  to compute the next version and generate `CHANGELOG.md`. `feat:` (minor),
  `fix:` (patch), `docs:`/`chore:`/`refactor:`/`test:`/`ci:` (no bump); on
  `0.x` a `feat!:` bumps minor. Keep scopes consistent with `git log`
  (`sync`, `mcp`, `desktop`, `web`, `auth`, `runner`, `server`).
- **Never hand-bump the version.** Four manifests in lockstep
  (`package.json`, `apps/web/package.json`, `apps/desktop/tauri.conf.json`,
  `apps/desktop/Cargo.toml`), all owned by release-please; keep the
  `# x-release-please-version` annotation in Cargo.toml.
- **Don't manually tag `v*` or cut releases.** Merging to `main` makes
  release-please open a `chore: release X.Y.Z` PR; merging that tags and
  fires `release.yml` on a pre-release that is not "Latest". Rollout is
  `scripts/release-rollout.sh promote vX.Y.Z`, rollback
  `scripts/release-rollout.sh rollback vX.Y.Z v<previous>`. **Never promote by
  clearing the pre-release flag alone**; `releases/latest` follows the
  `make_latest` pin, which `gh release edit --prerelease=false` never sends.
  Full flow: `CONTRIBUTING.md`, `docs/release-process.md`.
- **The server deploys itself from CI.** `deploy-server.yml` runs on every
  green CI run on `main`, skips commits touching nothing under `apps/server/`,
  and runs `scripts/deploy-vps.sh` with `PORTUNI_SKIP_QA=1`; the pre-migration
  Turso backup is kept as a workflow artifact for 30 days. A laptop deploy
  still works and needs the Turso vars that live only in
  `/opt/portuni/portuni.env` on the VPS.
- **Update the public docs site (`sites/docs/`) in the same branch as any
  behaviour, tool or API change.** release-please never touches it. Before
  merging a release PR, grep `sites/docs/src` for the changed concept and run
  `npm --prefix sites/docs run build`.

## Rules by area

One line each; the linked doc carries the mechanism and the reasoning.

### Modes and routing (`data-modes.md`, `desktop-shell.md`)

- A REST route the desktop must reach on the device in a team workspace lives in
  three places at once: the local router, `agent-router.ts`, and
  `apps/server/shared/device-local-routes.json`, which `is_device_local_path`
  embeds and matches against; `test/agent-router-route-parity.test.ts` holds
  the router to the same list.
- A personal workspace cannot register or route to a remote:
  `LocalModeNoRemoteError` (`LOCAL_MODE_NO_REMOTE`, REST 409) from
  `upsertRemote`/`setupRemoteService`/`setRoutingPolicyService`, and from
  `storeFile`/`pullFile`/`runNodeSync`/`snapshotService`, checked before any
  other work. Web hides (never merely disables) what cannot exist there.
- A team-workspace sidecar has no graph db. A graph read in code that runs on
  the device goes through a `CentralClient` method or an injected resolver
  whose local default is the direct query; never a swallowed failure.
- Central-only by design: Drive (service account only, shared drive
  required), the remote watcher (`RemoteWatchLoop`, `authMode() === "google"`),
  `GET /sync/watch`, team permissions.
- Source of truth for "does node X exist" is the graph db of the mode:
  Turso/central when `TURSO_URL` is set (the local SQLite is a stale replica
  then), the local file otherwise; never the replica file.

### Files and sync (`file-state-and-sync-runs.md`)

- File state is deterministic: the watcher registers and reconciles on every
  disk change; a registration never requires a remote (`remote_name` stays
  NULL, `remote_path` is always computed); a push is a deliberate
  `portuni_store` or sync run.
- A status scan reads state, it never re-derives the remote; in a team workspace
  `current_remote_hash` is the only remote truth, so every path that proves
  it persists it. Sync classes: `clean | push | pull | conflict |
  remote_missing | remote_error | native | deleted_local`; no `orphan`, no
  `moved` bucket.
- `withPathLock` wraps every check-then-write on a path; it is not reentrant
  and in-process only. `pending_file_ops` records move/rename/delete intent
  before the remote is touched; retries are idempotent.
- Every delete path clears `file_state` only after the local copy is
  confirmed gone (`removeLocalCopyAndState`). A device step that fails after
  the central server committed reports `repair_needed`, never a 500 and never silent
  success; a watcher-driven delete unregisters only on a confirmed `ok`.
- `relocateRemoteObject` refuses when both source and destination exist; a
  cross-remote move records `source_copied` so the retry can finish.
- "Deliberately not done" (reserving a `files` row before upload, a general
  idempotency-key replay, move/rename of a never-routed device-local file) is
  listed in the doc; do not re-litigate without new reasons.
- Bulk sync is `POST /sync/jobs` (202, one job per user, reattach appends
  nodes); `total = push + untracked`, `decisions = conflict + deleted_local`,
  `pull` counts towards neither. Every caller of a node sync run takes
  `withNodeSyncLock`, not only the pool.
- The remote watcher correlates a change with a record by
  `files.remote_file_id`, never by path alone; a sweep is recorded when it
  finishes and backs off on its own schedule.

### Sessions and runner (`sessions-and-runner.md`)

- The session row exists before the runner: `POST /sessions` creates it, the
  run's MCP connection binds to it via `X-Portuni-Spawn-Id`; a hand-opened CLI
  gets its row at the handshake, `cli` from `clientInfo.name`.
- The runtime always runs on the device; only the store differs
  (`DbSessionStore` locally, `CentralSessionStore` in sync-agent mode). Access is
  enforced once, on the central server, by `auth/session-access.ts`'s table. A new
  session verb lands in `router.ts`, `agent-router.ts`, `sessions-ws.ts`,
  `min-scopes.ts` and `device-local-routes.json` together.
- Nothing but Uzavřít and the auto-archive sweep reaches `closed`. Every other
  end (disconnect, idle `PORTUNI_RUN_IDLE_MS`, provider limit or error,
  boot sweep, orphaned pid) suspends with a server-written summary; the next
  message resumes by writing. `interrupt()` cancels the current turn only.
- `@anthropic-ai/claude-agent-sdk` is pinned exact; never let `npm update`
  touch it. The adapter always uses streaming input, never starts a process
  to answer `models()`, and ends a run on a `result` that carries an error.
- Migration 036 carries `draft`, `model`, `effort`; migration 039 the
  context counters; the 030 and 036 rebuilds, `DDL_SESSIONS` and
  `PG_BASELINE_DDL` carry the current full shape too. A new `sessions`
  column goes into all of them.

### MCP and scope (`mcp-scope-and-integrations.md`)

- Materialized scope configs (`.mcp.json`, `.claude/settings.local.json`,
  `.codex/config.toml`, `PORTUNI_SCOPE.md`, marker blocks in
  CLAUDE.md/AGENTS.md) are Portuni-managed; never hand-edit them, never
  write a token literal or an `X-Portuni-Spawn-Id` into them. Vibe and
  Cursor connect user-scoped only (no per-mirror writer; a legacy marked
  `.vibe/config.toml` is removed).
- Auto-seed on connect with `?home_node_id=`; a failure is a 503 with the
  reason, never an empty-scope session. Orientation lives only in
  `PORTUNI_SCOPE.md`; no message is ever sent on connect.
- A confirmation dialog never outlives the client's tool-call deadline
  (`ELICIT_TIMEOUT_MS` 4 min, relay 3 min, relay < outer always), and a tool
  that cannot succeed (`requireLocalSyncDb()` on a remote MCP client session) fails
  before opening one.
- Disk read scope is the real mirror path or nothing: `readable_path`/
  `local_path` on node answers, `portuni_read_file` for a node with no mirror
  here (1 MB inline cap, then a temp file; no chunked read parameter).
- Scope tiers: `read` < `write` < `manage` (move, sharing, positions) <
  `admin` (deletes, users, `setup_remote`, routing). `PORTUNI_AUTH_MODE=env`
  is the solo bearer token, `google` is OAuth + Groups.

### Database (`database-and-dialects.md`)

- A migration is written in both dialects: a `MIGRATIONS` entry (libsql) and
  an extension of `PG_BASELINE_DDL`; no `pg-002` until the cutover. Read
  `docs/lessons-learned.md` §7 first. A table rebuild is one
  `executeMultiple`; an index on a column a migration adds never goes into
  the DDL replay.
- Call sites use `infra/sql.ts` (`nowExpr`, `jsonField`,
  `jsonArrayElementsText`, `insertIgnore`, `isUniqueViolation`,
  `constraintViolationMessage`, `tableExistsSql`); no `PRAGMA`,
  `datetime('now')`, `INSERT OR IGNORE`, `json_extract`, `COLLATE NOCASE`,
  lenient `GROUP BY` or SQL-side relative dates in runtime code.
- Timestamps read back as `YYYY-MM-DD HH:MM:SS` UTC text on every driver.
- Tests open their db with `openTestDb()`; only migration and libsql-DDL
  tests pin `"libsql"`. `npm test` runs in the gate; `npm run test:pglite`
  runs in CI on every PR and by hand before a schema or query change is
  claimed green on both drivers. No fixed sleeps, wait for a signal or an
  injected clock.

### Desktop (`desktop-shell.md`)

- Windows are created at runtime (`ws:<id>`, `bootstrap`); every
  workspace-bound command resolves `ws_of(&window)`, never the active
  workspace. Every window is built with
  `.disable_drag_drop_handler()`: Tauri's handler blocks HTML drag and drop
  in the webview on macOS and Portuni handles no Finder drops. Every
  `config.json` mutation goes through `ConfigLock`
  (`with_config_mut`/`with_config_write_lock`) and emits `workspaces-changed`.
- Backend events are emitted per window with replay on window create.
  localStorage keys are `portuni:<ws_id>:<key>`; `theme` stays global.
- Quitting closes windows one at a time through the single close guard;
  `open_windows` is never rewritten mid-quit; sidecars die only on app exit;
  the single-instance plugin is registered first.
- The live channel's WebSocket is held in Rust (`sessions_ws.rs`), one per
  window, torn down on window destroy; the webview never holds a bearer.
- `PORTUNI_WEBVIEW_PROXY_SECRET` is always set by the packaged app and never
  written to disk or exported to a spawned agent; `guardAgentRestWrite`
  applies the same posture on every mutating agent-router route.

### Web (`task-surface-web.md`)

- A fact about a thread lives in the session store (`lib/session-store.ts`,
  one record per session id, read through `useSessionStore` and the
  selectors); a component or map that copies it is a bug.
- One `SessionsClient` for the app's lifetime, created lazily in `useState`;
  `SessionChat` is lazy-loaded. Compare the main chunk size when adding
  dependencies to it.
- Colours are defined once in Portuni's palette; shadcn tokens bridge to it in
  `index.css`, `@custom-variant dark` targets `[data-theme="dark"]`. No `ai`
  package; local types mirror `CanonicalEvent`.
- Pure helpers live in `apps/web/src/lib/*.ts` and are tested from the
  server's `node:test` runner. Client-side access echoes are UX only; the
  server is the gate. UI strings are Czech with diacritics.

## Security rules (from the auth refactor post-mortem)

1. **No secret in webview JS, ever.** The webview calls the `api_request`
   Tauri command; the Rust proxy injects the bearer header.
2. **No secret in plaintext on disk.** OS keychain (or varlock) only.
3. **Webview ↔ backend through Tauri commands, not direct HTTP.** Tauri's
   capabilities allowlist already enforces the trust boundary.
