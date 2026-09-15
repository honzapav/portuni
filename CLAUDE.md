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
#
# cargo comes from the brew rustup keg, which is NOT linked into
# /opt/homebrew/bin: without this PATH the script dies on
# `env: cargo: No such file or directory`, in an interactive shell as
# well as a spawned one. Node is missing from a spawned shell too (nvm
# loads from ~/.zshrc) — add ~/.nvm/versions/node/<version>/bin there.
PATH="/opt/homebrew/opt/rustup/bin:$PATH" \
  APPLE_SIGNING_IDENTITY='Developer ID Application: JAN PÁV (98H25UC996)' \
  scripts/build-signed.sh --no-notarize

# Quit the app first, and REMOVE the old bundle before copying: `cp -R`
# over a live bundle merges the two and breaks the code signature
# ("a sealed resource is missing or invalid"), which costs the whole
# Keychain trust the signed build exists to keep.
rm -rf /Applications/Portuni.app
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
| Ship new `.app` | Signed build | `scripts/build-signed.sh` + `rm -rf` + cp (never adhoc) |

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
  **pre-release** that is also not the repository's "Latest" (`release.yml`
  fails the build if either is untrue). The rollout is
  `scripts/release-rollout.sh promote vX.Y.Z`, the rollback
  `scripts/release-rollout.sh rollback vX.Y.Z v<previous>`. **Never promote
  by clearing the pre-release flag alone** — that is two independent flags,
  and `releases/latest` (which both the updater and the website's download
  link resolve through) follows the *other* one, the `make_latest` pin;
  `gh release edit --prerelease=false` never sends it. Full flow + one-time
  PAT setup: `CONTRIBUTING.md`, `docs/release-process.md`.
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
  everything goes through the central server. **A local workspace (neither
  `PORTUNI_AUTH_MODE=google` nor `PORTUNI_AGENT_MODE=1` —
  `infra/server-config.ts`'s `isLocalWorkspace()`) cannot register or route
  to a remote (#310).** `upsertRemote`, `setupRemoteService` and
  `setRoutingPolicyService` (`domain/sync/routing.ts`,
  `domain/sync/remote-service.ts`) all throw `LocalModeNoRemoteError` (code
  `LOCAL_MODE_NO_REMOTE`) there instead of writing `remotes`/
  `remote_routing` — collaboration is central mode's job. (The per-user
  Drive OAuth connect flow that also used to throw this, `connectDrive`/
  `setDriveTarget`, is gone entirely as of #311 — see the Drive gotcha
  below.)
  A local workspace with pre-existing rows from before this rule logs one
  warning at boot (`boot/local-mode-remote-warning.ts`, the only reader of
  the raw rows via `legacyRemoteRowCounts`) and otherwise behaves as if the
  rows were not there: `resolveRemote`/`listRemotes`/`listRules` answer
  null/empty on a local workspace, `getAdapter` refuses with the same error
  as a backstop, and `deleteFile`/`moveFile`/`renameFile`/`renameFolder`
  ignore a legacy row's `remote_name` and touch only the local copy and
  the row (`moveFile` clears `remote_name` on the way). `statusScan`'s local
  branch (below, #312) ignores `remote_name` outright too, so legacy rows
  cannot resurface push/pull/conflict classifications. The MCP tool wrapper
  (`mcp/server.ts`'s `typedToolError`) returns `LocalModeNoRemoteError` as
  an `isError` result carrying `code`, the same code REST's `respondError`
  sends as 409.
- **File state is deterministic, not agent-driven.** A mirror watcher
  (`apps/server/domain/sync/mirror-watcher.ts` → `reconcile.ts`) registers new
  files and reconciles edits/deletes on every disk change, so the UI's sync
  status (`statusScan`, which reads `file_state.cached_local_hash`)
  is current without anyone calling `portuni_store`/`portuni_status`. In
  central mode the scan is ONLY that read -- `statusScanCentral` has no
  `fast` parameter; re-deriving what the device does not know is the sync
  run's own reconcile pass (`resolveUnknownRemotes`), never a mode of
  reading. **A local workspace never has a remote at all (#310), so its own
  scan dropped `fast` too (#312)**: `statusScan` computes `isLocalWorkspace()`
  once and short-circuits every row before it would touch an adapter --
  tracked + present reads `clean`, tracked + gone from disk reads
  `deleted_local`; `push`/`pull`/`conflict`/`remote_*` cannot occur there.
  `cachedRemoteStat`/`getRemoteStats` (the local engine's own TTL cache
  wrapping `local-db.ts`'s `remote_stat_cache`) are gone with it -- the
  table itself, `RemoteStatRow`, and the singular `getRemoteStat`/
  `upsertRemoteStat` stay, since `engine-central.ts` (untouched by #312)
  still uses them for its own remote-hash observation cache. The **non-local**
  remaining caller of this same `engine.ts` (a server run with
  `PORTUNI_AUTH_MODE=google`, i.e. the central server itself, which — unlike
  an agent-mode device — still reaches `engine.ts` directly if it happens to
  carry its own local mirrors) keeps the old always-live classification,
  just without the persisted stat cache. Registration is local-only
  (`registerLocalFile`, no upload); a file on a genuinely local workspace
  then reads as `clean` (nothing to push to, ever); on a workspace where a
  remote CAN resolve (central server, routing configured) it reads `push`
  until a deliberate `portuni_store` pushes it. **Registration never
  requires a remote.** A local-only workspace (no remote/routing configured
  at all) still tracks every file — `registerLocalFile` and its
  central-mode/REST equivalents (`registerFileRecordRemote(s)`) leave
  `remote_name` NULL instead of throwing when routing does not resolve;
  `remote_path` is still always computed (it is derived purely from the
  node's own identity, never from the remote). `idx_files_unique_remote` is
  keyed on `(node_id, remote_path)` alone (migration 031) so a later
  `storeFile`/write on the same path backfills `remote_name` onto the
  existing row instead of creating a duplicate. `storeFile`/`pullFile`/
  `runNodeSync`/`snapshotService` refuse with `LocalModeNoRemoteError`
  (`LOCAL_MODE_NO_REMOTE`) on a local workspace, checked before any other
  work; on a workspace where a remote can resolve, `storeFile` still
  requires one and throws `ROUTING_GUIDANCE` otherwise — that guidance
  belongs at the moment of a deliberate sync, not at registration. Web:
  `SyncBar`/`SyncOverview`'s "Synchronizovat" actions and the file row's
  "Obnovit" (restore) button are hidden on a local workspace (`useDataMode()`
  gating in `DetailPane.tsx`/`SyncOverview.tsx`), not merely disabled --
  there is nothing they could ever do there.
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
  **A directory `mv` is walked, not no-op'd (#253).** `fs.watch` fires
  exactly one event for a directory that was created or moved into place —
  never a separate event per (unchanged) child — so a single-file `mv`'s
  inode pairing (`reconcile.ts`'s `tryApplyDiskMove` /
  `tryApplyDiskMoveCentral`, matched by `file_state.cached_ino/cached_dev`)
  never used to run for a directory `mv` at all: `reconcilePath`/
  `reconcilePathCentral` treated any directory path as a flat no-op. Both
  now recurse into a directory that exists on disk (`reconcileDirectory` /
  `reconcileDirectoryCentral`) and reconcile every file inside at its own
  current path, so each one gets paired exactly as if it had fired its own
  mv event. The backfill sweeps (`dbBackfillMirror`,
  `centralBackfillMirror` in `apps/server/desktop.ts`) are the catch-up path
  for a `mv` that happened while nothing was watching (server down, or a
  missed directory event) — both are now routed through
  `reconcilePath`/`reconcilePathCentral` per untracked file instead of a raw
  batch register, so the same pairing applies there too instead of always
  producing a fresh duplicate record. `StatusResult.moved` (a bucket nothing
  ever populated, by design — pairing happens at reconcile time, not scan
  time) was removed rather than kept as a permanently-empty field. The
  watcher's projection relink (`relinkProjectedFile`) walks a directory
  event the same way (`relinkTree`), so a moved subtree shows up in every
  live session projection too. **That walk must never re-create a link that is
  already current**: on macOS `link(src, dest)` fires an fs.watch event for
  the SOURCE file's parent directory even though `dest` lies outside the
  watched mirror (unlink alone fires nothing), so a relink that redoes
  links it just made produces exactly the directory event that triggers
  the next walk -- an expanded 121-file node was rebuilt every ~1 s with
  the sidecar pinned at 80-94 % CPU (v0.13.10, Asana 1218416968309091).
  `isCurrentLink` (same inode + device) short-circuits both `relinkTree`
  and `relinkOne`; only a missing dest or a replaced inode (atomic save)
  relinks. A push (`storeFile`/`storeFileCentral`)
  stats the file before reading the bytes it uploads and re-stats after;
  if the identity moved mid-upload it caches the CURRENT content hash, not
  the pushed one — fast status trusts `cached_local_hash` outright, so an
  edit landing during the background push after create must read as `push`.
  **Deleting a file removes the local mirror copy too, in every data mode
  (#254).** `deleteFile`'s local `rm` used to be nested inside the
  `remoteName && remotePath` gate that guards the remote-object delete, so a
  row registered while routing had not resolved (`remote_name` NULL, but
  `remote_path` is always computed regardless — #201) skipped the local
  delete entirely: the DB row and `file_state` vanished but the file
  survived on disk, and the next backfill sweep re-registered it. The local
  `rm` now runs whenever `mode === "complete"` and a local path resolved,
  independent of whether there was anything to delete remotely. Central/
  agent mode had the same gap for a completely different reason: the file
  lifecycle (`POST /nodes/:id/files`, rename, delete) is adapter-direct on
  the central server by design (it has no device mirror to clean up), so
  `DELETE /nodes/:id/files/:fileId` deleted the record + remote object with
  no local step and no `deleteFileState` call at all. `is_local_only_path`
  (`apps/desktop/src/lib.rs`) now routes that sub-path (single segment
  after `files/`) to the local sync agent instead of straight to
  central; `agent-router.ts`'s new handler calls the same
  `CentralClient.deleteFileRecord` a non-agent-mode delete would hit for the
  record + remote half, then runs the local `rm` + `deleteFileState` itself
  afterward — the same shape as the GH #78 fix already gave the MCP
  `portuni_delete_file`/`portuni_move_file` tools
  (`agent-tools.ts`'s `isProxiedDiskMutation`/`applyLocalAfterProxiedMutation`),
  just for the REST path the web UI's "Smazat" button actually uses. The
  `/files` POST routing gap is the same class of bug but belongs to #266,
  not this fix. **`POST /files/:fileId/resolve` had the identical gap
  (#264)**: `agent-router.ts` already resolved conflicts correctly against
  the device's own mirror (`findEntryByFileId` +
  `storeFileCentral`/`pullFileCentral`), but `is_local_only_path` never
  routed the desktop UI's REST call there — it went straight to central,
  which has no mirror at all (409 `keep_local`, 500 `take_remote`/
  `restore`). Fixed the same way as the delete route: one more sub-path
  match (`files/<fileId>/resolve`, alongside the existing bare
  `files/<fileId>` for delete); `files/<fileId>/rename` followed for the
  same reason (see the #266 paragraph).
  **`POST /nodes/:id/files` (create) got the same routing fix, for a
  different reason (#266).** Central's own create is adapter-direct — it
  does the Drive `PUT` before answering — so a device with a mirror never
  got a sync baseline for the new file before the editor's own local-only
  save landed; the watcher then classified it a permanent conflict (local
  hash, no `last_synced_hash`, remote hash `md5("")`) instead of an
  ordinary unpushed file — `classifyRecord`'s "no baseline → conflict" rule
  is correct given those inputs, the inputs were just wrong. `is_local_only_path`
  now routes `POST /nodes/:id/files` (bare, `sub == "files"`) to the
  sidecar unconditionally; `agent-router.ts`'s handler itself decides per
  node: with a mirror, it writes the file into the mirror and calls
  `registerLocalFileCentral` (record-only, no Drive call) so the response
  comes back **without waiting on the Drive upload** — the addendum on the
  issue was explicit that this must stay instant, since central's own
  ~2s-to-answer create was itself part of the UX problem — then fires
  `storeFileCentral` in the background (not awaited; a failure is logged,
  not surfaced, same as any other watcher-adjacent best-effort push). Until
  that lands the row reads as an ordinary `push` classification (registered,
  `current_remote_hash` null, local hash cached), then `clean` once the
  background push's `upsertFileState` writes `last_synced_hash` — exactly
  the same lifecycle a file created directly in the mirror already has.
  That upload is tracked per mirror path (`pendingPushes`); a delete or
  resolve on the same file awaits it (`awaitPendingPush`) so the
  `adapter.put` cannot land after the record is gone and resurrect the
  remote object. `POST /nodes/:id/files/:fileId/rename` is routed to the
  sync agent too: central keeps the record + remote step
  (`CentralClient.renameFile`), the handler waits for a pending upload on
  that path, then renames the device's mirror copy and refreshes its hash
  cache — forwarding straight to central used to leave the local file
  under its old name (missing locally + a new untracked file on the next
  scan).
  Without a mirror on this device, the handler falls back to a new
  `CentralClient.createFile` method wrapping the same `POST
  /nodes/:id/files` central already serves (mirror-less, adapter-direct) —
  central is reached this way, not by the desktop proxy, since the route is
  now local-only for every node regardless of whether THIS device happens
  to mirror it.
- **Drive sync has one auth path: the service account, on central mode
  only.** Collaboration is central mode (#310/#311,
  `docs/superpowers/specs/2026-09-11-one-collaboration-mode-design.md`) — a
  local workspace cannot register or route to a remote, so the per-user
  Drive OAuth connect flow that used to live at Settings → Synchronizace is
  retired. `drive-adapter.ts` picks auth from the token's
  `service_account_json` only, via `drive-sa-auth.ts`
  (`assertSaDriveConfig` forces a `shared_drive_id` — service accounts have
  no My Drive quota, so My Drive targets are not supported). Domain logic is
  `remote-service.ts` (`setupRemoteService`/`setRoutingPolicyService`/
  `listRemotesService`, admin-tier, refused on a local workspace by
  `LocalModeNoRemoteError`), configured via `portuni_setup_remote` (MCP-only;
  `setup-drive-remote` prompt walks the steps) — there is no REST or web UI
  for connecting Drive. `apps/web/src/components/SyncSection.tsx` (Nastavení
  → Synchronizace) is an informational stub: central mode shows the
  server URL, a local workspace shows a one-line "local mode, no remote"
  note; both show mirror-watcher errors, unrelated to Drive.
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
  the node's Relace. **„Nová prezentace" is the same handoff before there
  is a deck** (spec: `docs/superpowers/specs/2026-09-13-showtime-new-deck-design.md`).
  `POST /auth/handoff` answers `mirror` next to the code; the desktop
  `new_in_showtime { node_id }` (`ws_of`, shared `mint_showtime_handoff`)
  refuses without a mirror, checks `<mirror>/wip` is inside the root
  (`showtime_new_dir`) and opens `showtime://new?dir=…&portuni=…&code=…`
  (`showtime_new_url`). The web's split (`NewFileSplitButton`, decided by
  the pure `lib/new-file-menu.ts`) exists only with the integration on and
  Showtime found, and is disabled without a mirror. Portuni does nothing
  after the link: Showtime creates the bundle, the watcher registers it.
  Spec: `docs/superpowers/specs/2026-09-02-showtime-handoff-design.md`.
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
- **Auth mode**: `PORTUNI_AUTH_MODE=env` (default) = solo bearer token; `google` = Google OAuth + Groups. Enforcement lives server-side in `apps/server/auth/` (min-scopes per tool, node-access for group visibility). Scope tiers (`min-scopes.ts`): `read` = read only (no group needed); `write` = everyday editing (create/update nodes, edges, actors, responsibilities, data sources, tools, events, files); `manage` = move_node, sharing (`PUT /nodes/:id/access`, access requests), positions; `admin` = deletes, users, `setup_remote`, routing policy. Each `PORTUNI_GROUPS_*` var is a comma list.
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
  `google_login`/`auth_refresh`/`auth_logout`/`central_request` (`load_auth_config`
  now takes an explicit `ws_id` instead of resolving it itself). The
  `portuni-html` URI scheme handler resolves the same way
  from `ctx.webview_label()` via `ws_of_from_dir` (no `tauri::Window` object
  available there, just the label). App-global commands (workspace
  list/CRUD, updater, clipboard, `open_external`, exit,
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
  unsynced files; runs belong to the sidecar and survive a window close, so
  there is no third guard). There is no more separate
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

- **The embedded terminal is gone (#345, runner batch phase 4).** There is
  no PTY, no xterm, no Seatbelt profile fetched by the desktop, no spawn
  profiles registry and no terminal branch in the window close guard —
  `apps/desktop/src/pty.rs`, `TerminalPane.tsx`/`TerminalTabs.tsx`,
  `lib/session-suspend.ts`, `lib/prompt.ts`, `lib/profiles.ts` and the
  `AGENT_PRESETS`/`TERMINAL_PRESETS` settings were deleted. An agent runs
  only as a task (`POST /sessions`, `SessionChat`), per
  `docs/superpowers/specs/2026-09-12-runner-and-session-design.md`; the
  server-side leftovers of the terminal model (`X-Portuni-Terminal`,
  `POST /terminals/:id/exit`, `sandbox-profile.ts`, the hardlink
  projection) are #346's removal and still exist until then, with nothing
  on the desktop calling them. What survived from `pty.rs`:
  `auth::ensure_device_token` (the central-mode sync agent's device token,
  label "Sync agent") and `shell_path::login_shell_path` (the sidecar
  needs a login shell's PATH to find `claude`).

- **Backend events are per-window, not broadcast (#227).**
  `backend-ready`, `backend-error` (`spawn_sidecar_ws`'s reader loop and
  its deferred-central branch) moved from `app.emit` to
  `app.emit_to("ws:<id>", …)`. This removed the `is_active_ws` gating
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
  `apps/web/src/lib/*.js`. `theme` stays global/unscoped by design (a user
  preference, not workspace state) —
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
  there. The central-mode sync agent (`api/agent-router.ts`) applies the
  same posture through `guardAgentRestWrite` on every mutating REST route
  it serves (file create/delete/resolve, `PUT /nodes/:id/file`, sync run,
  mirror create): it has no graph db or session table to resolve a spawn
  id against, so a proven `X-Portuni-Webview-Proxy` header is the only
  accepted proof once the secret is set — a spawned terminal mutates
  through the MCP tools, which central write-gates. Doesn't affect MCP
  tool calls either way — those keep `env`'s
  existing unscoped-write behavior, out of scope for this gate. See
  `docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md` and
  the scope-enforcement docs page.
- **Disk read scope = the session scope, on REAL paths for the seed set, a
  hardlink projection for everything else.** (Server-side model from the
  terminal era; the desktop no longer fetches a sandbox profile or spawns
  under Seatbelt since #345, and #346 removes this whole layer. Kept here
  verbatim until then.) The MCP `SessionScope` is the single source of
  truth. The Seatbelt profile grants rw on the home mirror
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
  **Seed/grant skew and central-mode projection (#252).** `readableMirrorRoot`
  used to trust `scope.isSeed()` outright and return the real depth-1 mirror
  path -- but that in-memory seed set is recomputed at MCP *connect* (after
  the Seatbelt profile is already frozen at spawn), so a mirror registered or
  an edge created in that gap could make a node look seed-granted without the
  kernel ever having granted its real path. `DiskProjector.projectNode` now
  hardlinks EVERY non-home in-scope node, seed or ad-hoc (only the home node
  is skipped, reason `seed_granted`), and `readableMirrorRoot` prefers that
  projection over the real mirror for a seed node too (falling back to the
  real path only when nothing was projected yet) -- cost is a hardlink, nil.
  `projectNode` returns a `ProjectOutcome` (`{kind:"projected",dir,files}` or
  `{kind:"not_projected",reason}`, reasons `seed_granted | no_mirror |
  out_of_scope | no_projection_root | central`) instead of a bare nullable object; every
  caller (`get-node.ts`, `context.ts`, `files.ts`'s `list_files`,
  `expand_scope`) unwraps it, and `expand_scope` surfaces the reason map as
  `not_projected` alongside `projected`. **Central/agent mode now projects
  too**: `agent-transport.ts` builds its own tiny `ProjectorScope` per local
  MCP session (home node id from `?home_node_id=`, `has` always true since
  central's own `guardNodeRead` already ran, `projectionSessionId` the spawn
  id relayed in `X-Portuni-Spawn-Id` -- the same header `transport.ts` reads
  in local mode; both accept it only as a well-formed ULID
  (`spawnSessionIdFromHeader`), since the value becomes a path segment that
  is `rm -rf`'d on close, and `sessionProjectionDir`/`nodeProjectionDir`
  refuse any non-single-segment key outright -- or `_shared` when the CLI
  cannot relay one; NEVER the
  transport's own random MCP session id, since the Seatbelt profile was
  frozen at spawn around exactly `<projectionRoot>/<spawn id>/` and
  `_shared/`, so any other key would be a directory the kernel never granted)
  and a real `DiskProjector` over it: `portuni_expand_scope`'s
  `projected`/`not_projected` are overlaid with this device's own result
  (central's own is structurally useless, no device filesystem), and
  `enrichGetNodeResult`/`enrichGetContextResult` (`agent-tools.ts`) fill
  `readable_path`/`local_path` the same way for ANY node with a local mirror
  here, not just the depth-1 seed set (`files[].local_path` is derived under
  that same readable root, and `get_context`'s wire shape is the flat
  `[root, ...connected]` array, not `{root, connected}`). Cleanup rides on the local transport's
  own `onclose` (`disposeAgentProjection`): a projection directory is
  removed only once no other live session in this process's session map
  keys off the same id under the same home node — true for `_shared`, and
  for a spawn id too, since a CLI reconnect inside one terminal carries the
  same `X-Portuni-Spawn-Id` (the device has no durable `sessions` table to
  consult the way `disposeSessionProjection` does). The projection registry
  (`session-projection.ts`) is keyed by target directory, not session id:
  two `_shared` sessions under different home roots projecting the same
  node are two live projections, and both keep receiving watcher relinks. **`portuni_get_node` gained
  `readable_path`** (the same value as `local_path`'s per-file derivation,
  promoted to the top level) -- `local_mirror` stays registration metadata,
  not a read path. **`portuni_read_file` gained `as_path`**: past the 1 MB
  cap (`MAX_READ_BYTES`, unchanged and still enforced) or on request, it
  spills to a path inside the session's projection directory instead of
  inline content -- `{path, bytes, mime}` (`mcp/read-file-spill.ts`; the
  spill path is validated with `ensureUnderRoot` like the inline read, so a
  traversal `path` is `not_found`, never a stat of a host file) -- no
  chunked-read (`offset`/`length`) parameter, since there is no server-side
  grep and the agent would just page blindly through a large file; read the
  path with your own Read/Grep instead. A node WITH a local mirror here
  reuses the same hardlink projection (no copy); one with none downloads the
  bytes once (`CentralClient.getFileRaw` over REST in agent mode, since that
  front door has no graph db) and writes a real copy into the same directory.

- **No automatic orientation message.** A hand-opened CLI in a mirror
  starts with nothing sent by Portuni; what an orientation prompt used to
  fetch (node context, responsibilities, recent events, a handoff pointer
  for a suspended session) is written into `PORTUNI_SCOPE.md`
  instead (`domain/write-scope.ts` `buildOrientationHint`,
  `domain/scope-materialize.ts` `orientationForNode`) — appended there only,
  never into `.cursor/rules` or the `CLAUDE.md`/`AGENTS.md` marker blocks,
  which stay on the terser write-scope hint. **Central-mode mirrors get a
  real orientation section too now (#323 ends the cut):**
  `CentralClient.orientation` (`GET /nodes/:id/orientation`, computed on
  central, which has the real graph db) backs
  `materializeAllRegisteredMirrors`'s `orientationFor` resolver in
  `desktop.ts`'s agent-mode boot, in place of the local `orientationForNode`
  (a direct db read agent mode can't make).
- **Provider instances (Settings → Runnery) are a sidecar `runners.json`
  registry.** `domain/runner/instances.ts` owns
  `<dataDir>/runners.json` (create/update/delete/`setOrgDefault`), served
  over `api/runners.ts` (`GET /runners`, `/runners/instances` CRUD, `PUT
  …/org-default`, `DELETE /runners/org-defaults/:orgId`); the web side is
  `RunnersSection.tsx` + `lib/runners.ts` over the ordinary REST proxy,
  `ProfilesSection.tsx` is gone. **The file is device-local**: `lib.rs`'s
  `is_local_only_path` routes every `/runners*` call to the sync agent
  (`agent-router.ts`, mutations behind `guardAgentRestWrite`), never to
  central. Env values never reach a client (`env_keys` only; an empty
  submitted value for a known key means "leave unchanged"), secret-shaped
  keys (`shared/runner-env.ts`'s `isSecretShapedEnvKey`) and `PORTUNI_*`
  keys are refused with `INSTANCE_ENV_KEY_REFUSED`, and a leading `~`
  expands to `$HOME` only when `getInstanceEnv` reads the value for a run.
  The session row's `instance_id` column (renamed from `profile_id` by
  migration 034) is where a run's instance lands; the desktop's old
  `config.json` profiles registry and the `X-Portuni-Profile` header
  threading are gone (#345) — an old config.json that still carries a
  `profiles` key loads fine, the key is ignored and dropped on save.
- **`sessions.terminal_id` and `POST /terminals/:terminal_id/exit` are
  dead on the desktop side.** They carried the embedded terminal's exit
  signal (a Claude Code connection threaded `PORTUNI_TERMINAL_ID` through
  `X-Portuni-Terminal`; the PTY reader thread POSTed the exit). Nothing
  sets the header or calls the route since #345; the column, the route and
  `closeSessionsByTerminalId` stay until #346 removes them server-side. A
  hand-opened CLI's row is still resolved by the MCP transport's idle GC
  (`transport.ts`'s `onclose`), which suspends it (#329).
- **A `sessions` row exists once a task is started OR a handshake completes
  (runner batch, Rule 2 "The session exists before the runner").** A task
  started through `POST /sessions` (`domain/runner/session-runtime.ts`'s
  `startTask`) creates the row FIRST, then starts a run whose MCP connection
  carries the row's own id in `X-Portuni-Spawn-Id`
  (`RunStart.mcp.headers`) -- the handshake that connection makes BINDS to
  that existing row instead of creating a second one. `createMcpServer`
  returns `bindSession(cli?)` instead of inserting the row itself; callers
  invoke it at their own post-handshake signal -- `transport.ts`'s
  `onsessioninitialized`, `stdio-entry.ts`'s `server.server.oninitialized`.
  For a hand-opened CLI (no task, no pre-existing row) `bindSession` still
  creates one there, same as before the runner batch. Binding is decided
  BEFORE `createMcpServer` runs (`mcp/session-persistence.ts`'s
  `lookupSpawnSessionForBind`, called the same way `transport.ts` already
  gates on session capacity/headless): a row under `X-Portuni-Spawn-Id`
  that is `running` and owned by the connecting identity is bound
  (`bindExistingSessionPersistence` rehydrates `session_scope` into the
  connection's `SessionScope`, same shape as a resume's rehydration but
  without the state transition); a row that exists but is not running or
  belongs to someone else refuses the whole connection with the existing
  503-with-reason shape and code `SESSION_BIND_REFUSED`; no row at all keeps
  today's create-with-preassigned-id behaviour. `bindExistingSessionHandshake`
  is the bound-row equivalent of `bindSession`'s own row creation: it fills
  in `cli` and touches `last_active_at` instead. A resumed connection's
  `bindSession` is a no-op either way (`resumeSessionPersistence` already
  created/attached the row). Agent mode opens its upstream connection to
  central only for a request that carries a valid `initialize`, so a probe
  at the local front door burns no row on central either. `cli` comes from
  the handshake's own `params.clientInfo.name`, normalized to
  `claude|codex|vibe` (`client-name.ts`) -- not from a header, which Codex
  and Vibe cannot send. Task REST routes and who may call them (read/
  message/stop/resume tiers) are `auth/session-access.ts`'s `sessionAccess`
  table (spec: `docs/superpowers/specs/2026-09-12-remote-hosts-and-task-queue-design.md`,
  "Visibility and control"): a node-anchored session hidden from the caller
  reads `SESSION_NOT_FOUND` (404) for every action, manage scope included;
  a visible session with an insufficient action tier reads
  `SESSION_FORBIDDEN` (403); a node-less (`interactive_chat`) session is
  `SESSION_FORBIDDEN` for anyone but the owner. An interrupt/suspend/close
  by someone other than the owner appends a `state_changed` event carrying
  `by` (`SessionRuntime.recordStoppedBy`) so the chat shows who stopped it.
  `wireOngoingSync` persists the session's home node as `writable=1`, since
  `guardWrite` allows it implicitly and `getSessionWriteCount` counts only
  persisted rows. **A dropped connection, the transport's own idle GC, a
  PTY exiting, or `boot/session-sweep.ts` finding a row left `running` by a
  process that died all suspend the session now, never close it (#329)** --
  `domain/session-handoff.ts`'s `suspendSessionServerSide(db, sessionId,
  reason)` (`reason` one of `disconnect | idle | terminal_exit |
  boot_sweep`) writes a minimal handoff itself, into the session's home
  mirror when one exists on this device (same path
  `writeHandoffAndSuspend` uses) or into the new `sessions.handoff_inline`
  column when it doesn't (central mode, or simply no mirror registered
  here) -- `getResumeInfo` reads whichever one is populated. The handoff
  content carries an invisible marker recording its own reason;
  `parseServerHandoffReason` reads it back so `GET /sessions/:id/resume-info`
  can report `generated_by: "server"` and the reason (the Relace row shows
  e.g. "pozastaveno serverem (nečinnost 30 min)") instead of looking like an
  ordinary agent-written handoff. `domain/sessions.ts`'s
  `closeSessionIfRunning`/`closeSessionsByTerminalId`/
  `closeStaleRunningSessionsOnBoot` kept their names and call sites (a
  transport-close reason of `disconnect` vs `idle` is decided by
  `mcp/transport.ts` itself, since its own idle-GC timer and a genuine
  client disconnect both fire the same `transport.onclose` handler) but now
  delegate to `suspendSessionServerSide` -- `closed` is reached only by the
  user's explicit Uzavřít or the auto-archive sweep. This is the interim
  fix for hand-opened CLIs; the runner spec's own `suspend()`
  (`session-runtime.ts`, #320) is the equivalent for runner-managed runs.
  **The runner batch adds a task layer
  underneath this row** (migration 034,
  `docs/superpowers/specs/2026-09-12-runner-and-session-design.md`):
  `sessions` gains `brief`/`runner`/`host_id`/`waiting_since`, `profile_id`
  is renamed `instance_id` (same column, now a runner provider instance
  rather than a desktop spawn-env profile), and each attempt to run the
  session's task is a row in the new `session_runs` table, with its
  canonical, append-only transcript in `session_events`
  (`apps/server/domain/runner/store.ts`'s `SessionStore`/`DbSessionStore` --
  the only writer of runs and events once the runtime issue lands). Every
  event kind and its payload shape are in `apps/server/domain/runner/
  types.ts`'s `CanonicalEvent` union.
- **One WebSocket, `GET /sessions/ws`, is the live channel for tasks (runner
  batch phase 1, `apps/server/api/sessions-ws.ts`) -- there is no other
  WebSocket anywhere in this codebase.** Auth happens once, at the
  `http.Server`'s `"upgrade"` event in `http/server.ts`, via
  `checkUpgradeAuth` (`http/middleware.ts`): the host allowlist + bearer/JWT
  identity resolution half of `applyGates`, adapted for a raw socket (no
  `ServerResponse` exists yet, so a refusal is a hand-written HTTP response
  written to the socket before it is destroyed) -- CORS/origin/OPTIONS don't
  apply to an upgrade. A plain `GET /sessions/ws` without an `Upgrade`
  header never reaches that event at all; `http/server.ts`'s normal request
  path answers it 426 directly. **Mounted in both data modes.** The
  server takes its storage through `SessionsWsDeps` (`runtime`, `access`,
  `snapshot`, `canSee`): `createLocalSessionsWsDeps()` (the default when
  the default router is in use) answers over the graph db, and the
  central-mode sync agent (`agentMain` in `desktop.ts`) passes
  `sessionsWs: createSessionsWsServer(createAgentSessionsWsDeps(client,
  runtime))` with the SAME runtime its `createAgentRouter(client, {
  sessionRuntime })` drives -- the desktop's `sessions_connect` targets
  its own sidecar, so without this the app's own mode had no live channel
  (the Rust side just reconnected forever). Agent-mode access is what
  central enforces on every store round trip (a central 404 is
  `SESSION_NOT_FOUND`); its snapshot comes from the new `GET
  /sessions?state=running,suspended&limit=500` (`handleListSessions`,
  `CentralClient.listSessionRecords`), visibility-filtered like
  `sessionAccess("read")`, bounded, newest activity first -- the local
  snapshot is bounded the same way (`SNAPSHOT_LIMIT`), and a broadcast
  resolves visibility once per identity, not per connection. The upgrade
  applies `minScopeForRoute` like every REST route (`GET /sessions/ws` is
  `read`); `message`/`answer`/`interrupt`/`suspend`/`close` frames need
  `write` scope (`FORBIDDEN`) and, under the #213 hardened posture, an
  upgrade that carried the proven `X-Portuni-Webview-Proxy` header
  (`UpgradeContext.webviewProven`, `WEBVIEW_PROXY_REQUIRED` otherwise) --
  `apps/desktop/src/sessions_ws.rs` sends it exactly as `api_request`
  does, the vite dev proxy already did; the same posture gates every
  mutating `/sessions*` REST route on the local router
  (`guardRestSessionWrite`, applied once in `routeSessions`). Every client
  action then goes through the exact same `sessionAccess` tier the REST
  route uses and calls the exact same `SessionRuntime` method; a refused
  action is an `{id,type:"error",payload:{code,message}}` frame, never a
  closed socket. `subscribe` replays `store.listEvents(after)` in
  pages of 200 -- it subscribes to the runtime FIRST, buffers whatever
  arrives live during the replay, then flushes the buffer skipping any
  event whose `seq` the replay already covered, so nothing emitted in that
  window is lost or duplicated. **A published canonical event now carries
  the `seq` the store assigned it** (`session-runtime.ts`'s `PublishedEvent
  = (CanonicalEvent & {seq}) | DeltaFrame`, `appendAndPublish` attaches it
  from `store.appendEvents`'s own return value) -- the live channel is what
  needed this; nothing else reads it. `session_state` fans out to every
  connection that can see the session (the same node-visibility rule
  `api/overview.ts`'s `filterSessions` applies) via ONE server-lifetime
  subscription per `WebSocketServer` (`subscribe("*", …)`, lazily created on
  the first successful connection, not per-connection) -- a test that swaps
  in a fresh `SessionRuntime` per test case rather than a fresh fake
  *adapter* under the registry's stable id will find that subscription
  stuck on an abandoned instance; `test/api-sessions-ws.test.ts` builds the
  runtime once and only re-registers the fake adapter between cases, same
  as `boot/session-runtime.ts`'s own production wiring. `SessionRuntime`
  gained `subscriberCount(target)` (test-only visibility that a closed
  socket's subscriptions were actually dropped, not leaked) and
  `pendingQuestion`/`recordStoppedBy`, shared with the REST routes (#321).
- **A task's session runtime always runs on the device; only its
  `SessionStore` changes between local and agent mode (#323, "one
  implementation").** `agent-router.ts`'s `createAgentRouter(client)` builds
  its own runtime (`boot/session-runtime.ts`'s `createAgentSessionRuntime`)
  bound to `CentralSessionStore` (`domain/runner/store-central.ts`) instead
  of the local singleton's `DbSessionStore` — every `SessionStore` call
  becomes a REST round trip to central's "central record half"
  (`api/sessions.ts`: `POST /sessions/record`, `GET`/`PATCH /sessions/:id`,
  `POST /sessions/:id/runs`, `PATCH /sessions/:id/runs/:run_id`,
  `GET /sessions/:id/runs`, `POST`/`GET /sessions/:id/events`), all thin
  wrappers over `DbSessionStore` bound to THAT server's own db, so central's
  real `auth/session-access.ts` checks apply exactly once, on central, no
  matter which device's sidecar is driving the task. `CentralSessionStore`
  batches `appendEvents` calls within a 50ms window into one POST (a burst
  of `tool_call` events is one round trip) and keeps an in-process
  `runId -> sessionId` map (populated by `createRun`/`listRuns`) since
  `SessionStore.patchRun(runId, patch)` carries no session id but the REST
  shape needs one. `PATCH /sessions/:id` is doubly-shaped: a plain rename
  (`{name}` alone) keeps its historical `SessionSummary` response and
  `renameSession`'s own audit action; any other field
  (`state`/`waiting_since`/`handoff_path`/`handoff_hash`, what
  `CentralSessionStore.patchSession` sends) returns the raw `SessionRow`
  instead, since `session-runtime.ts` reads columns (`handoff_hash` in
  `suspend()`, `host_id` in `resume()`) the curated summary doesn't carry.
  `domain/runner/provision-central.ts` is `provision.ts`'s counterpart:
  `createMirrorForNodeCentral` instead of `createMirrorForNode`, and
  `CentralClient.orientation` (`GET /nodes/:id/orientation`, backed by
  `orientationForNode` run on central, which has the real graph db) instead
  of a direct db read. **`session-runtime.ts` itself needed a seam for the
  one thing it still did unconditionally: `session_scope` is a local
  graph-db table**, so `startRun`'s/`sessionSignals`'s restart-indicator
  reads (`getSessionScope`) now degrade to an empty scope instead of
  throwing when there is no graph db, and the suspend-timeout fallback
  (`suspendSessionServerSide` locally) is a new injectable
  `CreateSessionRuntimeDeps.suspendFallback`, defaulting to the local
  implementation; `createAgentSessionRuntime` supplies
  `domain/runner/suspend-fallback-central.ts` instead, which writes the
  handoff file straight to the device's own mirror (mirrors exist in every
  mode) and patches the session record over the same REST route rather than
  the graph db directly — a deliberate simplification for this phase: the
  write/read-set sections of that handoff are always empty (central mode
  has no local `session_scope` to read them from), and the file is not
  registered as a tracked file the way the local path's
  `writeHandoffAndSuspend` does (the next sync run's untracked-file
  discovery picks it up instead of it appearing immediately in Files).
  `is_local_only_path` (`apps/desktop/src/lib.rs`) routes the bare
  `POST /sessions` and every per-session action verb
  (`messages`/`interrupt`/`suspend`/`resume`/`close`/`events`/`signals`/
  `questions/:request_id`) to the sync agent — deliberately NOT the record
  half (`GET`/`PATCH /sessions/:id`, `/state`, `/resume-info`, `/runs...`,
  `/sessions/record`), which stays central, and not `GET /nodes/:id/
  sessions` or `/overview` either. `signals` (#342, the SessionChat restart
  indicator) joined this local set rather than the record half: it reads
  `sessionSignals`'s in-memory live-run state (`liveRuns`/
  `runStartScopeSize` inside `session-runtime.ts`), which only exists on
  whichever process is actually running the task — the device, in every
  mode, per the "one implementation" rule above — so `agent-router.ts`
  mounts the same handler shape as `/events` does (a plain read through its
  own `sessionRuntime`, no write guard).
- **The Claude adapter (`domain/runner/adapters/claude.ts`, #324) drives
  `@anthropic-ai/claude-agent-sdk` in streaming-input mode always**, even
  for a fresh, brief-only run — `query()`'s `prompt` is never a plain
  string, it's a small push queue (`createPushQueue`) this module feeds,
  since that's the only mode the SDK supports `interrupt()`, queued
  messages and `answer()` in. `@anthropic-ai/claude-agent-sdk` is pinned
  **exact, no caret** (`package.json`) — it releases daily and has broken
  embedding before; bump it deliberately, never let `npm update` touch it.
  Permission decisions delegate entirely to the ALREADY-SHIPPED
  `permissions.ts` (#320's own phase-1 scope) — `decidePermission` needed
  `portuniRoot`/`mirrors` to classify a write's target, which `RunStart`
  didn't carry until this issue widened it (`session-runtime.ts`'s
  `startRun` now threads `provisioned.portuniRoot`/`.mirrors` onto it) --
  an "ask" decision emits a `question` event and leaves the `canUseTool`
  promise unresolved until `RunHandle.answer()` (called by the runtime,
  which itself is invoked by the REST/WS `answer` route) resolves it:
  `true`/`false` become plain allow/deny, any other value (an
  `AskUserQuestion` free-text answer) becomes `{behavior: "allow",
  updatedInput: {...originalInput, answer}}`. A completed write tool's
  `file_change` (`op: "create" | "edit"`) needs to know whether the target
  existed BEFORE the tool ran — captured via `fs.stat` at `tool_call
  started` time (when the tool_use block is translated, before its
  `tool_result` ever arrives) and carried on the pending-tool-call
  snapshot, since the result itself never carries the original arguments
  back. **`RunHandle` gained `pid()`** (the pid-file boot sweep, #325,
  needs it) — the SDK's public surface has no official way to read the
  underlying CLI subprocess's pid back off `query()`'s return value, so the
  adapter supplies its own `spawnClaudeCodeProcess` override purely to
  capture `child.pid` into a closure variable at spawn time; the fake
  adapter's `pid()` is always `null`. `close()` is just "end the prompt
  queue and await the translate loop's own completion" — the SDK's
  documented stdin-EOF → ~2s grace → SIGTERM → SIGKILL sequence runs
  entirely on its own, no client-side timeout needed. `interrupt()` also
  ends the queue (unlike a bare `q.interrupt()`, which only cancels the
  CURRENT turn and would leave the process alive for a next one) so the
  translate loop's natural completion reports `reason: "interrupted"`
  instead of `"completed"`, matching the fake adapter's own semantics.
  `hooks.PreCompact` and the `system/compact_boundary` message BOTH
  translate to a `compaction` event (the hook fires with the real
  trigger reason before compaction happens; the message translation is a
  fixed `trigger: "auto"` backstop) — accepted as possible double emission
  for a purely cosmetic chat marker, not verified against a real run.
  `detect()` (`claude --version` / `claude auth status`, 5s timeout each)
  and the whole message-translation surface are tested against an injected
  fake `query`/`exec` (`test/runner-claude-adapter.test.ts`); a real,
  logged-in run is a macOS-only human verification step, not in the gate.
  **`close()`/`interrupt()` cannot hang on a pid that is already dead**
  (#325): both race `state.endedPromise` against
  `waitForPidDeadOrTimeout(state.capturedPid, closePollIntervalMs,
  closeTimeoutMs, signal)` (500ms poll / 10s bound, test-overridable), and
  `abort()` the losing branch's `AbortController` the instant the race
  settles — a bare `setTimeout` left running past that point would (a) leak
  past the common case where the run ends normally on its own, and (b), if
  `unref()`'d to avoid that leak, risk never firing at all once nothing else
  keeps a bare test's event loop alive (Node drops an unref'd timer outright
  rather than firing it late). A null pid (not captured yet) just waits out
  the full timeout, since there is nothing to poll. **`close()` also ends a
  child that ignores the end of its prompt stream** (spec, "Process
  lifecycle"): end the stream, `closeGraceMs` (2 s), `SIGTERM`,
  `closeTermMs` (5 s), `SIGKILL`, each step skipped as soon as the run
  ends or the pid is confirmed dead -- `test/runner-claude-adapter.test.ts`
  proves it against a real `sleep 30` and a `trap '' TERM` shell. The child
  is spawned `detached` (its own process group) so `signalProcessGroup`
  reaches the CLI's helpers too; a `canUseTool` question still open when
  the run ends is denied (and one raised after the end is denied outright)
  so the SDK's own awaiter settles; delta frames carry the real `run_id`.
  **`translateStreamEvent` streams both channels, not just assistant text
  (#379).** A `thinking_delta` content-block delta becomes a `DeltaFrame`
  the same way a `text_delta` already did, tagged `channel: "reasoning"`
  instead of `channel: "text"` (`DeltaFrame.channel`, `domain/runner/
  types.ts`) -- before this, a turn that spent a long time on its first
  thought showed an empty transcript for that whole time, since only
  `translateAssistantMessage`'s own batched, end-of-block `reasoning` event
  (#370/#377) reached the wire. The batched event is still the persisted
  record; the deltas are only the live preview of the same thing, exactly
  as `assistant_message` and its own text deltas already relate -- nothing
  about the persisted-event side changed. `api/sessions-ws.ts`'s
  `eventFrame` forwards `channel` unchanged into the wire `delta` frame's
  payload; `SessionChat.tsx` keeps two separate `DeltaBuffers` (text,
  reasoning), each cleared on its own matching persisted event
  (`assistant_message` / `reasoning`) or on `run_ended`, and feeds the
  reasoning one to `Reasoning` with `isStreaming` -- the kit's trigger
  (Czech-wired here as "Přemýšlím…" / "Uvažoval N s",
  `reasoningTriggerMessage`) opens while it streams and collapses once the
  persisted event lands.
- **A sidecar restart or crash leaves runner children alive and their runs
  open — `boot/run-sweep.ts` reaps both, run BEFORE
  `sweepStaleRunningSessionsOnBoot` (#325).** `session-runtime.ts` writes
  `<dataDir>/runs/<runId>.pid` (`domain/runner/pid-file.ts`: pid +
  started_at) right after `adapter.start()` and removes it in the
  `run_ended` branch of `handleAdapterEvent` — `resolveRunnerDataDir()`
  (`domain/runner/data-dir.ts`) is `PORTUNI_DATA_DIR` or `cwd()`, matching
  `instances.ts`'s `runners.json` location. `domain/runner/run-sweep.ts`'s
  `sweepOrphanedRuns(db, dataDir)` walks every pid file at boot: a run
  already `ended_at` (a race with the file's own removal) or an unreadable
  file just gets the stale pid file deleted; otherwise, if the pid is alive
  AND `ps -o lstart= -o command= -p <pid>` says it is still our child
  (`readProcessIdentity`/`isOurChild`: the command line contains `claude`
  AND the process started no later than the pid file was written -- a pid
  reused across a crash by the user's own interactive Claude Code also
  says `claude`, but necessarily started after the file), SIGTERM the
  process group, wait 5s, SIGKILL if still alive — then, regardless of whether anything needed
  killing, `patchRun(end_reason: "host_lost")`, append `run_ended {reason:
  "host_lost"}`, and `suspendSessionServerSide(db, sessionId, "host_lost")`
  (one more `ServerHandoffReason`, alongside `boot_sweep`/`suspend_timeout`
  — Relace label "proces osiřel po restartu") followed by its own `handoff
  {generated_by: "server"}` event, same shape `session-runtime.ts`'s own
  `suspend()` produces for a live run. Local mode only: a pid file is only
  ever written by the process that spawned the child, on this same machine,
  so only that process's own next boot can find it — wired into `index.ts`
  unconditionally and `desktop.ts`'s non-agent branch, the same two call
  sites as `sweepStaleRunningSessionsOnBoot`, chained (`.then(...)`) ahead
  of it rather than fired independently, since this sweep's own
  `suspendSessionServerSide` call already resolves a session the other
  sweep's `'running'`-row query would otherwise race.
- **Bulk sync is a server-side job; the pending aggregate separates
  actionable work from decisions.**
  - **Job**: `POST /nodes/:id/sync` (one node, synchronous) is what the
    MCP-adjacent tooling and single-node "Synchronizovat" use. Bulk
    "Synchronizovat vše" goes through `POST /sync/jobs` (body
    `{ node_ids? }`, default: every node with `computeSyncPending`'s
    `total > 0`), which answers `202` immediately. `domain/sync/sync-jobs.ts`
    runs each node through a `runNode` callback with bounded concurrency
    (`PORTUNI_SYNC_JOB_CONCURRENCY`, default 3) -- `runNodeSync`
    (`sync-run.ts`) in local mode, `syncRunCentral` in central/agent mode,
    whose routes live in `agent-router.ts` and in `is_local_only_path`
    (`lib.rs`). `GET /sync/jobs/:id` polls progress; `GET /sync/jobs/current`
    lets a remounted UI reattach without the job id. One job per user: a
    second `POST /sync/jobs` reattaches to the running one and appends any
    node it does not already cover (the worker pool picks the additions up),
    so a reattach never drops nodes the caller asked for. State is in-memory
    -- a restart loses the progress view, never work, since each node's sync
    call is independently idempotent.
  - **Pending accounting**: `total` is `push + untracked` (what a run can
    actually clear); `decisions` is `conflict + deleted_local` (needs a
    human via `POST /nodes/:id/files/:fileId/resolve`). A node with only
    decisions still appears in the overview with `total: 0`.
    `SyncOverview.tsx` shows the split as `+N k rozhodnutí` and puts only
    actionable nodes in a job's default node set.
  - **Central hash tracking**: `current_remote_hash` is central-mode
    classification's only source of remote truth, so every path that proves
    the remote's identity persists it -- `writeFileBytesRemote`'s `ifAbsent`
    and `baseCanonicalHash` checks and `readFileBytesRemote` all call
    `backfillRemoteHash`, and `remote-sweep.ts`'s hash-refresh step fills a
    NULL hash and corrects a stale one whenever the listing reports a hash
    (Drive: md5Checksum -- an out-of-band Drive edit is caught this way).
    Native-format records are excluded. A backend that reports no hash on
    listing (fs/OpenDAL) gets only its NULL hashes resolved; re-verifying a
    known hash there would mean downloading every tracked file on every run.
  - **Watcher**: `mirror-watcher.ts` keeps one reconcile chain per mirror
    (`reconcileChains`, `Map<nodeId, Promise>`), so ordering holds within a
    mirror and mirrors do not block each other. A failed reconcile is
    recorded (`recordWatcherError`), never retried inside the chain;
    `MirrorWatcher.sweep()` re-backfills every watched mirror on a 10-minute
    interval (`boot/mirror-watch.ts`) and repairs it.
- **The update check is scheduled from the hook's mount, not from
  `backend-ready` alone.** `check_update` (`apps/desktop/src/updater.rs`)
  only talks to the GitHub releases endpoint, so it does not depend on the
  sidecar. `useAppUpdate` calls `scheduler.schedule(checkNow)` on mount and
  again on every `backend-ready` (per-window, and it can fire more than
  once); a repeat call resets the timers rather than stacking them. The
  scheduling itself is `apps/web/src/lib/update-schedule.ts`'s
  `createUpdateScheduler` -- timers injected, so it is unit-testable through
  the server's `node:test` runner (`apps/web` has no test runner of its
  own). A window regaining focus after a full interval checks immediately
  (`shouldCheckOnFocus`), since a suspended OS fires no JS timers.
  `AppUpdate.lastCheckedAt` is set on every completed attempt (success or
  error, never a skipped one) and shown in Settings → Obecné → Aktualizace.
- **`file_state` is cleared only once the local file is confirmed gone.**
  `file_state.last_synced_hash` is the only proof a later sync's tombstone
  cleanup (`matchDeleteTombstones` + `cleanupDeletedRemote`) has that a
  leftover local copy is an already-confirmed deletion rather than new
  content to adopt and push back. Every delete path -- `engine-mutations.ts`'s
  `deleteFile`, `pending-ops.ts`'s `runDelete`, `agent-router.ts`'s
  `DELETE /nodes/:id/files/:fileId`, `agent-tools.ts`'s
  `applyLocalAfterProxiedMutation` -- goes through `local-cleanup.ts`'s
  `removeLocalCopyAndState(localPath, fileId)`, which attempts the `rm`
  (ENOENT counts as success) and clears `file_state` only if that worked.
  On any other failure the state and the tombstone audit row stay, and the
  next sync's tombstone-cleanup pass finishes the job. `runDelete` resolves
  this device's own mirror path (`getMirrorPath` + `resolveNodeInfo` +
  `deriveLocalPath`) so a retried delete cleans up locally too.
- **Push/pull is serialized per path.** `path-lock.ts`'s
  `withPathLock(key, fn)` is a per-key async mutex wrapping the whole
  check-then-write critical section: `engine.ts`'s `pullFile`/`storeFile`,
  `engine-central.ts`'s `pullFileCentral`/`storeFileCentral`/
  `pushEntryCentral`, and `file-content.ts`'s `writeFileContent`/`createFile`
  key on the local absolute path; `file-content-remote.ts`'s
  `writeFileContentRemote`/`writeFileBytesRemote`/`renameFileRemote` key on
  `remote_name:remote_path`, having no local path to key on. Everything the
  decision depends on belongs inside the lock -- a pull downloads its bytes
  there too, or it can overwrite a newer push with older content and record
  the stale hash as this device's baseline. The lock is **not reentrant**:
  never take it around a call that takes it again (`createFile` releases it
  before calling `storeFile`). It is also in-process only -- it does not
  protect against another device or process writing the same Drive object;
  storage-level preconditions (ETag/If-Match) remain a known gap, marked at
  the `writeFileContentRemote`/`writeFileBytesRemote` call sites.
  `pushEntryCentral` stats before the read and rehashes after the put, so a
  mid-upload edit stays a push candidate instead of reading as clean, and it
  re-reads its baseline under the lock rather than trusting the scan entry.
  `pending-pushes.ts` tracks in-flight background pushes for both
  dispatchers -- `agent-router.ts`'s REST handlers and `agent-transport.ts`'s
  MCP proxied mutations both `awaitPendingPush` before mutating a path.
- **Remote relocation is destination-safe and retry-safe.**
  `relocateRemoteObject` (`file-relocation.ts`) stats source and destination
  first: same path is a no-op, both present is an ambiguity it refuses to
  guess away, only-destination is `already_at_target`. `moveFile`,
  `renameFile`, `renameFolder`, `renameFileRemote` and `pending-ops.ts`'s
  `runMove` all route through it, plus `writeRelocatedRecord`, which folds a
  colliding shadow row into the survivor inside the same `db.batch` as the
  UPDATE instead of raising `SQLITE_CONSTRAINT`. A cross-remote move is
  copy-then-delete and therefore not atomic: when the copy lands and the
  delete fails, `moveFile` records `source_copied` on the pending op
  (`markPendingMoveSourceCopied`), which is the only thing that later tells
  the retry which of the two present objects is its own copy -- without it
  both-present is unresolvable and the op can never complete. The retry
  deletes the source only when the recorded intent says so and the two
  hashes are comparable and equal. `portuni_rename_folder` applies at most
  `limit` files per call (default 20) and reports `remaining` + `next_call`;
  re-running the same call resumes, since renamed files no longer match
  `old_prefix`. `portuni_status` takes `classes`/`path_prefix`/`limit`/
  `offset` (`status-filter.ts`) and always returns `counts` (true per-bucket
  sizes, ignoring the filters) plus `truncated`.
- **`POST /nodes/:id/files/:fileId/move` is routed to the sync agent.**
  `is_local_only_path` (`apps/desktop/src/lib.rs`) matches it alongside
  `resolve`/`rename`/`delete`/create -- the same routing-gap family. The
  handler forwards the record + remote step to `CentralClient.moveFileRecord`
  and only then, once that is confirmed and committed, relocates this
  device's mirror copy. A cross-node move resolves the TARGET node's mirror
  root and nodeRoot independently (`loadNodeContext`); when the target has
  no mirror on this device it reports `repair_needed` with a hint rather
  than stranding the old copy silently.
- **A local step that runs after central already committed reports
  `repair_needed`, never a 500 and never a silent success.** REST
  (`agent-router.ts`) returns 200 with `status: "repair_needed"` and a hint;
  MCP (`agent-tools.ts`'s `applyLocalAfterProxiedMutation`) rewrites
  central's response itself instead of letting the caller's outer `.catch()`
  swallow it -- `rename_folder` downgrades only the failed entry and
  recomputes `renamed`/`failed`, keeping the rest of the batch's outcome.
  `deleteFileRemote` treats a confirmed retry that finds nothing to delete
  as `already_deleted: true` when this file_id's own
  `sync_delete`/`sync_delete_remote` audit history proves the first attempt
  landed; an unknown id still throws, and only `confirmed: true` qualifies.
  `sync_rename_remote` counts as a tombstone-qualifying action in
  `sync-remote-api.ts`.
- **A watcher-driven delete unregisters only on a confirmed `status: "ok"`.**
  `reconcilePathCentral`'s never-pushed-delete branch treats a thrown
  failure and a `repair_needed` alike: `file_state` stays, the result is
  `{action: "noop"}`, and the next watcher event or backfill sweep retries.
  A one-shot watcher event must never silently degrade -- same rule as
  `tryApplyDiskMoveCentral`.
- **A `StatusFileEntry` carries the class of the bucket it is in**, including
  `deleted_local`. REST derives `sync_class` from the bucket array, but
  `portuni_status` serializes the raw `StatusResult`, so a consumer reading
  `entry.class` must get the same answer.
- **`createFile` registers locally when no remote is routed.** It resolves
  the remote first and calls `storeFile` (register + push) or
  `registerLocalFile` (record-only, as the watcher's auto-registration does)
  -- a local-only workspace is a legitimate configuration, and failing after
  the bytes are already on disk left a retry hitting `EXISTS`. The push stays
  available later via `portuni_store` or a sync run.
- **Deliberately not done** (do not re-litigate without new reasons):
  reserving a `files` row before `createFileRemote`'s upload (worth it only
  paired with real idempotent-resume; alone it trades an invisible orphan
  blob for a phantom row nothing can complete); a general idempotency-key
  replay mechanism for the central client's mutation retries (larger than
  one backlog item -- the delete-replay case above is the reachable one);
  making `moveFile`/`renameFile`/`renameFolder` work for a never-routed
  local-only file (today a clear rejection: `"File X has no remote binding"`,
  or a per-file `repair_needed` in `renameFolder`'s batch -- widening the
  public `remote_name` fields to nullable is a riskier change than the
  narrow scenario warrants).
- **The Postgres cutover (infra batch, `docs/superpowers/plans/2026-09-12-infra-batch.md`,
  batch B) starts with a dialect-neutral client interface, not a dialect
  switch (B1).** `apps/server/infra/db.ts`'s `DbClient` (`execute`/`batch`/
  `executeMultiple`/`close`, `InValue`/`InArgs`/`InStatement` keep their
  libsql names and shapes) is what every domain/api/mcp file is written
  against now — `import type { Client } from "@libsql/client"` became
  `import type { DbClient } from ".../infra/db.js"` everywhere (a rename,
  not a behavior change: every `db.execute({sql, args})`/`db.batch([...],
  mode)` call site is byte-for-byte unchanged). Three implementations:
  `db-libsql.ts` (near-passthrough over a real libsql `Client`, just
  shallow-copying libsql's hybrid array/object `Row` into a plain object,
  since `DbClient`'s contract is plain objects), `db-pglite.ts`
  (`@electric-sql/pglite`, embedded Postgres — the local-mode driver from
  B4) and `db-pg.ts` (`pg` Pool — the central driver from B4/B5), both
  pinned exact in `package.json` like the Claude SDK. `getDb()` picks the
  driver from `PORTUNI_DATABASE_URL` (`postgres://`/`postgresql://` → pg,
  `pglite:<dir>` or bare `pglite:` → PGlite, `file:`/`libsql:` → libsql);
  unset falls back to the existing `TURSO_URL`/local-file default, so
  nothing in production actually switches driver yet — this step is pure
  plumbing. `domain/sync/local-db.ts` (the per-device `.portuni/sync.db`,
  unrelated to the graph db) keeps calling libsql's own `createClient`
  directly, just wrapped in `createLibsqlDbClient` and typed `DbClient` —
  it moves to PGlite in B4 alongside the graph db, not here.
  `infra/backup.ts` (Turso-only SQL dump, used by `scripts/backup-turso.ts`,
  removed in B4) is the one file deliberately left on the raw libsql
  `Client`/`Transaction` types — porting a tool that's about to be deleted
  would be wasted work. **`?` → `$1, $2, ...` placeholder rewriting lives
  inside the pg/PGlite drivers** (`infra/sql-placeholders.ts`'s
  `rewritePositionalPlaceholders`, quote-aware so a literal `?` inside a
  string/identifier literal is never touched) precisely so B3's
  dialect-neutral SQL pass never has to touch call sites for this reason —
  only SQLite-specific *syntax* (`PRAGMA`, `datetime('now')`,
  `INSERT OR IGNORE`, `json_extract`) is B3's actual job. Named (`Record`)
  SQL args are never used anywhere in this codebase (checked at B1 time) —
  both new drivers throw if one ever shows up, rather than silently
  mishandling it. `test/helpers/db.ts`'s `openTestDb()` (env
  `PORTUNI_TEST_DB=libsql|pglite`, default libsql) is what B3 will point
  the whole suite at twice; for now only `test/db-client-conformance.test.ts`
  uses it directly (positional-arg execute, batch atomicity — a failing
  statement rolls back the whole batch — and `executeMultiple`, run against
  all three drivers). **The `pg` driver is not exercised against a live
  server by the automated gate** (the plan's own "CI adds no services"
  constraint — PGlite is in-process, a real Postgres is not): its
  conformance suite is skipped unless `PORTUNI_TEST_PG_URL` is set, real
  verification waiting on an actual deployed Postgres in a later batch-B
  step.
- **The Postgres baseline (B2) is one migration, not a fresh-install DDL
  path plus 35 upgrade steps.** `DbClient` gained a `dialect: "sqlite" |
  "postgres"` tag (the one dialect-aware seam in an otherwise dialect-
  neutral interface) so `ensureSchemaOn` (`infra/schema.ts`) can branch: the
  libsql path is untouched, the postgres path calls
  `infra/migrations/pg.ts`'s `ensurePgSchema`, a tiny framework of its own
  (`migrations` table, same shape as the libsql one, disjoint id space --
  `pg-NNN` vs `NNN_name`, never both populated in the same database) whose
  first and so-far-only entry, `pg-001`, IS the whole baseline (every
  table from `schema.pg.ts`'s `PG_BASELINE_DDL` + every trigger from
  `schema-triggers.pg.ts`'s `PG_BASELINE_TRIGGERS`) applied in one
  `executeMultiple` call -- Postgres's simple-query protocol wraps a multi-
  statement script in an implicit transaction on its own, so a mid-baseline
  failure leaves nothing committed and no `pg-001` marker, and the next
  boot retries cleanly rather than hitting "relation already exists".
  **The baseline mirrors what a FRESH libsql install ends up with** (DDL +
  DDL_MIGRATION_006 + DDL_AFTER_MIGRATIONS + every migration whose `up()`
  still does something on an empty database, e.g. migration 002's org-
  invariant triggers, migration 013's `idx_nodes_sync_key` + sync_key
  guard triggers, migration 016's `users.google_sub`/`avatar_url`/
  `last_login_at`, migration 033's `idx_audit_file_node_ts`) -- not a
  literal replay of all 35 migrations, most of which exist only to bring
  an OLD sqlite database up to that same shape. Translation rules, applied
  uniformly: `DATETIME` → `TIMESTAMPTZ`, `DEFAULT (datetime('now'))` →
  `DEFAULT now()`; `REAL` → `DOUBLE PRECISION` (SQLite's REAL is already
  8-byte, same as Postgres double precision); boolean-shaped
  `INTEGER ... CHECK(x IN (0,1))` columns are kept as-is, not converted to
  `BOOLEAN` (that conversion is B3's dialect-neutral-SQL job, since every
  call site still writes/reads 0/1); `INTEGER PRIMARY KEY AUTOINCREMENT` →
  `INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY` (`remote_routing.id`,
  the only site); `CHECK(json_valid(x))` → `CHECK(x::jsonb IS NOT NULL)`
  (invalid JSON fails the INSERT with a cast error instead of a constraint
  violation -- same net effect, the row is rejected either way); a SQLite
  `GENERATED ... VIRTUAL` column (`audit_log.audit_node_id`, source
  `json_extract(detail, '$.node_id')`) becomes `GENERATED ALWAYS AS
  ((detail::jsonb ->> 'node_id')) STORED` (Postgres has no virtual
  generated columns before PG18; STORED is transparent to every reader
  either way). **One deliberate schema difference, per the issue:**
  `session_events`' primary key is `(session_id, seq)` here, not a bare
  `id` — efficient per-session retention deletes and the natural read
  order both the live channel and the 90-day event-retention sweep want;
  `id` (still `ulid()`-generated, still read by `SessionEventRow`) is a
  plain `NOT NULL` column now, never looked up by itself so dropping its
  own uniqueness constraint costs nothing. **10 SQLite triggers ported to
  PL/pgSQL, same trigger names, 9 actually applied**: `RAISE(ABORT, 'msg')`
  → `RAISE EXCEPTION 'msg'`; a SQLite `WHEN <cond> BEGIN...END` guard
  becomes an `IF <cond> THEN...END IF;` inside the function body (Postgres
  triggers have no WHEN-guard for a condition referencing other tables);
  `UPDATE OF col` column-scoped triggers are natively supported by
  Postgres's own `CREATE TRIGGER`, unchanged. `nodes_owner_must_be_real_person`
  is ported for parity (`PG_TRIGGER_NODES_OWNER_MUST_BE_REAL_PERSON`,
  exported) but deliberately excluded from `PG_BASELINE_TRIGGERS` — same as
  `DDL_MIGRATION_006`'s own exclusion on the libsql side: migration 014
  drops it there and a fresh install never creates it in the first place,
  owners may be any actor now, the FK on `owner_id` already guarantees
  existence. **No FK on `nodes.owner_id` at all**, matching the fresh
  libsql DDL exactly (only migration 006's ALTER on an *upgraded* libsql DB
  adds one) — a faithful port of an existing inconsistency, not a place to
  fix it in this batch. Tests (`test/schema-pg-baseline.test.ts`) boot a
  PGlite `:memory:` DB, apply the baseline, and exercise the same behaviors
  the libsql trigger tests cover for that dialect: org invariant (both
  directions), per-type attachment validation, lifecycle derivation +
  validation, sync_key non-empty + uniqueness, the `sessions.terminal_id`
  index, `idx_files_unique_remote`, the generated column, and the
  `session_events` composite key — plus idempotency (a second
  `ensureSchemaOn` call is a no-op, `migrations` still holds exactly
  `pg-001`). `seedSoloUser` also branched: `INSERT OR IGNORE ...
  datetime('now')` has a `postgres` counterpart using `ON CONFLICT (id) DO
  NOTHING` and `now()`.
- **B3 (`docs/superpowers/plans/2026-09-12-infra-batch.md`) made every
  runtime query dialect-neutral and the whole suite genuinely passes on
  both drivers — `npm run test:pglite` alongside the default `npm test`.**
  `infra/sql.ts` holds the fragment helpers every non-exempt call site
  under `apps/server/{domain,api,mcp,auth,infra}` now goes through:
  `nowExpr(dialect)` (`datetime('now')` vs `CURRENT_TIMESTAMP`),
  `jsonField(dialect, col, key)` (`json_extract(col,'$.key')` vs
  `(col::jsonb ->> 'key')`), `jsonArrayElementsText(dialect)` (SQLite's
  `json_each(?)` table-valued function, seeding `auth/node-access.ts`'s
  recursive ACL-chain CTE from a JSON array of ids, vs Postgres's
  `jsonb_array_elements_text(?::jsonb) AS value`), and `insertIgnore(dialect,
  sql)` (rewrites a SQL string's own `INSERT OR IGNORE INTO ...` into
  `INSERT INTO ... ON CONFLICT DO NOTHING` — a bare `ON CONFLICT DO NOTHING`
  needs no conflict target, matching `OR IGNORE`'s "any violation" scope).
  `?` stays the placeholder everywhere (B1's drivers already rewrite it);
  `ON CONFLICT ... DO UPDATE` and `ROW_NUMBER() OVER` needed no translation
  at all. **`PRAGMA` needed no per-call-site fix, because it has no runtime
  call sites**: every occurrence outside `infra/schema.ts` (whose own
  `PRAGMA foreign_keys` sits after B2's `dialect === "postgres"` early
  return, so the postgres path never reaches it), `infra/schema-migrations.ts`
  and `infra/backup.ts` is libsql-migration/Turso-tool-only, already exempt.
  **Exempted by design, not fixed**: `infra/schema.ts`/`schema-migrations.ts`/
  `schema-triggers.ts` (the libsql-only fresh-install DDL + migration
  runner — schema.pg.ts is its Postgres counterpart, not a shared code
  path), `infra/backup.ts` (Turso-only, removed in B4), and
  `domain/sync/local-db.ts` (the per-device sync.db always calls
  `createClient` directly regardless of `getDb()`'s driver — moves to
  PGlite in B4 alongside the graph db, not here).
  **Two dialect-sensitive bugs beyond the plan's named constructs**, found
  only by actually running the suite against PGlite: (1) `mcp/tools/scope.ts`
  and `mcp/tools/get-node.ts`'s `WHERE name = ? COLLATE NOCASE` (a SQLite
  named collation Postgres doesn't have) became `WHERE lower(name) =
  lower(?)`, identical case-insensitive semantics on both dialects; (2)
  `mcp/tools/context.ts`'s recursive graph-walk query's
  `GROUP BY gw.node_id` selected `n.*` columns un-aggregated, which SQLite's
  lenient GROUP BY allows but Postgres rejects outright — fixed by grouping
  on `n.id` (`nodes`' own primary key) instead, which qualifies for
  Postgres's functional-dependency exception (selecting any other column of
  a table already grouped by its own PK is allowed), and selecting
  `n.id AS node_id` to match; produces identical rows on both dialects
  since `n.id = gw.node_id` always holds through the JOIN. **The
  constraint-violation detectors were also dialect-specific string
  matching**: `auth/users.ts`'s `err.message.includes("UNIQUE constraint
  failed: users.email")` (a concurrent-invite race → `UserExistsError`) and
  `http/middleware.ts`'s `respondError`'s `err.message.includes
  ("SQLITE_CONSTRAINT")` (a DB-trigger rejection → friendly 409) both only
  ever matched libsql's own error shape. `infra/sql.ts`'s
  `isUniqueViolation(err)` and `constraintViolationMessage(err)` check both:
  libsql's `LibsqlError.code`/message text, and pg/PGlite's real SQLSTATE
  `.code` (`23505` unique violation; `P0001` — `RAISE EXCEPTION`'s own code
  — or any `23xxx` class for the friendly-message path, where Postgres's
  message is already the trigger's raw text or a reasonably readable
  constraint message, unlike libsql's wrapped "SQLite error: ..." which
  still needs the existing regex extraction).
  **The single largest fix, found only empirically**: pg/PGlite return
  `TIMESTAMPTZ` columns as native JS `Date` objects, not strings — `DbClient`'s
  contract is `DbValue` (`null | string | number | bigint | ArrayBuffer`,
  no `Date`), and every Zod row schema in the codebase types a
  `*_at`/`timestamp` column `z.string()`, so literally every read of a row
  with a timestamp column failed validation under Postgres until this was
  fixed. `infra/pg-row-normalize.ts`'s `normalizePgRow`, called from both
  `db-pg.ts` and `db-pglite.ts`'s `toDbResultSet`, converts any `Date` value
  in a row to the same text shape SQLite's own `datetime('now')` produces
  (`"YYYY-MM-DD HH:MM:SS"`, second precision, no timezone suffix) —
  chosen deliberately over ISO so the handful of call sites that still
  string-*compare* two timestamps (rather than letting the DB compare them)
  keep sorting correctly regardless of dialect; two tests
  (`test/auth-oauth-grants.test.ts` et al.) that used to write an expiry
  timestamp via SQLite's own `datetime('now', '-1 second')` were rewritten
  to compute the same shape in JS (`new Date(...).toISOString().replace("T",
  " ").slice(0, 19)`) and bind it as a plain parameter — SQL-side relative-
  date arithmetic has no portable form across dialects at all.
  **Test-file fixture conversion**: `test/helpers/shared-db.ts`'s
  `makeSharedDb()` now builds its db via `test/helpers/db.ts`'s
  `openTestDb()` (driver from `PORTUNI_TEST_DB`) instead of a hardcoded
  libsql `createClient` — every one of the ~80 test files built on it
  became dialect-parametrized for free. `makeSharedDb(driver?)` takes an
  explicit override for the files that call `schema-migrations.ts`'s
  `runMigrationNNN`/`runMigrations` directly against the returned db, or
  otherwise poke libsql-only internals (`sqlite_master`, `PRAGMA
  foreign_keys` to force an impossible FK state) — every `test/migration-
  *.test.ts` file, plus the specific tests in `test/files-unique-remote
  .test.ts` and `test/events-supersede.test.ts` that do the same, pass
  `"libsql"` explicitly regardless of which driver the rest of the matrix
  run is exercising, since those ARE the libsql migration path and have no
  Postgres equivalent — schema.pg.ts's baseline already carries whatever
  they migrate an old DB towards, applied as a single step. **Every other
  test file opens its db through `openTestDb()` too** — 52 files used to
  call libsql's `createClient({ url: ":memory:" })` directly, so `npm run
  test:pglite` silently re-ran a quarter of the suite (router, MCP, auth,
  scope, sync-routing) on libsql and two real Postgres breakers
  (`sqlite_master` in `mcp/tools/context.ts`, `SELECT DISTINCT … ORDER BY`
  on an unselected column in `domain/sessions.ts`) went unnoticed. The
  files that hand-write SQLite DDL or drive `runMigrationNNN` are pinned
  with `openTestDb("libsql")` and say so in a comment; the rest use
  `insertIgnore`/`nowExpr` and skip `PRAGMA` on Postgres. A new test opens
  its db with `openTestDb()`; a new query that introspects the schema uses
  `tableExistsSql(dialect)` (`sqlite_master` vs `pg_tables`). **Both
  Postgres drivers pin the session time zone to UTC** (`SET TIME ZONE
  'UTC'` after PGlite's `waitReady`, `options: "-c timezone=UTC"` on the
  pg Pool): `normalizePgRow` renders TIMESTAMPTZ as zone-less UTC text and
  `db-import` feeds it back as a bare literal, which Postgres reads in the
  session zone — on a host outside UTC every export/import round trip
  shifted timestamps by the local offset (CI's UTC runner never saw it).
  `sql-placeholders.ts` skips `--`/`/* */` comments and dollar-quoted
  bodies as well as string literals. **A Postgres migration's marker row
  is written inside the same `executeMultiple` script as its DDL** (one
  implicit transaction), and every `CREATE TRIGGER` in
  `schema-triggers.pg.ts` is preceded by `DROP TRIGGER IF EXISTS`, so a
  baseline applied without its marker (older build, crash in between)
  boots instead of failing on "trigger already exists" forever.
  **Both test scripts run with `--test-timeout=120000 --test-force-exit`**:
  a test file whose process never exits (a leaked socket or timer after
  its last assertion) used to hang the whole run with nothing reported --
  a CI job once sat on `npm test` for an hour that way. A test that stalls
  now fails with "test timed out", and each file's process is exited once
  its tests are done; a leak is still a bug to fix, it just cannot hide.
  **`npm run test:pglite` caps `--test-concurrency=2`** (`node --test`'s
  default is `availableParallelism() - 1`, effectively "run most test files
  in parallel"): PGlite is a real WASM-compiled Postgres per instance, heavy
  enough that the full ~2000-test suite's default concurrency reliably
  OOM-kills several of the heavier test files partway through a run (every
  one of those files passes cleanly, fast, in isolation or under this cap —
  confirmed empirically, not a logic bug). `scripts/agent-gate.sh` runs
  `npm run qa` (libsql, fast — unchanged, still what the pre-push hook and
  local iteration use) then `npm run test:pglite` as a separate step;
  `ci.yml`'s `server` job runs both `npm test` and `npm run test:pglite`
  as two ordinary sequential steps in the same job rather than a literal
  GitHub Actions `strategy: matrix:` — cheaper (one `npm ci`/build/lint
  pass, not two) for the same "green on both" guarantee the plan asks for.
- **B5 (`docs/superpowers/plans/2026-09-12-infra-batch.md`) is the actual
  cutover tool, landing before B4 removes libsql so its own rollback still
  works — full steps in `docs/runbooks/postgres-cutover.md`.**
  `apps/server/infra/db-export.ts`/`db-import.ts` hold the testable logic
  (`scripts/db-export.ts`/`db-import.ts` are thin CLI wrappers, same shape
  as `scripts/backup-turso.ts`/`infra/backup.ts`). Export is
  dialect-agnostic on purpose — `SELECT * FROM t ORDER BY <pk>` against any
  `DbClient`, one JSON file per table in `TABLE_ORDER` (the same
  topological/FK-safe order `schema.pg.ts`'s baseline creates tables in) —
  so the same tool exports a Turso/libsql source (central's real use case)
  or a Postgres one (round-trip testing) alike. **`migrations` is
  deliberately not one of the exported/imported tables**: its rows are
  dialect-specific bookkeeping (`NNN_name` libsql ids vs `pg-NNN`), not
  user data — the import target already has its own correct state from
  having the baseline applied before import ever runs; the source's ids
  are recorded in `manifest.json` purely for reference.
  `importDb` refuses a target with any data beyond the one row
  `ensureSchemaOn` itself always seeds (`seedSoloUser`, unconditional
  regardless of auth mode) — checked per-table, `users` specifically
  excluding that one well-known id (`SOLO_USER`) from the count. The
  `users` insert is an upsert (`ON CONFLICT (id) DO UPDATE`), not a plain
  INSERT, specifically so a source whose own solo-user row shares that
  same id replaces the target's placeholder instead of colliding with it;
  every other table is genuinely empty at that point (the refusal above
  already proved it) so a plain INSERT is correct there.
  **`remote_routing.id` changed from `GENERATED ALWAYS AS IDENTITY` to
  `GENERATED BY DEFAULT AS IDENTITY`** (a B2 baseline fix landing here,
  since B5 is what first needed it): `ALWAYS` rejects any explicit value
  outright, but the import inserts each row's own original id to keep
  referential meaning — `BY DEFAULT` accepts one, matching SQLite's own
  `AUTOINCREMENT` (which always allowed an explicit id too).
  `resyncIdentitySequence` fast-forwards the sequence past the highest
  imported id afterward (Postgres-only; a no-op on libsql, which has no
  sequence to resync and just looks at the actual max rowid) so the next
  ordinary insert doesn't collide with what was just imported.
  **`session_runs.resumed_from_run_id` is the schema's one self-referencing
  FK** — a row can reference another row of the same table not yet
  inserted even in a correct table order, since ULID order is chronological
  in practice but not a guarantee the importer enforces. Inserted NULL in
  the main pass, backfilled in a second UPDATE pass once every
  `session_runs` row exists.
- **The live channel's desktop bridge (#341, runner batch phase 3, first
  issue) holds the WebSocket in Rust, never the webview (security rule
  3).** `apps/desktop/src/sessions_ws.rs`'s `sessions_connect`/
  `sessions_send`/`sessions_disconnect` commands open ONE connection per
  window to that window's own sidecar (`ws_of(&window)` +
  `sidecar_port_and_token`, the exact same bearer source `api_request`
  already uses — `Authorization: Bearer` attached on the WS handshake
  request itself, which Rust can do and a browser cannot) and re-emit
  every server frame as a per-window `session-event`
  (`app.emit_to("ws:<id>", ...)`, same idiom as `backend-ready`), plus a
  `session-connection {status}` (`open|reconnecting|closed`). Reconnect
  backoff is 1s→30s, doubling (`next_backoff_ms`, a pure function unit
  tested in isolation — `sessions_ws::backoff_tests`); the connection
  registry (`SessionsWsState`, keyed by workspace id like
  `BackendPorts`/`AuthTokens`) carries a `generation` counter bumped on every connect/
  disconnect so a background task from a superseded connect (e.g. sleeping
  out a backoff when a fresh `sessions_connect` or a `sessions_disconnect`
  arrives) recognizes it no longer owns the entry and exits instead of
  resurrecting a connection nothing wants. **It is torn down on window
  close**: `disconnect_for_ws` is called both from `sessions_disconnect` and from
  `on_window_event`'s `Destroyed` arm, since a force-closed window never
  gets to call the command itself. `tokio-tungstenite`/`tokio`/
  `futures-util` are new direct dependencies (default features only, no
  TLS backend — every connection target is loopback `ws://127.0.0.1`,
  never `wss://`); `tokio` was already present transitively via Tauri's
  own async runtime. No change needed to `capabilities/default.json`:
  custom app commands need no per-command capability entry in this
  codebase (confirmed against the existing, equally un-listed
  `api_request`), only the `windows: ["bootstrap", "ws:*"]`
  scope already covers every command.
  **`apps/web/src/lib/sessions-client.ts`** is the typed client the two
  transports share one interface for: Tauri mode invokes those three
  commands and listens for the two events; **Vite dev mode opens a real
  `WebSocket` directly** against `/api/sessions/ws` — `vite.config.ts`'s
  existing `/api` proxy gained `ws: true` plus a `proxyReqWs` handler
  (http-proxy fires a *different* event for upgrades than `proxyReq`)
  injecting the bearer the exact same way the REST proxy already does, so
  the token still never reaches client JS even in this mode; reconnect-
  with-backoff is reimplemented in TS here since there is no Rust bridge
  to do it for a plain browser tab. `createDirectWsTransport`'s own `send`
  queues a frame until the socket's `onopen` fires rather than silently
  dropping one sent immediately after `connect()` (the common case, not a
  rare race — a caller's very first `subscribe()` call always races the
  handshake). The client tracks the highest `seq` it has seen **per
  session** (never touched by `delta` frames, which carry no `seq` and are
  never persisted server-side either) and resubscribes every still-wanted
  session with `after: <that seq>` the moment the transport reports
  `"open"` again after having been open before — the server's own replay
  (`sessions-ws.ts`) fills exactly that gap, so a reconnect loses nothing
  and re-delivers nothing. `session_state` frames dispatch to a single
  global listener set (`onSessionState`, no session-id key), matching the
  server fanning them to every connection that can see the session
  regardless of subscription. `test/sessions-client.test.ts` exercises the
  direct-WS transport end-to-end against a small fake `ws` server (the
  Tauri transport has no runtime to test against here) — subscribe/reply
  correlation, in-order event delivery, the resubscribe-with-`after`
  behavior across a forced connection drop, and that a `delta` frame never
  moves the tracked seq.
- **SessionChat + "Nový úkol" (#342, runner batch phase 3, second issue)
  are Práce's way of running an agent (the embedded terminal they first
  ran beside is gone since #345).** `apps/web/src/lib/session-chat.ts` mirrors
  `domain/runner/types.ts`'s `CanonicalEvent` union by hand (that module is
  server-only, deliberately not shared — same boundary `shared/api-types.ts`
  exists to keep) and holds every pure helper `test/session-chat-helpers.test.ts`
  exercises: `sessionStatusChip` (state + `waiting_since` ->
  label/color/pulsing, "Čeká na mě" overriding plain "Běží"),
  `latestQuestionEvent`, `appendDelta`/`clearDeltaBuffer` (per-`run_id`
  streaming buffers — `CanonicalEventEnvelope` itself carries no `run_id`,
  so `SessionChat.tsx` tracks the live run's id separately off
  `run_started`/`run_ended` payloads), `collapseToolCalls` (a `started` ->
  `completed`/`failed` pair sharing `tool_use_id` collapses to the later
  row, in place, so the event list shows one row per invocation not two),
  and `formatRestartHint` (the `GET /sessions/:id/signals` payload into the
  Czech "Běží N min · zápis W · čtení R (+G od startu běhu)" string,
  polled every 15s only while `state === "running"`).
  `apps/web/src/components/SessionChat.tsx` backfills
  `GET /sessions/:id/events` once on mount, then hands off to the shared
  `sessionsClient` (#341) for live `event`/`delta`/`session_state` frames;
  actions (Přerušit/Pozastavit/Uzavřít/Nahodit) call the client directly
  and rely on the server's own 403 for anyone lacking access — there is no
  client-side prediction of the access table from #321, deliberately, to
  avoid duplicating permission logic the server already enforces.
  `NewTaskDialog.tsx` is the "Nový úkol" form (brief, a `GET /runners`
  picker filtered to `installed && logged_in`, an instance picker shown
  only at >=2 instances for the runner with the calling node's
  organization default preselected via `RunnerInstanceSummary.org_defaults`
  — the same `instances.find(i => i.org_defaults.includes(orgId))` lookup
  `RunnersSection.tsx` already used) that calls `POST /sessions` and hands
  the fresh `{session, run}` back to its caller.
  **`NewTaskButton` (`DetailPane.files.tsx`, the former
  `TerminalSplitButton`) is a single "Nový úkol" button** opening
  `NewTaskDialog`; the terminal-launch dropdown it carried during phase 3
  went with the terminal (#345). `onSessionStarted` threads from there up
  through `DetailPane`'s two-layer prop passthrough (`DetailPane` ->
  `DetailPaneBody`) as an optional callback — inside `WorkspaceView` it
  sets the shown thread; **the graph view's own `DetailPane` passes one
  too, routing through `openSessionChat`** (switch to Práce, open the
  node, focus that session). It has no chat surface of its own, and
  leaving the callback off — the original #342 cut — meant a task started
  from Graf ran with nothing in the UI showing it until the user happened
  to open the same node in Práce.
  **`WorkspaceView`'s centre surface has three branches, EditorPane /
  SessionChat / DetailPane**: `SessionChat` renders whenever the selected
  node's `openSession` is `running` or `suspended` (closed/archived fall
  through to the plain node detail — those are history, not something to
  keep steering). `App.tsx` owns the state this depends on:
  ONE `SessionsClient` for the app's lifetime (`useState(() =>
  createSessionsClient())`, since the client opens its transport
  immediately — creating it lazily on first render, never per-render, is
  load-bearing), and `workspaceOpenSession` (`SessionSummary | null`),
  refetched via `fetchNodePersistentSessions(id, false)` whenever
  `selectedWorkspaceNodeId` changes (same `cancelled`-guard pattern as the
  neighboring `workspaceNodeDetail` effect), picking the first
  running/suspended row. `onSessionStarted`/`onSessionUpdated` both just
  set this same state, so starting a task or SessionChat reporting a
  `session_state` change both flow through the identical path.
- **#343 (runner batch phase 3, third issue) reads live session state in
  the Relace tab, the Práce sidebar and Přehled — three call sites, one
  shared helpers module.** `apps/web/src/lib/session-views.ts` is
  deliberately separate from `lib/session-chat.ts` (#342's own helpers,
  scoped to the chat surface itself): `sessionRowChip` uses different
  Czech wording for the SAME five states than `session-chat.ts`'s
  `sessionStatusChip` (Hotovo/Archiv here vs. Uzavřeno/Archivováno there)
  because a compact list row and a chat header are different contexts, not
  an inconsistency to fix. `sessionRowAccess(ownerId, meId, canManage)` is
  a client-side echo of #321's access table (read = seeing the row at all,
  since every caller here already fetched it via a node/list endpoint
  gated on node visibility; message/resume = owner only; stop
  (interrupt/suspend/close) = owner or manage) -- purely to avoid offering
  a button that would always 403, the server remains the real gate.
  `applyLiveSessionState`/`mergeLiveSessionStates` overlay a
  `SessionStateMessage` (state + waiting_since only, all it carries) onto
  a REST-fetched row. `sortInboxSessions` is Přehled's ordering: waiting
  first, then running, then suspended, restricted to `user_id === meId`
  -- `GET /overview`'s own `sessions.running`/`.suspended` are NOT
  restricted to the caller (they're every session on a node the caller can
  see, workspace-wide, per `apps/server/api/overview.ts`'s
  `filterSessions`); the restriction is this helper's job, client-side,
  matching the issue's "(the caller's own)" -- the team-wide view is later,
  host-aware work, not this issue. `countRunningSessions` sums a
  `session_state` map's `running` entries for `StatusFooter`'s count -- a
  session can be `running` without being open anywhere in this window.
  **`fetchMe()` widened to return `id`** (the server's `handleMe` already
  sent it; only the client's return type was narrower) -- `sessionRowAccess`
  needs the caller's own id, which `canManage` alone never carried.
  **`DetailPane.sessions.tsx`** dropped its own `STATE_LABEL`/`STATE_COLOR`
  exports (only ever used for one status dot each, both now `sessionRowChip`)
  and gained real actions where the row used to only show informational
  text: "Otevřít chat" (new `onOpenChat` prop, optional like
  `onSessionStarted`), and "Nahodit" -- previously `resumeInfo` was
  rendered as plain text with no button at all; now a single button whose
  label reflects the mode the server already determined
  (`resumeInfo.conversation_resumable ? "pokračovat" : "z handoffu"`),
  calling the already-existing `resumeSession(id, mode)` from #342 and
  re-`load()`ing the list after (no WS subscription in this REST-only
  tab -- simpler than threading `sessionsClient` in just for one row's
  refresh). "Owner name when not the caller" resolves through
  `fetchUsers()` (`GET /users`, manage-scope-gated, degrades to `[]`
  below that per its own doc comment) -- a plain teammate just never sees
  a name, which is fine, the row still works without one. "Host label when
  present" from the issue's own wording is a deliberate scope cut: `host_id`
  lives on `SessionRunRow`, not `SessionSummary`, so showing it here would
  mean an extra per-row `GET /sessions/:id/runs` fetch for a label the
  Přehled bullet itself says belongs to "the hosts spec's job" later.
  **`onOpenChat` threads from `App.tsx`'s new `openSessionChat(nodeId)`**
  through both `DetailPane` instances (graph view directly, Workspace view
  via `WorkspaceView.tsx`) and into `SessionsSection`. It replaces the
  OverviewView-only `overviewOpenSession`. `openSessionChat` just
  opens/selects the node; #342's own
  `workspaceOpenSession` fetch-on-select effect finds the session with no
  id needed. **`WorkspaceNodeList.tsx`** renders persistent-session
  sub-rows under each node, fed by `App.tsx`'s `liveOpenSessionsByNode` -- one
  `fetchNodePersistentSessions(id, false)` per entry in `openNodeIds`,
  refetched whenever that set changes, live-overlaid via
  `mergeLiveSessionStates` against the SAME app-wide `sessionStates` map
  `countRunningSessions` reads (`sessionsClient.onSessionState`,
  `Set`-backed so multiple listeners coexist -- SessionChat keeps its own
  separate subscription for its own event log, untouched). Threading is
  `App.tsx` -> `Sidebar.tsx` (`workspaceOpenSessionsByNode`/
  `onWorkspaceOpenSessionChat`) -> `WorkspaceNodeList.tsx`.

- **`SessionChat.tsx` is built on AI Elements now, not hand-written bubbles
  (#373, phase 1 of `docs/superpowers/specs/2026-09-15-task-surface-
  design.md`).** `apps/web` gained shadcn/ui (`components.json`, style
  `radix-nova`, `src/lib/utils.ts`'s `cn`) plus the primitives the chosen
  components declare (`button`, `collapsible`, `command`, `dialog`,
  `select`, `tooltip`, `badge`, `alert`, `scroll-area`, plus their own
  registry dependencies -- `input`, `textarea`, `input-group`,
  `button-group`, `separator`, `spinner`) and the AI Elements components
  themselves under `src/components/ai-elements/` (`conversation`,
  `message`, `reasoning`, `tool` + its `code-block` dependency,
  `confirmation`, `prompt-input`, `shimmer`, `checkpoint`) -- pulled via
  `npx ai-elements@latest add <name>`, each file keeping an Apache-2.0
  header recording the upstream component + `ai-elements` version it came
  from, so a later `add` reads as a diff. **Token bridge, not a restyle**:
  shadcn's `--background`/`--foreground`/`--muted`/...  are defined in
  `index.css` INSIDE the existing `:root, html[data-theme="dark"]` /
  `html[data-theme="light"]` blocks, each one a `var(--color-*)` reference
  -- Portuni's palette stays the only place a colour is defined; the
  generated `@theme inline` block only remaps `--color-background` etc.
  onto those, with the sidebar/chart tokens (unused by any component here)
  dropped. `@custom-variant dark` targets `[data-theme="dark"]`, not a
  `.dark` class (this app never adds one), so the copied components'
  `dark:` variants actually apply. **No `ai` package dependency**: every
  copied file that only imported it type-only (`UIMessage["role"]`,
  `ToolUIPart["state"]`, `ChatStatus`, `FileUIPart`) had that import
  replaced with a narrower local type matching this app's own
  `CanonicalEvent` shapes (`MessageRole`, `Confirmation`'s own two-state
  `requested | responded` in place of the SDK's seven-state tool-part
  machine, `ToolHeader`/`ToolInput`/`ToolOutput` typed against
  `ToolCallStatus` and plain strings since `ToolCallEvent.payload` is
  already serialized server-side) -- `prompt-input.tsx` dropped file
  attachments/screenshot capture/referenced sources/tabs entirely (unused,
  `ai`-typed, and dead weight) down to the composer shell + `Select`
  pieces a later model picker needs; `conversation.tsx` dropped
  `ConversationDownload` (an unused download-as-markdown feature) for the
  same reason. `collapseToolCalls` (`lib/session-chat.ts`) is unchanged and
  still runs before rendering; the bubble/tool-row/markdown JSX it used to
  feed is gone, replaced by `Message`/`Reasoning`/`Tool`/`Confirmation`.
  **Streamdown's cjk/code/math/mermaid plugins are lazy-loaded**
  (`lib/streamdown-plugins.ts`'s `useStreamdownPlugins`, a `Promise.all`
  of four dynamic imports cached module-wide) instead of bundled
  statically -- Streamdown renders plain markdown fine with `plugins`
  undefined, so the transcript never blocks on the chunk arriving.
  **`SessionChat` itself is lazy-loaded** (`WorkspaceView.tsx`'s
  `lazy(() => import("./SessionChat"))` + `Suspense`) -- without this the
  whole kit (radix-ui, shiki, motion, streamdown) would land in every
  window's startup bundle instead of only downloading when a thread is
  first opened; confirmed by comparing `npm --prefix apps/web run
  build`'s main entry chunk before/after (unchanged in size -- the
  lazy-loaded `SessionChat-*.js` chunk carries the new weight instead).
  `react-markdown`/`remark-gfm` stay for `MarkdownPreview` (the file
  preview), untouched by this issue. New pinned-exact deps: `streamdown`,
  `@streamdown/{cjk,code,math,mermaid}`, `use-stick-to-bottom`, `nanoid`.

## Security rules (from the auth refactor post-mortem)

1. **No secret in webview JS, ever.** If a JS module needs to know it, it
   can be exfiltrated trivially. The webview calls the `api_request` Tauri
   command; the Rust proxy injects the bearer header.
2. **No secret in plaintext on disk.** OS keychain (or varlock) only.
3. **Webview ↔ backend through Tauri commands, not direct HTTP.** Tauri's
   capabilities allowlist already enforces the trust boundary.
