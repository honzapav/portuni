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

Updater artefacts (`Portuni.app.tar.gz`, `.sig`, `latest.json`) are CI-only:
`release.yml` builds with `--bundles app,dmg --config
apps/desktop/tauri.release.conf.json` (`createUpdaterArtifacts: true`) and
signs with the `TAURI_SIGNING_PRIVATE_KEY` secret. `scripts/build-signed.sh`
is unchanged and never produces updater artefacts — a local/manual build
needs no updater key and installs by drag-replacing `Portuni.app` as before.

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
`honzas-macbook-pro`, clone `~/Dev/projekty/portuni`), started over
`ssh -t … ./.sandcastle/node_modules/.bin/sandcastle-loop start` (tmux
session `sandcastle-portuni` on its own socket; `watch`/`stop`/`status` are
the other subcommands). Launcher, supervisor and prompt core come from the
pinned package `honzapav/sandcastle-harness`; `.sandcastle/` holds only
`config.json`, `prompt.project.md` and the Dockerfile. Secrets come from that
Mac's Keychain (`sandcastle.claude-code.oauth-token`,
`sandcastle.portuni.github-pat`), read by the loop process inside the tmux
command, never from disk. Docker image
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
  version and fires `release.yml` (signed DMG + updater artefacts) on a
  **pre-release**. Installed apps see nothing until a maintainer unchecks
  "Set as a pre-release" on the release — that click is the rollout; ticking
  it again is the rollback. Full flow + one-time PAT setup:
  `CONTRIBUTING.md`, `docs/release-process.md`.
