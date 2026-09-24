# Desktop shell (Tauri)

The desktop app is a Tauri 2 host around the web UI. It owns every secret,
spawns one sidecar per enabled workspace, opens one window per workspace, and
proxies every request the webview makes. A team workspace is the primary
operating mode: there the sidecar is the **sync agent** and the graph lives on
the central server; a personal workspace runs the same sidecar as a full
server. Every mechanism below works in both kinds of workspace unless a section says
otherwise. Rust lives in `apps/desktop/src/` (`lib.rs`, `auth.rs`,
`sessions_ws.rs`, `updater.rs`, `workspace.rs`, `shell_path.rs`,
`mcp_install.rs`).

## config.json and workspaces

- `config.json` (v2, `apps/desktop/src/workspace.rs`) holds a `workspaces`
  map, `active_workspace` and `open_windows`. Per workspace: `enabled`,
  `mcp_port`, `data_mode`, `server_url`, `google_client_id`, the workspace
  root. Nothing secret is in it. A `profiles` key from an old file loads,
  is ignored and is dropped on save. Design:
  `docs/archive/specs/2026-07-04-desktop-multi-workspace-design.md`.
- Every enabled workspace runs its own sidecar at the same time: a port
  allocated from `47011` (`DEFAULT_MCP_PORT_BASE`) upward, data dir
  `workspaces/<id>/`, Keychain accounts `<base>.<id>`. Disabling a
  workspace stops its sidecar; closing its window does not (see Quit
  sequence).
- Per-mirror MCP configs reference the token as `PORTUNI_MCP_TOKEN_<ID>`
  (the server learns its id from `PORTUNI_WORKSPACE_ID`; a standalone
  server without one keeps `PORTUNI_MCP_TOKEN`). The name comes from
  `workspace::token_env_var` in Rust and `clientTokenEnvVar()` on the
  server; both are tested against `apps/server/shared/token-env-var-cases.json`
  (#521). The sidecar itself verifies `PORTUNI_AUTH_TOKEN`, which the host
  always passes: a sidecar without it refuses to start and the host shows
  the `PORTUNI_BACKEND_ERROR=` line. Global MCP entries are
  named `portuni-<id>`; a workspace migrated from the single-workspace
  layout keeps the historical `portuni` entry.
- **Every config.json load-modify-save goes through `ConfigLock`**, a
  `Mutex<()>` in managed state: `with_config_mut(app, |file| ...)` for an
  existing v2 file, `with_config_write_lock(app, || ...)` for onboarding
  and migration commands that may start from a v1 or missing file and
  build the v2 file themselves (`migrate_to_workspaces` wraps its whole
  DB-file, Keychain and config sequence, not only the final save). Both
  wrap `with_config_mut_at(lock, data_dir, mutate)`, the unit-tested core.
  A new config-mutating command uses one of the two; none writes the file
  directly.
- After every successful `with_config_mut`/`with_config_write_lock` call
  Rust broadcasts `workspaces-changed` to all windows. `Sidebar.tsx` and
  `WorkspacesSection.tsx` `listen()` for it; a document-local
  `CustomEvent` would reach only the dispatching window.

## Team workspace setup and the sync agent

- `data_mode: "central"` plus `server_url` and `google_client_id` switch a
  workspace to the central server for the graph and for file content.
  Settings → Účet offers Google login and device tokens. The refresh token
  and the session JWT live in the Keychain; the webview reaches the
  central server only through the `central_request` Tauri command
  (`auth.rs`). End-to-end login needs the Workspace OAuth client (admin
  checklist in the design spec §6).
- Teammate onboarding is the wizard „Připojit se k týmu": the user enters
  only the server URL; `setup_central` downloads the public OAuth client
  from `GET /auth/desktop-config` and writes `config.json` with
  `data_mode: "central"`. A hand-written `config.json` with the same keys
  works as a fallback.
- In a team workspace the sidecar runs as the **sync agent**:
  `spawn_sidecar_ws` passes `PORTUNI_AGENT_MODE=1`, `PORTUNI_CENTRAL_URL`,
  `PORTUNI_CENTRAL_TOKEN` (the device token from
  `auth::ensure_device_token`, Keychain label "Sync agent") and
  `PORTUNI_URL`. No Turso token and no Drive credentials reach the device;
  everything goes to the central server with the device token. The sync agent keeps local
  mirror folders, the mirror watcher and file sync, and serves the MCP
  front door: per-mirror `.mcp.json` points at
  `http://127.0.0.1:<port>/mcp`, never at the central server. Graph and scope tools
  are proxied to the central server unchanged; device-local tools (mirror, status,
  store, pull, adopt_files) run on the device.
- The agent starts only after Google login. Before that
  `spawn_sidecar_ws` records the sentinel port `0` in `BackendPorts`,
  emits `backend-ready` with `0` so the login gate renders, and every
  device-local route answers `501 sync_agent_down` (see Request routing).
  `google_login` re-invokes `spawn_sidecar_ws` after a successful login.
- The sidecar needs a login shell's `PATH` to find `claude`;
  `shell_path::login_shell_path` provides it. There is no embedded
  terminal, PTY or spawn-profile registry in the shell; an agent runs only
  as a task (`POST /sessions`), see
  `docs/superpowers/specs/2026-09-12-runner-and-session-design.md`.
- E2E harness for teammate mirrors: `scripts/e2e/teammate-mirrors.sh`.
  Model: `docs/architecture/data-modes.md`.

## Windows

Design: `docs/superpowers/specs/2026-09-01-desktop-multi-window-design.md`.

### Labels and creation

- `tauri.conf.json` declares no windows (`app.windows` is `[]`); every
  window is created at runtime. A workspace window is labelled `ws:<id>`;
  the only other label is `bootstrap` (fresh install, or a v1 config still
  awaiting migration). No window is ever labelled `main`; code that needs
  "is any window open" checks `!app.webview_windows().is_empty()`.
- `capabilities/default.json` lists `windows: ["bootstrap", "ws:*"]`.
  Custom app commands need no per-command capability entry; that window
  scope covers them.
- Startup (`create_startup_windows`, pure core `startup_window_labels`):
  one window per `open_windows` id that still exists and is enabled; an
  empty or fully invalid list falls back to one window for
  `active_workspace`; nothing valid opens `bootstrap`.
- Bootstrap → workspace handoff: `migrate_to_workspaces` and the
  fresh-install branches of `save_config`/`setup_central` call
  `handoff_from_bootstrap` after saving, which opens the new `ws:<id>`
  window and closes `bootstrap`. The onboarding gates do nothing in JS
  after the command resolves. `TursoSetupGate`'s add-missing-token path
  (an existing workspace restarting its own sidecar) reloads its own
  window instead; no handoff is involved.
- `open_window` builds every window with `.disable_drag_drop_handler()`
  (#444). Tauri's own handler intercepts drops of Finder files and, on
  macOS, blocks the HTML drag and drop API inside the webview; Portuni
  handles no Finder drops, and the Files tab moves files with HTML drag
  and drop, so the handler stays off on every window.
- `tauri-plugin-window-state` persists each window's geometry by label on
  the Rust side; no webview capability is needed.

### `ws_of`: a command acts on the window's own workspace

- `ws_of(&tauri::Window)` parses the `ws:<id>` label and validates it
  against `config.json`; `bootstrap` and any other label are errors.
  `ws_of_from_dir(label, data_dir)` does the same for the `portuni-html`
  URI scheme handler, which has only `ctx.webview_label()`.
- **Every workspace-bound command takes `window: tauri::Window` and
  resolves `ws_of(&window)?`, never the globally active workspace**:
  `api_request` (its 401 retry refreshes with the same window),
  `get_backend_port`, `get_mcp_token`, `regenerate_mcp_token`,
  `set_turso_token`, `clear_turso_token`, `get_data_mode`,
  `open_path_external`, `restart_sidecar` (an explicit `id` wins; `None`
  means this window's own), and `auth.rs`'s `auth_status`,
  `google_login`, `auth_refresh`, `auth_logout`, `central_request`
  (`load_auth_config` takes an explicit `ws_id`).
- App-global commands keep `AppHandle` and never call `ws_of`, because a
  `bootstrap` window legitimately calls them: workspace list and CRUD,
  updater, clipboard, `open_external`, exit, `workspace_migration_status`,
  `get_turso_status`, `save_config`, `setup_central`,
  `migrate_to_workspaces`.

### Open windows, focus history, active workspace

- `open_windows` is rewritten by `persist_open_windows` whenever a
  `ws:<id>` window opens (`open_window`) or is destroyed
  (`on_window_event`), never on a bare focus change. It writes the ids of
  every live `ws:<id>` window and refreshes `active_workspace` from the
  focus history.
- `FocusHistory` (managed state, oldest first) is the only thing focus
  updates in memory: `touch_focus` on `WindowEvent::Focused(true)`,
  `untrack_focus` on `Destroyed`. It answers what `active_workspace`
  should be and, through `reassign_active_workspace`, what it becomes
  when the named workspace is disabled or deleted (fallback: the first
  remaining enabled workspace in map order).
- `set_workspace_enabled(id, false)` and `delete_workspace` refuse
  („Nejdřív zavři okno tohoto workspace.") while `window_open_for` finds
  a `ws:<id>` window for that workspace; a window can be open for a
  workspace that is not the active one. Deleting the last workspace is
  refused as well.
- `create_workspace` spawns the sidecar (`spawn_sidecar_ws`) and then
  opens and focuses the new window.

### Switcher

- `open_workspace_window(id)` focuses the `ws:<id>` window if one exists,
  otherwise validates that the workspace exists and is enabled and creates
  it (`open_window` itself does not check). `openWorkspaceWindow`
  (`apps/web/src/lib/workspaces.ts`) is the frontend wrapper. There is no
  content swap and no page reload.
- The sidebar `WorkspaceSwitcher` is a jump target, not a selection: it
  resets to a disabled placeholder and marks entries `(otevřeno)` from
  `list_workspaces`' `window_open`, computed live from
  `app.webview_windows()`, never from the persisted `open_windows`.
  `WorkspacesSection.tsx`'s row action calls the same command.

## Quit sequence

- Cmd+Q, menu Quit, an OS exit request (Dock, logout) and the updater's
  „Restartovat" all call `begin_quit(app, QuitAction::{Exit,Restart})`.
  It snapshots every open window label into `QuitQueue` (managed state,
  `Option<QuitState>`; `None` means no quit in progress, read by
  `is_quitting()`), then closes the windows **one at a time** with
  `window.close()`, the same `tauri://close-requested` event the native
  close button raises.
- **There is exactly one close guard**: the webview's `onCloseRequested`
  listener in `App.tsx` (dirty editor, unsynced files). Runs belong to the
  sidecar and survive a window close, so no guard asks about them. There
  is no separate app-exit broadcast or approve command.
- `quit_advance` (pure, `Option<QuitState> -> QuitAdvance`) decides after
  each `Destroyed` event whether to close the next queued window or run
  the terminal action (`app.exit(0)`, or kill every sidecar then
  `app.restart()`); outside a quit it is `QuitAdvance::Idle`.
- Declining in any guard goes through `declineExit()`/`decline_exit`,
  which calls `quit_abort`: `QuitQueue` becomes `None`, windows already
  closed stay closed, no further window is asked, the app does not exit.
  Harmless when no quit is in progress.
- `schedule_exit_fallback` arms a 5 s timer scoped to the window just
  asked and force-destroys only that one; a generation counter lets a
  superseded timer defer (`fallback_should_fire`). It is a safety net for
  a hung webview, not the normal path.
- **`open_windows` is never rewritten mid-quit**: `persist_open_windows`
  checks `should_persist_open_windows(is_quitting())` first, so the next
  launch restores the pre-quit window set.
- **Sidecars die only in the app-exit handler**
  (`RunEvent::ExitRequested`/`Exit`), never on a window close. A sidecar is
  bound to `enabled`, and an external MCP client addresses it on its fixed
  port regardless of any window.
- `quit_sequence_tests` cover the reducer and, through
  `with_config_mut_at` on a temp file, that `open_windows` survives a
  completed quit. Real two-window behaviour is macOS-only verification.

## Single instance

- `tauri_plugin_single_instance::init` is registered as the **very first**
  plugin (Tauri's requirement). A second launch (`open -n`, Dock re-click
  without a frontmost window) relays its argv and cwd to
  `focus_or_open_most_recent_window` and exits before reaching
  `spawn_all_sidecars`. Without it the second process would reach
  `spawn_sidecar_ws`, whose `reap_orphan_sidecar(port)` kills any foreign
  `portuni-sidecar` holding a workspace port, and take the first
  instance's sidecars down.
- Target (`single_instance_target`, pure): the most recently focused
  window from `FocusHistory`, else `active_workspace`, else `bootstrap`
  when no workspace exists yet. The plugin registers no invokable
  commands, so no capability entry is needed.

## Backend events and replay

- `backend-ready` and `backend-error` are emitted **per window**
  (`app.emit_to("ws:<id>", …)`) from `spawn_sidecar_ws`'s reader loop and
  its deferred-central branch. A window only ever receives its own
  workspace's events.
- A sidecar can finish booting or crash before its window exists (startup
  races window restoration), so `open_window` calls
  `replay_backend_status` right after building a `ws:<id>` window:
  `backend-ready` replays from `BackendPorts` when a port is known,
  `backend-error` from `PendingBackendErrors` (last error per workspace,
  `set_pending_backend_error`/`clear_pending_backend_error`, cleared on
  the next `backend-ready`). Pure cores: `backend_status_replay`,
  `record_pending_backend_error`, `retire_pending_backend_error`.
- In a team workspace before login the replayed `backend-ready` carries the
  sentinel port `0`.

## localStorage namespacing

- All windows share one webview origin, so per-workspace UI state is keyed
  `portuni:<ws_id>:<key>` (`apps/web/src/lib/workspace-storage.ts`):
  `openNodes`, `fileTreeCollapsed`, `workspace.detailVisible`,
  `first-steps-pending` (the team workspace's first-login guidance flag).
  `currentWorkspaceId()` reads the id synchronously from
  `getCurrentWindow().label`; `scopedKey(key)` falls back to the unscoped
  `portuni:<key>` in a plain browser or Vite build, which has no workspace.
- `migrateUnscopedStorageForCurrentWindow()` runs synchronously in
  `main.tsx` before React renders and before `CentralLoginGate`'s mount
  effect reads a scoped key: it moves each unscoped key into this
  window's namespace and deletes it, idempotently, never overwriting an
  existing namespaced value. Pure core `migrateUnscopedStorage`, tested in
  `test/workspace-storage.test.ts`.
- `theme` stays global by design. `App.tsx` subscribes to the native
  `storage` event, which fires in every other window on a write, so a
  theme change applies live everywhere.

## Webview proxy secret and the REST write gate

- The Tauri host generates `PORTUNI_WEBVIEW_PROXY_SECRET` fresh per launch,
  passes it to the sidecar's env, and attaches it as
  `X-Portuni-Webview-Proxy` on every proxied request and on the WebSocket
  upgrade. It is never written to disk and never exported into a spawned
  agent's env. The packaged app therefore always runs the hardened posture.
- With the secret set, an `env`-mode REST write needs a valid
  `X-Portuni-Webview-Proxy` header or a resolvable `X-Portuni-Spawn-Id`
  session; anything else is refused. Unset (backend-tmux + Vite loop, the
  test suite) every env-mode REST write is allowed. The Vite dev proxy
  (`apps/web/vite.config.ts`) injects the same header on `proxyReq` and
  `proxyReqWs` when configured, so the secret never reaches client JS in
  dev either.
- The team-workspace sync agent applies the same posture through
  `guardAgentRestWrite` on every mutating route it serves (file create,
  delete, resolve, rename, move, `PUT /nodes/:id/file`, sync run, mirror
  create, session actions). It has no graph db or session table to
  resolve a spawn id against, so the proven header is the only accepted
  proof there; a spawned agent mutates through MCP tools, which central
  write-gates.
- MCP tool calls are outside this gate in both kinds of workspace. Spec:
  `docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md`.

## Request routing

- The webview never makes HTTP requests itself. `api_request(window,
  method, path, body, headers)` resolves the window's workspace and:
  - personal workspace: proxies to `http://127.0.0.1:<port><path>` on the
    workspace's sidecar with its bearer token (`sidecar_port_and_token`);
  - team workspace: sends the request to `server_url` with the session
    JWT (`auth::do_central_request_raw`), retrying once after a silent
    refresh on 401, **unless** `is_device_local_path(path)` is true; then it
    proxies to the local sync agent exactly as a personal workspace would.
- The device-local list is the set of routes the device must serve itself
  (mirrors, sync status and runs, file content and file lifecycle, runner
  registry, task actions). The canonical list is
  `apps/server/shared/device-local-routes.json`; `is_device_local_path` in
  `lib.rs` embeds it (`include_str!`) and matches the request path against
  its `device_local` patterns (`{name}` is one segment, the query string is
  ignored), and `test/agent-router-route-parity.test.ts` holds
  `apps/server/api/agent-router.ts` to the same list. **A new device-served
  route is added in all three places in the same change**: the local
  router, the agent router and the JSON file. A handler added to the agent
  router without the JSON entry is never reached from the desktop, and a
  JSON entry without a handler lands on the agent router's `501 agent_mode`
  fallthrough; either fails the parity test.
- A team workspace whose sync agent is not running (not logged
  in, or no `server_url`) answers every device-local route with
  `501 {"error":"sync_agent_down","detail":"sync agent not running"}`.
  `apps/web/src/api.ts` turns it into `SyncAgentDownError`, which the UI reads
  as "not signed in", never as "feature unavailable".
- Routes deliberately not device-local, served by the central server in a team workspace:
  `/nodes/:id/file-url`, `/nodes/:id/folder-url`, the session record half
  (`GET`/`PATCH /sessions/:id`, `/state`, `/resume-info`, `/runs…`,
  `/sessions/record`), `GET /nodes/:id/sessions`, `/overview`,
  `GET /sync/watch`.

## Live-channel bridge

- `apps/desktop/src/sessions_ws.rs` holds the task WebSocket in Rust,
  never in the webview. `sessions_connect`/`sessions_send`/
  `sessions_disconnect` open one connection per window to that window's
  own sidecar (`ws_of` + `sidecar_port_and_token`, the same bearer source
  as `api_request`, sent as `Authorization: Bearer` on the handshake). In
  both kinds of workspace the target is the device's own sidecar: the task runtime runs
  there, and in a team workspace the sidecar's live channel is bound to the
  central session store.
- Every server frame is re-emitted per window as `session-event`;
  connection status as `session-connection {status}` with
  `open|reconnecting|closed`. Reconnect backoff doubles from 1 s to 30 s
  (`next_backoff_ms`, unit tested). `SessionsWsState` is keyed by
  workspace id and carries a `generation` counter bumped on every connect
  and disconnect, so a background task from a superseded connect exits
  instead of resurrecting a connection.
- Frames wait in a per-connection `Outbox` (a queue, not a channel) until
  the socket is open, across a reconnect too. `sessions_cancel(id)` takes
  a still-queued frame back out by its request id; the web client cancels
  every request it reports as failed (timeout, drop), so a failed request
  is never delivered afterwards (#496). A frame already written is out of
  reach. Closing the outbox (`sessions_disconnect`, a superseding
  connect) is what tells the background task to close its socket and exit.
- `disconnect_for_ws` runs from `sessions_disconnect` and from
  `on_window_event`'s `Destroyed` arm, because a force-closed window never
  calls the command itself.
- Dependencies `tokio-tungstenite`, `tokio`, `futures-util` use default
  features only, no TLS: every target is loopback `ws://127.0.0.1`.
- `apps/web/src/lib/sessions-client.ts` is the one client interface over
  two transports: Tauri (the three commands and two events) and a direct
  `WebSocket` to `/api/sessions/ws` in Vite dev, where the dev proxy
  injects the bearer (`ws: true` + `proxyReqWs`). The direct transport
  queues frames until `onopen`, reimplements the backoff in TS, tracks the
  highest `seq` per session (never moved by `delta` frames) and
  subscribes every wanted session (with `after: <seq>` after a drop) on
  each open, so the server's replay fills exactly the gap. `cancel(id)`
  drops a still-queued frame, the same contract as `sessions_cancel`.
  `session_state` and `session_states` frames go to one global listener
  set.
  `test/sessions-client.test.ts` covers the direct transport against a
  fake `ws` server.

## Update check

- `check_update` (`updater.rs`) talks only to the GitHub releases
  endpoint and does not depend on the sidecar. `useAppUpdate`
  (`apps/web/src/lib/updater.ts`) calls `scheduler.schedule(checkNow)` on
  mount and on every `backend-ready`; a repeat call resets the timers
  rather than stacking them. `createUpdateScheduler`
  (`lib/update-schedule.ts`) takes injected timers and is tested through
  the server's `node:test` runner. A window regaining focus after a full
  interval checks immediately (`shouldCheckOnFocus`), since a suspended OS
  fires no JS timers. `AppUpdate.lastCheckedAt` is set on every completed
  attempt and shown in Settings → Obecné → Aktualizace. Design:
  `docs/superpowers/specs/2026-08-28-desktop-auto-update-design.md`.
- Updater artefacts are CI-only; the rollout and rollback commands are in
  `docs/release-process.md`.

## Security rules

1. **No secret in webview JS, ever.** A value a JS module can read can be
   exfiltrated. The webview calls `api_request`; the Rust proxy injects the
   bearer header.
2. **No secret in plaintext on disk.** OS Keychain (or varlock in dev)
   only. `config.json` carries no secret; the per-launch proxy secret
   lives in process memory.
3. **Webview ↔ backend only through Tauri commands, never direct HTTP or
   WebSocket.** The capabilities allowlist is the trust boundary; the
   live channel is held in Rust for the same reason.

## See also

- `docs/architecture/data-modes.md`: what local and team workspace are and
  which plane goes where.
- `docs/architecture/sessions-and-runner.md`: the task runtime the bridge
  streams.
- `docs/env-vars.md`: every env var the sidecar reads; `PORTUNI_ROOT`
  (write-scope tiering) is not `PORTUNI_WORKSPACE_ROOT` (mirrors).
- `docs/release-process.md`, `CONTRIBUTING.md`: signed builds, rollout.

## Central requests have a deadline

`api_request` in a team workspace forwards to the central server through
the shared `reqwest` client, which has no timeout of its own (the local
sidecar path runs sync jobs through it that take minutes). Every central
call gets a per-request deadline instead (`CENTRAL_REQUEST_TIMEOUT` in
`auth.rs`, 30 s): each CI deploy restarts central, and a connection left
half-open by that otherwise hangs the request forever, which the webview
shows as a click that did nothing. No central route streams; `GET
/sync/watch` is a poll.