- **Update the public docs site (`sites/docs/`) in the SAME branch as any
  behaviour/tool/API change.** release-please only bumps the version and
  CHANGELOG — it never touches `sites/docs/`, so a change shipped without a
  docs edit leaves the published Netlify docs wrong. Before merging a release
  PR, grep `sites/docs/src` for the changed concept and `npm --prefix
  sites/docs run build`. Checklist: `docs/release-process.md` ("Before merging
  the release PR").

## Gotchas

- **Source of truth depends on the workspace's DB mode.** A sidecar with
  `TURSO_URL` set uses Turso; the legacy local SQLite at
  `~/Library/Application Support/ooo.workflow.portuni/portuni.db` is then just
  an embedded replica and can be stale — to answer "does node X exist?" hit
  Turso, the MCP server, or the desktop app, never that file. A workspace
  without `TURSO_URL` (local-only multi-workspace, e.g. `workspaces/<id>/`)
  falls back to `file:<dataDir>/portuni.db` (`apps/server/desktop.ts`) — there
  the local SQLite IS the source of truth and no Turso is involved. Central
  mode (`data_mode: "central"`) has no graph DB in the sidecar at all;
  everything goes through the central server.
- **File state is deterministic, not agent-driven.** A mirror watcher
  (`apps/server/domain/sync/mirror-watcher.ts` → `reconcile.ts`) registers new
  files and reconciles edits/deletes on every disk change, so the UI's sync
  status (fast-mode `statusScan`, which reads `file_state.cached_local_hash`)
  is current without anyone calling `portuni_store`/`portuni_status`.
  Registration is local-only (`registerLocalFile`, no upload); a file then
  reads as `push` until a deliberate "Synchronizovat"/`portuni_store` pushes
  it to the remote. **Registration never requires a remote.** A local-only
  workspace (no remote/routing configured at all) still tracks every file —
  `registerLocalFile` and its central-mode/REST equivalents
  (`registerFileRecordRemote(s)`) leave `remote_name` NULL instead of
  throwing when routing does not resolve; `remote_path` is still always
  computed (it is derived purely from the node's own identity, never from
  the remote). `idx_files_unique_remote` is keyed on `(node_id, remote_path)`
  alone (migration 031) so a later `storeFile`/write on the same path
  backfills `remote_name` onto the existing row instead of creating a
  duplicate. `storeFile` (and any other deliberate push/write) still
  requires a resolved remote and throws `ROUTING_GUIDANCE` otherwise — that
  guidance belongs at the moment of a deliberate sync, not at registration.
  The watcher runs in the desktop sidecar by default
  (`PORTUNI_WATCH_MIRRORS`, on the standalone server it is opt-in `=1`); for
  backend dev against the tmux server, set `PORTUNI_WATCH_MIRRORS=1` if you
  want the same behavior. A deliberate sync run additionally sweeps the
  remote first (`remote-sweep.ts`): a record whose remote object is
  confirmed gone is deleted + tombstoned, and a file newly present on the
  remote anywhere under `wip/`, `outputs/` or `resources/` — at any depth,
  skipping any dot-prefixed path segment — is adopted and pulled in the
  same run; `portuni_status` alone never triggers this. Sync classes are
  `clean | push | pull | conflict | remote_missing | remote_error | native
  | deleted_local`; there is no `orphan` class. `moveFile`/`renameFile`/
  `renameFolder`/`deleteFile` record their intent in `pending_file_ops`
  before touching the remote, so a half-finished mutation is retried
  idempotently by the next sync run instead of needing manual repair.
  `conflict`/`deleted_local` are resolved via `POST
  /nodes/:id/files/:fileId/resolve` (`keep_local | take_remote | restore`)
  or the equivalent `portuni_store`/`portuni_pull` calls. Model:
  `docs/archive/specs/2026-06-28-deterministic-file-state-design.md`,
  `docs/superpowers/specs/2026-08-28-deterministic-file-reconciliation-design.md`.
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
- **A `.showtime` file reads as its bundled `preview.html`.** A Showtime deck
  is a zip; `GET /nodes/:id/file` for a `.showtime` path returns the
  `preview.html` entry Showtime packs at every save (`text/html`, the
  bundle's sha256 as `version`, 422 `NO_PREVIEW` when the entry is missing),
  PUT refuses it, and the desktop `portuni-html://` protocol unzips the same
  entry from disk (`showtime_preview_bytes`). The web gates the whole thing
  behind Settings → Integrace → Showtime (`localStorage`, off by default);
  the server side is unconditional. Domain: `showtime-preview.ts`.
  **„Otevřít v Showtime" hands over the node, never the bearer.** The
  desktop `open_in_showtime` command (not `open_path_external`, which is
  `.html/.htm` only now) mints a one-time code on the sidecar — `POST
  /auth/handoff` (`write`, caller must see the node, bearer = the
  terminal token Rust already holds) — and opens
  `showtime://open?deck=…&portuni=<sidecar base>&code=…`. Showtime trades
  the code on `POST /auth/handoff/exchange` (public in `AUTH_PUBLIC_PATHS`,
  loopback peers only, single-use, 60 s, `404 HANDOFF_INVALID`) for
  `{ token, mcp_url (?home_node_id=), home_node_id, node_name, mirror }`.
  The bearer never enters a URL, argv or disk; both routers (local
  `router.ts`, agent `agent-router.ts`) share the handlers in
  `api/auth.ts`, codes live in `domain/handoff.ts`. The agent Showtime
  spawns connects with the node as home, so its session shows up under
  the node's Relace. Spec:
  `docs/superpowers/specs/2026-09-02-showtime-handoff-design.md`.
- **Mistral Vibe needs `--trust`.** Vibe only loads the per-mirror
  `.vibe/config.toml` (and thus auto-seeds) when the folder is trusted, so
  the desktop "Mistral Vibe" preset launches `vibe --trust`
  (session-only trust). Without it Vibe falls back to `~/.vibe/config.toml`
  (no `home_node_id`) and starts unscoped. Vibe merges project over user
  config (union-merge of `mcp_servers` by `name`), so the per-mirror file is
  minimal and never clobbers the user's models/providers.
- **Auto-seed runs on MCP connect** when the URL carries `?home_node_id=...`.
  Failures (DB unreachable, network) return 503 with the underlying reason
  rather than serving an empty-scope session – see `apps/server/mcp/transport.ts`.
- **Auth mode**: `PORTUNI_AUTH_MODE=env` (default) = solo bearer token; `google` = Google OAuth + Groups. Enforcement lives server-side in `apps/server/auth/` (min-scopes per tool, node-access for group visibility). Scope tiers (`min-scopes.ts`): `read` = read only (no group needed); `write` = everyday editing (create/update nodes, edges, actors, responsibilities, data sources, tools, events, files); `manage` = move_node, sharing (`PUT /nodes/:id/access`, access requests), positions; `admin` = deletes, users, `setup_remote`, routing policy, `/sync/drive/*`. Each `PORTUNI_GROUPS_*` var is a comma list.
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

- **Multi-window desktop, phase 1 (#222, #223): windows are created at
  runtime, not declared in `tauri.conf.json`.** `app.windows` there is `[]`; `.setup()`
  calls `create_startup_window`, which picks a label from `active_workspace`:
  `ws:<id>` when a v2 config already names one, else `bootstrap` (fresh
  install, or a v1 config still awaiting migration — `active_workspace` only
  understands v2). `ws_of(&tauri::Window)` is the per-window counterpart to
  `active_workspace`'s "the currently active one" — it answers "which
  workspace is THIS window for" by parsing the `ws:<id>` label and validating
  it against `config.json`; `bootstrap` and any other label are errors.
  **#223 routes every genuinely workspace-bound command through it**: each
  takes `window: tauri::Window` (not just `app: AppHandle`) and resolves
  `ws_of(&window)?` instead of `active_workspace(&app)` — `api_request`
  (its 401 retry re-uses the SAME window for the refresh, not a fresh
  `active_workspace` lookup, so a refresh always targets the request's own
  workspace), `get_backend_port`, `get_mcp_token`, `regenerate_mcp_token`,
  `set_turso_token`, `clear_turso_token`, `get_data_mode`, `open_path_external`,
  `restart_sidecar` (explicit `id` still wins; `None` now means "this
  window's own" instead of "the active one"), and `auth.rs`'s `auth_status`/
  `google_login`/`google_client_configured`/`google_drive_connect`/
  `auth_refresh`/`auth_logout`/`central_request` (`load_auth_config`/
  `load_google_client` now take an explicit `ws_id` instead of resolving it
  themselves). The `portuni-html` URI scheme handler resolves the same way
  from `ctx.webview_label()` via `ws_of_from_dir` (no `tauri::Window` object
  available there, just the label). `pty_spawn` captures the spawning
  window's workspace onto `PtySession.ws_id` (already true since #219, now
  window- rather than active-workspace-sourced); `pty_write`/`pty_resize`/
  `pty_kill` refuse a session whose `ws_id` doesn't match the caller's own
  window (`session_owned_by`, deny-by-default when either side is
  unresolved) — `PtyState` is process-wide, so without this one workspace's
  window could reach into another's PTY. App-global commands (workspace
  list/CRUD, updater, profiles, clipboard, `open_external`, exit,
  `workspace_migration_status`, `get_turso_status`, `save_config`/
  `setup_central`/`migrate_to_workspaces` themselves — all legitimately
  called from a `bootstrap` window where `ws_of` would error) keep
  `AppHandle` and never call `ws_of`. No frontend changes anywhere in this
  phase — Tauri injects `window` the same way it already injects `app`/
  `State`. `capabilities/default.json`'s
  `windows` list is `["bootstrap", "ws:*"]`. **Bootstrap → workspace
  handoff**: `migrate_to_workspaces`, and the fresh-install branches of
  `save_config`/`setup_central`, call `handoff_from_bootstrap` after saving
  config.json — it opens the new `ws:<id>` window and closes `bootstrap`.
  The onboarding gates (`WorkspaceMigrationGate`, and `TursoSetupGate`'s
  fresh-install paths) dropped their `window.location.reload()` accordingly;
  nothing left to do in JS once the command resolves, since that window is
  about to close. `TursoSetupGate`'s add-missing-token path (an existing
  workspace's window restarting its own sidecar) still reloads itself — no
  handoff involved. Exit-gate code (`lib.rs`'s run handler and menu handler)
  checks "any window exists" (`!app.webview_windows().is_empty()`) instead of
  a fixed `get_webview_window("main")` — no window is ever labeled `"main"`
  anymore. **`ConfigLock` (#224)** serializes every config.json
  load-modify-save: a plain `Mutex<()>` in managed state, taken by
  `with_config_mut(app, |file| ...)` (the common case — load an existing v2
  config, apply the closure, save) or `with_config_write_lock(app, || ...)`
  (onboarding/migration commands that may start from v1/Missing and
  construct the initial v2 file themselves, e.g. `migrate_to_workspaces`
  wraps its whole DB-file/Keychain/config sequence, not just the final
  save). Every one of the 11 config-mutating commands goes through one or
  the other. Both are thin `AppHandle`-resolving wrappers around
  `with_config_mut_at(lock: &Mutex<()>, data_dir: &Path, mutate)`, the
  actually-testable core — the unit test spawns two threads sharing one
  lock and one temp `data_dir`, each inserting a distinct workspace, and
  asserts both land (the race the lock fixes: two loads of the same
  pre-write state followed by two saves, the second clobbering the first).
  Phase 2 (#225) is what actually adds a second writer (window open/close
  events) for this to matter against. Model:
  `docs/superpowers/specs/2026-09-01-desktop-multi-window-design.md`.

- **Multi-window desktop, phase 2 (#225): multiple `ws:<id>` windows can now
  actually be open.** `config.json`'s `open_windows: Vec<String>`
  (`#[serde(default)]`) is rewritten by `persist_open_windows` (`open` =
  every currently live `ws:<id>` window's own id from
  `app.webview_windows()`; `active_workspace` is also refreshed there from
  `FocusHistory`'s last entry) whenever a `ws:<id>` window opens
  (`open_window`) or is destroyed (`on_window_event`) — never on a bare
  focus change. `FocusHistory` (managed state, `Vec<String>`, oldest first)
  is the *only* thing focus updates in-memory (`touch_focus` on
  `WindowEvent::Focused(true)`, `untrack_focus` on `Destroyed`); it answers
  both "what should `active_workspace` be" and, via
  `reassign_active_workspace`, "what should it become next" when the
  workspace it currently names gets disabled or deleted (falls back to the
  first remaining enabled workspace, BTreeMap order, if the history has
  nothing useful). Startup (`create_startup_windows` /
  `startup_window_labels`, pure and unit-tested): one window per
  `open_windows` id that's still there and enabled; an empty/fully-invalid
  list falls back to a single window for `active_workspace`; nothing valid
  at all opens `bootstrap`. `set_workspace_enabled(id, false)` and
  `delete_workspace` now refuse ("Nejdřív zavři okno tohoto workspace.")
  while `window_open_for`/`is_window_open_for` finds a `ws:<id>` window —
  this replaces the old "cannot disable/delete the *active* workspace"
  guard (a window can now be open for a NON-active workspace too); "cannot
  delete the last workspace" is unchanged. `create_workspace` opens and
  focuses its new `ws:<id>` window right after `spawn_sidecar_ws`.
  `tauri-plugin-window-state` persists each window's own geometry by label,
  purely on the Rust side (no webview capability needed — its commands are
  never invoked from JS).

- **The workspace switcher opens/focuses a window, it doesn't swap content
  (#226).** `open_workspace_window(id)` (Rust) replaces
  `set_active_workspace` + a full-page reload: focuses the `ws:<id>` window
  if one exists, else creates it (validating the workspace exists and is
  enabled first — `open_window` itself doesn't check).
  `openWorkspaceWindow` (`lib/workspaces.ts`) is the frontend wrapper;
  `switchWorkspace` is gone. The Sidebar dropdown (`WorkspaceSwitcher` in
  `Sidebar.tsx`) is a jump target, not a selection — always resets to a
  disabled placeholder option rather than reflecting the calling window's
  own workspace as "current", and marks each entry `(otevřeno)` from
  `list_workspaces`' new `window_open: bool` (computed live from
  `app.webview_windows()`, not the persisted `open_windows`, so it can
  never lag). `WorkspacesSection.tsx`'s row action is the same command,
  relabelled "Otevřít"/"Přepnout na okno". Cross-window sync: Rust emits a
  broadcast `workspaces-changed` after every successful `with_config_mut`/
  `with_config_write_lock` call (i.e. every config mutation AND every
  window open/close, since #225's `persist_open_windows` also goes through
  `with_config_mut`) — `Sidebar` and `WorkspacesSection` both `listen()`
  for it now instead of the old document-local
  `portuni:workspaces-changed` `CustomEvent`, which only the dispatching
  window itself could ever hear.

- **Quitting closes windows one at a time through their own close guard —
  there is exactly one close-guard implementation, not two (#229).**
  Cmd+Q, menu Quit, an OS-driven exit request (Dock "Quit", session
  logout), and the updater's "Restartovat" all funnel into
  `begin_quit(app, QuitAction::{Exit,Restart})`: it snapshots every open
  window's label into `QuitQueue` (managed state, `Option<QuitState>` —
  `None` means no quit is in progress, the single source of truth
  `is_quitting()` reads), then closes them **one at a time** via
  `window.close()` — the same `tauri://close-requested` event a window's
  own native close button already raises, which the webview's
  `onCloseRequested` listener (`App.tsx`) already guards (dirty editor →
  unsynced files → **running terminals**, new: a plain "Zavřít okno? Běží N
  terminálů, budou ukončeny." confirm — the session-aware
  Ukončit/Pozastavit/Zrušit dialog is phase 3). There is no more separate
  `app-exit-requested` broadcast + `confirmExit()`/`approve_exit` dance —
  `approve_exit` and `EXIT_APPROVED` are gone entirely. `quit_advance`
  (pure: `Option<QuitState> -> QuitAdvance`) decides what happens next —
  close the following queued window, or run the terminal action
  (`app.exit(0)` / kill every sidecar then `app.restart()`) once the queue
  is empty; `on_window_event`'s `Destroyed` handler calls it after every
  window close, quit or not (a no-op — `QuitAdvance::Idle` — outside one).
  Declining (any guard's cancel button, all routed through the shared
  `declineExit()`/`decline_exit` command) calls `quit_abort`: unconditionally
  clears `QuitQueue` to `None`, aborting the whole sequence — windows
  already closed stay closed, but no further one is asked and the app does
  not exit; harmless when nothing was in progress (a plain single-window
  close). The 5s fallback timer (`schedule_exit_fallback`, generation-
  counter design from #221) is now scoped to **whichever window was just
  asked** and force-`destroy()`s only that one on timeout — a safety net
  for a hung/crashed webview, not the normal path. **`open_windows` is
  never rewritten mid-quit**: `persist_open_windows` checks
  `should_persist_open_windows(is_quitting())` first, so the next launch
  restores the pre-quit window set instead of whatever's progressively
  left as each window closes. `on_window_event(Destroyed) →
  kill_all_sidecars` is gone (a sidecar is bound to `enabled`, not to a
  window — an external MCP client addresses it on its fixed port
  regardless of any window, and killing it on every window close was
  already wrong once more than one window could be open); sidecars die
  only in the app-exit `RunEvent::ExitRequested`/`Exit` handler, same as
  before. Rust tests (`quit_sequence_tests`) cover the pure reducer
  end-to-end (closes windows in order, finishes with the right terminal
  action, a decline mid-sequence aborts and clears) and, via
  `with_config_mut_at` against a real temp file, that `open_windows`
  genuinely survives a completed quit unchanged. Window-level behavior
  (does Cmd+Q actually close two real windows in order, does a declined
  dialog actually abort) is macOS-only verification — the container has no
  display.

- **A second launch relays to the first instance instead of starting a
  separate process (#230).** `spawn_sidecar_ws`'s `reap_orphan_sidecar(port)`
  `kill -9`s any foreign `portuni-sidecar` already holding a workspace's
  port, so without this, `open -n` (or a Dock re-click while the app has no
  frontmost window) would run a full second `.setup()` that kills the first
  instance's sidecars out from under it. `tauri_plugin_single_instance::init`
  is registered as the **very first** plugin (Tauri's own requirement) and
  relays a second launch's argv/cwd to `focus_or_open_most_recent_window`
  instead of letting the second process proceed — it exits immediately, so
  it never reaches `spawn_all_sidecars` at all. Target selection
  (`single_instance_target`, pure and unit-tested): the most recently
  focused window (`FocusHistory`'s last entry, #225), else one for
  `active_workspace` (the one caller left using this function — every
  workspace-bound command resolves via `ws_of` instead, and #225's startup
  restore reads the config field directly), else `bootstrap` if there's no
  workspace at all yet. No capability entry needed — the plugin registers
  no invokable commands, only a Rust-side lifecycle hook.

- **"Pozastavit" (suspend a running agent terminal) is one shared
  mechanism, used from two places: the window-close dialog (#231) and the
  node-detail Sessions tab (#232).** `SessionSummary` (REST, `GET
  /nodes/:id/sessions`) gained `terminal_id: string | null` (`toSummary`,
  `apps/server/api/sessions.ts`) so either caller can correlate its own
  local terminal ids (`lib/sessions.ts`'s `TerminalSession.id` — always
  Claude-only, since Codex/Vibe's config format has no header for it) to
  their persistent session rows without a bespoke lookup.
  `apps/web/src/lib/session-suspend.ts` holds the whole mechanism, not just
  decision logic: `correlateSessions`/`suspendableTerminalIds` (pure —
  agent command **and** a correlated `running` session; the session row's
  `cli` column is always `NULL` and can't be used for this),
  `allSuspended`/`suspendPollTimedOut` (pure, the 30s poll's stop
  conditions), and the async orchestration both callers actually invoke:
  `fetchCorrelatedSessions` (one `GET /nodes/:id/sessions` per distinct
  node among the given terminals) and `suspendTerminalsAndPoll` (`pty_write`s
  a plain-English instruction, `SUSPEND_INSTRUCTION`, into each terminal
  asking the agent to call `portuni_session_suspend` on its own initiative
  — there is no other protocol for this, the agent decides — then polls
  every 2s, re-fetching fresh correlated state each tick, until none is
  `running` or 30s pass; returns whether it timed out and leaves "what
  happens to the terminal" to the caller). **The close dialog** (`App.tsx`,
  replacing #229's plain confirm): `onCloseRequested` fetches correlated
  sessions before showing it. **Ukončit**: `killTerminalsAndCloseWindow` —
  `pty_kill` every terminal (this is also what #229's plain-confirm path
  was missing: destroying the window alone never killed its PTYs, since
  `PtyState` is process-wide and a window closing doesn't touch it — the
  child only dies when the whole app exits and every fd, PTY masters
  included, finally closes), then destroys the window. **Pozastavit**
  (`handleSuspendAndClose`, shown only when `suspendableIds` is non-empty):
  calls `suspendTerminalsAndPoll`, then **always** `killTerminalsAndCloseWindow`s
  every terminal in the dialog regardless of outcome; a timeout flips the
  dialog to say so first. **Zrušit**: `declineExit()`, same as the other
  two guards. **The Sessions tab** (`DetailPane.sessions.tsx`'s
  `SessionRow`, #232): `DetailPane` gained a `terminalSessions` prop
  (threaded from `App.tsx`/`WorkspaceView.tsx`'s own `sessions` state, the
  window's live terminal tabs — previously `DetailPane` had no terminal
  concept at all) so a `running` row can show "Pozastavit" when its
  `terminal_id` is in the node-scoped `suspendableTerminalIds` set. Its own
  click handler calls `suspendTerminalsAndPoll` for that one terminal, then
  `pty_kill`s it regardless of outcome (a suspend attempt that's over, one
  way or another, shouldn't leave a stale terminal behind — "Otevřít
  terminál" spawns a fresh one on demand) and reloads the list so the row
  picks up the real state.

- **Backend/PTY events are per-window, not broadcast (#227).**
  `backend-ready`, `backend-error` (`spawn_sidecar_ws`'s reader loop and
  its deferred-central branch), `pty-data` and `pty-exit` all moved from
  `app.emit` to `app.emit_to("ws:<id>", …)` (`emit_to(&label, …)` for the
  PTY pair, keyed off `PtySession.ws_id`/`ws_of` at spawn time, same as
  #223's write-side isolation). This removed the `is_active_ws` gating
  entirely (and the function itself, now `#[allow(dead_code)]` — kept only
  for #230's single-instance fallback) — a per-window target already
  guarantees only that workspace's own window ever receives the event, so
  the old "only the active workspace may emit, else the webview boot
  contract mis-resolves" guard has nothing left to protect against.
  **Replay on window create**: a sidecar can finish booting (or crash)
  before its window exists — `spawn_all_sidecars` races window restoration
  at startup — so `open_window` calls `replay_backend_status` right after
  building a `ws:<id>` window: `backend-ready` replays from `BackendPorts`
  if a port is already known, `backend-error` replays from
  `PendingBackendErrors` (managed state, last error message per
  workspace, `set_pending_backend_error`/`clear_pending_backend_error` —
  cleared on the next `backend-ready`) if one is pending. Both use pure
  cores (`backend_status_replay`, `record_pending_backend_error`,
  `retire_pending_backend_error`) unit-tested against plain
  `HashMap`s/tuples rather than real managed state. This is what makes
  `useAppUpdate`'s check-timer bootstrap (`updater.ts`, starts only from
  `backend-ready`) work in a restored window without any JS change — the
  webview's `listen()` doesn't care whether Rust used `emit` or
  `emit_to`.

- **localStorage is namespaced per workspace (#228).** All windows share
  one webview origin, so a plain key would leak between windows — which
  nodes are open (`openNodes`), which file-tree folders are collapsed
  (`fileTreeCollapsed`), the workspace view's detail-pane visibility
  (`workspace.detailVisible`), and central mode's first-login guidance
  flag (`first-steps-pending`) are all keyed `portuni:<ws_id>:<key>` now
  (`apps/web/src/lib/workspace-storage.ts`). `currentWorkspaceId()` reads
  this window's own workspace id straight from `getCurrentWindow().label`
  (`"ws:<id>"`, stripped) — synchronous, no IPC round trip, since Tauri
  injects that metadata before any page JS runs. `scopedKey(key)` is the
  per-call helper (`namespacedKey(wsId, key)` when a workspace is known,
  else the old unscoped `portuni:<key>` shape — a plain browser/vite-dev
  build has no workspace concept, same fallback every other Tauri-only
  feature in this codebase uses). **One-time migration**:
  `migrateUnscopedStorageForCurrentWindow()` runs synchronously in
  `main.tsx`, before the React tree renders and before anything (notably
  `CentralLoginGate`'s mount-effect `first-steps-pending` check) could read
  a workspace-scoped key — moves each old unscoped key into this window's
  namespace, then deletes it; idempotent, and never clobbers a namespaced
  value that already exists (first window/launch to run it wins). Its pure
  core (`migrateUnscopedStorage`, operating on a `StorageLike` interface)
  is unit-tested in `test/workspace-storage.test.ts`, server-side via
  `tsx`, same pattern as `test/sessions-helpers.test.ts` importing from
  `apps/web/src/lib/*.js`. `theme`, `agentCommand`, `terminalLaunch` stay
  global/unscoped by design (user preferences, not workspace state) —
  `App.tsx` now also subscribes to the native `storage` event (fires in
  every OTHER window when one writes, since they share an origin) so a
  change in one window's Settings applies live in every other one instead
  of only taking effect on that window's own next mount.

- **Env vars beyond `.env.schema`:** the server reads ~27 `process.env`
  keys; `.env.schema` declares only the 7 core ones. Full inventory with
  defaults: `docs/env-vars.md`. Watch out: `PORTUNI_ROOT` (write-scope
  tiering) is a different thing than `PORTUNI_WORKSPACE_ROOT` (mirrors).
- **`PORTUNI_WEBVIEW_PROXY_SECRET`** (#213), when set, hardens the
  `env`-mode REST write gate's blanket exemption: a request then needs a
  valid `X-Portuni-Webview-Proxy` header (proven against this var) OR a
  resolvable `X-Portuni-Spawn-Id` session to write via REST — everything
  else is refused outright. Unset (the default for the backend-tmux + Vite
  dev loop and the whole test suite) keeps the legacy behavior: every
  env-mode REST write allowed, unchanged. The packaged desktop app's Tauri
  host always sets this itself (fresh per launch, never on disk, never
  exported into a spawned terminal) — the hardened posture is always on
  there. Doesn't affect MCP tool calls either way — those keep `env`'s
  existing unscoped-write behavior, out of scope for this gate. See
  `docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md` and
  the scope-enforcement docs page.
- **Disk read scope = the session scope, on REAL paths for the seed set, a
  hardlink projection for everything else.** The MCP `SessionScope` is the
  single source of truth. The Seatbelt profile grants rw on the home mirror
  and **read-only on the REAL mirrors of the depth-1 neighbour set** (the
  stable spawn scope), computed at spawn — locally from the graph, in central
  mode from `CentralClient.nodeNeighbours` (`sandbox-profile.ts`
  `readMirrors` / `resolveNeighbourReadMirrors`). It also grants read-only on
  a per-node **projection parent**, `<portuniRoot>/.portuni-sessions/
  <homeNodeId>/` (`SandboxScope.projectionRoot` /
  `resolveProjectionRootForNode`), narrowed further to
  `<projectionRoot>/<sessionId>/` when the session id is already known
  (`SandboxScope.sessionId`, #208 follow-up) — a fresh spawn mints one in
  `resolveSandboxScopeForNode` (central mode, `db` absent, always mints
  fresh rather than trusting an unvalidated caller-supplied
  `resumeSessionId`) and returns it as `session_id` on the sandbox-profile
  REST response; a resume reuses its already-validated `resumeSessionId`.
  Threaded to the spawned shell as `PORTUNI_SPAWN_SESSION_ID`
  (`pty_spawn`'s `spawn_session_id`), then to the MCP connection via a
  `X-Portuni-Spawn-Id` header (`buildClaudeMcpJson`, Claude-only like
  `X-Portuni-Profile`) that `mcp/transport.ts` hands to
  `domain/sessions.ts`'s `createSession` as a pre-assigned id, so the
  session row's own id matches what the kernel already granted. **Non-relaying
  CLIs (#211 fix):** a real spawn always mints a `sessionId`, so the kernel
  cannot tell in advance which CLI is about to connect and grant only the
  narrow subdirectory for it — `buildSeatbeltProfile` grants BOTH
  `<projectionRoot>/<sessionId>/` (works when the connecting CLI relays that
  id back, Claude only today) AND a second, fixed
  `<projectionRoot>/_shared/` bucket (`session-projection.ts`'s
  `UNNARROWED_PROJECTION_ID`) unconditionally — neither is an ancestor of
  the other, so isolation between different sessions' own narrow
  subdirectories still holds. `mcp/scope.ts`'s `SessionScope
  .projectionSessionId` (set synchronously by `createMcpServer`, before any
  tool call could race a persisted session id) resolves to the resumed
  session's own id, the relayed spawn id, or the shared bucket, in that
  order — the disk projector and `disposeSessionProjection` key off this,
  not off the persisted `sessionId`. **Ad-hoc nodes** (deeper than depth-1,
  added mid-session by `expand_scope` or an auto-allowed edge traversal) get
  hardlinked there — `<projectionRoot>/<projectionSessionId>/<nodeId>/`, no
  data duplication, always current — by the disk projector
  (`mcp/disk-projection.ts` `DiskProjector`, `domain/session-projection.ts`)
  the first time a read tool touches them; the mirror-watcher re-links/
  removes the hardlink on every create/delete in the source mirror, and a
  narrow (non-shared) session's own subdirectory is cleaned up when its MCP
  session closes (`disposeSessionProjection`) — the shared bucket is never
  torn down purely because one session's own close happens to key off it,
  since other concurrent non-relaying sessions on the same node may still be
  reading it. It IS bounded (#214, closing the leak #211 left): removed
  outright once nothing is `running` on that home node anymore (checked both
  at every session close and, as a backstop, in the boot sweep
  `sweepStaleSessionProjections`), and reconciled in place while at least
  one session is still running (hardlinks whose source mirror file is gone
  are pruned, same "source is gone" condition `relinkProjectedFile` already
  handles for the live/watched path). Relaying the spawn id for Codex/Vibe
  the way Claude's header does — so they'd land in the narrow per-session
  directory instead of `_shared` at all — turned out not to be
  implementable with either CLI's current config format: Codex has no
  per-mirror MCP registration whatsoever (global `~/.codex/config.toml`
  only, scope-materialize.ts's `.codex/config.toml` is sandbox-only), and
  Vibe's per-mirror `url`/`headers` fields are static strings materialized
  once at mirror creation with no runtime env-var expansion outside the
  auth-token-specific fields (`api_key_env` et al.) — confirmed against
  Mistral's own docs — so a literal session id embedded there would go
  stale after the very first spawn on that mirror. `_shared` staying
  bounded rather than actually narrowed is the accepted outcome for those
  two CLIs; see the #214 issue comment for the full reasoning and a
  possible follow-up (rematerializing the per-mirror config synchronously
  from the sandbox-profile endpoint on every spawn) — the agent never
  manages any of this cleanup.
  Read tools (`get_node`/`get_context`/`list_files`) and
  `portuni_expand_scope` return that path via `readableMirrorRoot`; a node
  with **no local mirror on this device** has no projection either way — read
  it with **`portuni_read_file(node_id, path)`** (`read-node-file.ts`), the
  universal no-hooks channel that always works. **Restart consolidation**: a
  resumed session passes `?resume_session_id=<id>` on either sandbox-profile
  REST endpoint so `readMirrors` also widens with that session's accumulated
  read set (real mirrors, not re-projected) — local mode only, central mode
  is inert here (`NO_DB`). The old `.portuni-scope/`
  copy staging and its `ScopeReconciler` sweeper are fully retired (no
  successor of that name — `disk-projection.ts` is a clean rename, not a
  continuation). Remaining gap: `onclose` cleanup only runs on a graceful
  session end, so a crashed process leaves its hardlinks behind until the
  next boot; `sweepStaleSessionProjections` (`session-projection.ts`), run
  once at boot from both entry points (`boot/session-projection-sweep.ts`),
  removes any `<sessionId>/` subdirectory whose session is not `running` in
  the durable `sessions` table. The kernel actually refusing a second
  session's read into the first's narrowed `<sessionId>/` grant is macOS-only
  verification territory (a live `sandbox-exec` run) — the plumbing above is
  covered by tests, that live check is not. Model:
  `docs/architecture/scope-disk-projection.md`; plan:
  `docs/superpowers/plans/2026-07-06-scope-real-paths.md`.

- **No automatic first prompt on spawn.** A terminal opened from a node
  detail (`buildAgentCommand`, `apps/web/src/lib/prompt.ts`) starts empty
  and ready — the app never sends an orientation message. What that prompt
  used to fetch (node context, responsibilities, recent events, a handoff
  pointer for a suspended session) is written into `PORTUNI_SCOPE.md`
  instead (`domain/write-scope.ts` `buildOrientationHint`,
  `domain/scope-materialize.ts` `orientationForNode`) — appended there only,
  never into `.cursor/rules` or the `CLAUDE.md`/`AGENTS.md` marker blocks,
  which stay on the terser write-scope hint. Central-mode mirrors get the
  write-scope hint but no orientation section: `CentralClient` has no
  endpoint for it yet, a deliberate scope cut, not a bug. Agent-command
  presets carry no `{prompt}` placeholder anymore (`apps/web/src/lib/
  settings.ts`); `TerminalPane.tsx` times spawn phases (provisioning ->
  `pty_spawn` -> CLI boot to first byte) and prints/logs a one-line
  breakdown on first output.
- **CLI spawn profiles are a desktop `config.json` registry, opt-in and
  invisible until populated.** Settings → Profily (`ProfilesSection.tsx`,
  `lib/profiles.ts`) manages `profiles`/`default_profile_by_org` on
  `WorkspacesFile` (`apps/desktop/src/workspace.rs` `ProfileConfig`) via
  the `list_profiles`/`create_profile`/`update_profile`/`delete_profile`/
  `set_default_profile_for_org` Tauri commands — non-secret, so it lives
  alongside the workspace registry rather than Keychain. Portuni never
  detects or parses the user's own profile mechanism (shell aliases, rc
  files); a profile is just env vars (typically `CLAUDE_CONFIG_DIR=…`) and
  an optional command override, merged into the shell by `pty_spawn`
  (`apps/desktop/src/pty.rs`) when the caller passes a `profile_id`. With
  zero profiles registered the feature is invisible everywhere; the
  per-spawn picker (`TerminalSplitButton` in `DetailPane.files.tsx`) only
  renders once >=2 exist, defaulting to the node's organization's
  configured profile (derived from `belongs_to` in `node.edges`) — with
  exactly one profile and no org default set, spawns still carry no
  profile. `pty_spawn` also exports `PORTUNI_PROFILE_ID` into the shell
  whenever a profile id was requested (even one since deleted from the
  registry, so the session record still reflects intent); the per-mirror
  `.mcp.json`'s `X-Portuni-Profile` header (`buildClaudeMcpJson`,
  `write-scope.ts`) expands it at Claude Code's config-load time the same
  way the bearer token is — Claude only for now (Codex/Vibe's config
  formats have no equivalent runtime expansion for a second header).
  `transport.ts` reads that header and threads it through
  `createMcpServer`/`bindSessionPersistence` into the session row's
  `profile_id` column (`domain/sessions.ts`, columns pre-provisioned since
  #189). Profile threading stops at the embedded terminal: `TerminalSplitButton`'s
  external-launch path (`launch_claude_for_node`) has no `profile_id`
  parameter at all, so picking a profile and choosing "Otevřít v externím
  terminálu" spawns without it (#207) — deliberately not extended, since
  that command doesn't inject even the MCP-token/`PORTUNI_PROFILE_ID` env
  `pty_spawn` does either. **Env values never reach the webview** (#207):
  `list_profiles` returns `env_keys` (names only), never the map itself, so
  editing an existing profile is a partial update (`update_profile` treats
  an empty submitted value for an already-known key as "leave unchanged" —
  `ProfilesSection.tsx` pre-fills existing keys with an empty value for
  exactly this reason). `create_profile`/`update_profile` also reject
  secret-shaped keys outright (`*_TOKEN`/`*_KEY`/`*_SECRET`/`*PASSWORD*`,
  `workspace::is_secret_shaped_env_key`) — Keychain is where a secret
  belongs, not this plaintext registry. `pty_spawn`'s merge
  (`resolve_profile_env`) drops any `PORTUNI_*` key from a profile's env
  (it must never be able to override the token/profile-id env already set)
  and expands a leading `~` in each value to `$HOME` (reusing lib.rs's
  `expand_tilde`, `pub(crate)` for this) — portable-pty passes values to the
  child verbatim, no shell involved, so `~` is otherwise left literal.
- **A durable session row learns its PTY died via a server call, not a
  local signal.** `pty_spawn` exports `PORTUNI_TERMINAL_ID=<terminal id>`
  (the frontend's `term_<node>_<ts>_<rand>`, i.e. `args.session_id` — no
  separate id is minted); a Claude Code connection threads it through
  `X-Portuni-Terminal` (Claude-only env-expansion, same channel as
  `X-Portuni-Profile`/`X-Portuni-Spawn-Id`) into the session row's
  `terminal_id` column. On PTY exit — `pty_kill`, the user typing `exit`,
  or a crash — the reader thread's EOF/error path in `apps/desktop/src/
  pty.rs` (`report_terminal_exit`) POSTs to the *owning workspace's*
  sidecar (`ws_id` captured on `PtySession` at spawn time, not re-resolved
  at exit) at `POST /terminals/:terminal_id/exit`, which moves every
  `running` session sharing that `terminal_id` to `closed` (#218/#219).
  Best-effort: failure just leaves the row until the MCP transport's idle
  GC backstop (`transport.ts`'s `onclose`) closes it, the same backstop
  that covers Codex/Vibe (no header support) and crashes that never reach
  the reader thread's exit path. Like `api_request`'s webview proxy, this
  call carries `X-Portuni-Webview-Proxy` (`lib.rs`'s `webview_proxy_secret`)
  when the hardened posture (#213) is active for that workspace — it
  originates from the same trusted Tauri host process, not a spawned
  terminal.

## Security rules (from the auth refactor post-mortem)

1. **No secret in webview JS, ever.** If a JS module needs to know it, it
   can be exfiltrated trivially. The webview calls the `api_request` Tauri
   command; the Rust proxy injects the bearer header.
2. **No secret in plaintext on disk.** OS keychain (or varlock) only.
3. **Webview ↔ backend through Tauri commands, not direct HTTP.** Tauri's
   capabilities allowlist already enforces the trust boundary.
