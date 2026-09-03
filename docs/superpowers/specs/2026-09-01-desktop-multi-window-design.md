# Desktop multi-window: one window per workspace

`active_workspace` is a single value in `config.json`. Every Tauri command
that needs a workspace reads it, so switching workspace rewrites it and
reloads the webview, and only one workspace is usable at a time. This spec
binds a window to a workspace for the window's lifetime, making several
workspaces usable side by side.

Sidecars already run concurrently, one per enabled workspace, each on its own
port with its own data dir and Keychain accounts. The backend changes in one
place: sessions learn which terminal spawned them (phase 0).

**Prerequisite**: PR #200 (scope model v2 + persistent sessions), merged
2026-09-02. File references are to `main` after that merge.

## Window identity

A window is named `ws:<workspace_id>` and stays bound to that workspace until
it closes. One additional label, `bootstrap`, exists for the state where no
workspace does. `tauri.conf.json` stops declaring a window (`windows: []`);
all windows are created at runtime.

Commands take `window: tauri::Window` and resolve the workspace with
`ws_of(&window) -> Result<String, String>`, which parses the label and
validates it against `config.json`. The existing `*_ws(app, ws_id)` functions
(`keychain_get_ws`, `spawn_sidecar_ws`, `sidecar_port_and_token`, …) are
unchanged; commands become thin shells over them. `active_workspace(&app)`
survives only as the startup fallback (below).

Readers of `active_workspace` that are not plain commands and need the same
treatment:

- the `portuni-html` URI scheme handler (`lib.rs:2131`) resolves the mirror
  root from `ctx.webview_label()`, not from config;
- `load_auth_config` / `load_google_client` (`auth.rs:61-89`) take `ws_id`,
  so `auth_refresh`, `central_request`, `auth_logout` and the 401-retry in
  `api_request` (`lib.rs:1124-1137`) stay on the calling window's workspace;
- `pty_spawn` sets the legacy `PORTUNI_MCP_TOKEN` (`pty.rs:351-353`) from the
  calling window's workspace, not the fallback;
- `pty_write`, `pty_resize`, `pty_kill` (`pty.rs:577-628`) authorize only by
  session id today; `PtySession` gains `ws_id` and every PTY command refuses
  a session from another workspace.

Commands that are app-global by nature — workspace list and CRUD, updater,
profiles, clipboard, `open_external`, exit — take `AppHandle` as today and do
not call `ws_of`. The `bootstrap` window uses only those plus
`workspace_migration_status`, `get_turso_status`, `save_config`,
`setup_central`, `migrate_to_workspaces`.

`capabilities/default.json` scopes permissions to `"windows": ["main"]` and
becomes `["bootstrap", "ws:*"]`.

**Config writes.** Every command does read-modify-write on `config.json`
through one fixed `config.json.tmp` with no lock (`workspace.rs:170-178`).
With window open/close events joining the writers, a `ConfigLock` (a
`Mutex<()>` in managed state) wraps every load-modify-save.

## Bootstrap and startup

On a fresh install the `bootstrap` window renders `WorkspaceMigrationGate` and
`TursoSetupGate`. When the wizard writes a workspace, `bootstrap` closes and
`ws:<id>` opens. The gates' fresh-install paths drop their
`window.location.reload()`; `TursoSetupGate`'s "add a missing Turso token to
an existing workspace" path (`TursoSetupGate.tsx:77-92`) is not a bootstrap
path and keeps reloading its own window.

`config.json` gains `open_windows: string[]` with `#[serde(default)]`, so
existing v2 files still load. It is rewritten whenever a window opens or
closes, except during quit (see Close contract), so a crash does not lose it
and a quit does not empty it. At startup:

- each id in `open_windows` that still exists and is `enabled` gets a window;
- an empty or fully invalid list falls back to a single window for
  `active_workspace`;
- no workspaces in config at all opens `bootstrap`.

`active_workspace` is kept pointing at the workspace of the most recently
focused window: tracked in managed state on `WindowEvent::Focused`, persisted
together with `open_windows` (not on every focus change). When that workspace
is disabled or deleted it is reassigned to the workspace of the most recently
focused remaining window.

Window geometry is handled by `tauri-plugin-window-state`, which persists size
and position per window label.

**Readiness.** `backend-ready` / `backend-error` become per-window events
(`emit_to`). A sidecar may come up before its window exists, so window
creation checks `BackendPorts` and emits `backend-ready` to the new window at
once when the port is already known. `useAppUpdate` (`updater.ts:116-145`)
starts its check timers only from that event, so this is what keeps update
checks working in restored windows.

## The workspace switcher

`switchWorkspace()` (Sidebar dropdown, `Sidebar.tsx:318`; list in
`WorkspacesSection.tsx`) becomes `openWorkspaceWindow(id)`: focus the
existing window for that workspace, or open one. The dropdown no longer shows
a current selection but a jump target, and marks which workspaces already
have a window.

Workspace list changes reach every window: Rust emits a broadcast
`workspaces-changed` after any config mutation, replacing the document-local
`CustomEvent` in `WorkspacesSection.tsx:28` that only the emitting window
hears.

`create_workspace` opens and focuses the new workspace's window once its
sidecar is spawned.

`set_workspace_enabled(id, false)` and `delete_workspace(id)` are refused
while the workspace has an open window ("close its window first"). This
replaces today's "cannot disable the active workspace — switch first" and
avoids an asynchronous close handshake inside a config mutation. "Cannot
delete the last workspace" stays.

## Close contract

**What dies with a window.** Its PTY sessions. Not its sidecar: a sidecar is
bound to `enabled`, not to a window, and external MCP clients (a Claude Code
started in a mirror outside the app) address it on its fixed port. The
`on_window_event(Destroyed) -> kill_all_sidecars` handler (`lib.rs:2300`) is
removed; sidecars die at app exit, which the existing `ExitRequested` /
`Exit` handler already covers.

**Sessions follow PTY exit.** A persistent session row and the PTY that
spawned its CLI share no id today: the terminal id is browser-generated
(`term_<node>_<ts>_<rand>`, `lib/sessions.ts:66`), the session id is a server
ULID minted when the CLI's MCP connection initializes
(`session-persistence.ts:139`), and the server notices a vanished CLI only
through the 30-minute idle GC (`transport.ts:18-45`). Phase 0 adds the
correlation:

- `pty_spawn` exports `PORTUNI_TERMINAL_ID=<terminal id>`;
- `buildClaudeMcpJson` (`write-scope.ts:276`) adds the header
  `X-Portuni-Terminal: ${PORTUNI_TERMINAL_ID:-}`, the same env-expansion
  channel `X-Portuni-Profile` already uses; the transport stores it on the
  session row (`sessions.terminal_id`, new column);
- on PTY exit — for any reason: close dialog, user typing `exit`, CLI crash —
  the Rust reader that emits `pty-exit` also calls the workspace sidecar's
  `POST /terminals/:terminal_id/exit`, which moves every `running` session
  with that `terminal_id` to `closed`;
- the transport's idle GC additionally moves the GC'd MCP session's
  persistent row from `running` to `closed`, as the backstop for CLIs whose
  config format cannot carry the header (Codex, Vibe) and for crashes that
  never reach the exit endpoint.

Killing a PTY is then the only action a window performs; the state
transition is the server's, and the "rows stuck in `running`" gap that exists
today closes with it.

**The dialog (phase 3).** The webview's `onCloseRequested` guard runs in
order: dirty editor, unsynced files (both exist today, `App.tsx:654-661`),
then running terminals. For running terminals it offers:

- **Ukončit** — `pty_kill` for each; sessions close via the exit endpoint.
- **Pozastavit** — offered for terminals the window spawned as an agent (a
  fact the frontend knows from the spawn command; the session row's `cli`
  column is always `NULL` and cannot be used) that have a correlated
  `running` session. The app writes an instruction into the PTY asking the
  agent to call `portuni_session_suspend`, polls the correlated sessions
  until none is `running` (30 s timeout), then kills. On timeout the kill
  proceeds and the sessions close; the dialog says so.
- **Zrušit** — cancels the close.

Until phase 3, closing a window with running terminals passes the two
existing guards and then a plain "N terminals will be closed" confirm.

**Cmd+Q and restart.** Today's gate is single-window: `app-exit-requested` is
broadcast, the first window to call `approve_exit` exits the app for everyone
(`lib.rs:475-481`), and `schedule_exit_fallback` force-exits after 5 s when no
approval arrives (`lib.rs:43-55`) — which it also does when the user picks
"Zrušit", because cancel never answers. Phase 2 replaces it: quit asks each
window to close in turn through its own `onCloseRequested` guard; a declined
close aborts the quit and clears the fallback timer (new `decline_exit`
command); when all windows have closed, Tauri raises exit. A `quitting` flag
in managed state suppresses the `open_windows` rewrite during this sequence,
so the next launch restores the pre-quit set. The updater's "Restartovat"
(`restart_app`, `updater.rs:98-101`, today an unconditional
`kill_all_sidecars` + restart) goes through the same sequence.

## Per-window plumbing

**Events.** `app.emit` broadcasts to every window, so a second window would
receive the first one's terminal output. Per-workspace events —
`backend-ready`, `backend-error`, `pty-data`, `pty-exit`, `pty-foreground` —
move to `emit_to(<window label>, …)`, which also removes the `is_active_ws`
gating in `spawn_sidecar_ws`. Broadcasts stay for app-global facts:
`workspaces-changed`, updater progress.

**localStorage.** All windows share one webview origin. Workspace state gets
namespaced as `portuni:<ws_id>:<key>`: `openNodes`, `fileTreeCollapsed`,
`workspace.detailVisible` (`WorkspaceView.tsx:93-100`), and the central-mode
`first-steps-pending` flag (`CentralLoginGate.tsx:40-79`, which one central
workspace could otherwise clear for another). Unscoped values are migrated
once, at the first launch of phase 2, into the `active_workspace` namespace
and then deleted — they belonged to the workspace that was active when they
were written. `theme`, `agentCommand` and `terminalLaunch` stay global as user
preferences; each window subscribes to the `storage` event so a change in
one window applies to the others (today they are read once into React state,
`App.tsx:83-100`).

**Window URL state.** `?view=`, `?node=`, `?settingsTab=` are per-window
webview state and need no workspace prefix; there is no external deep-link
handler.

**Second app instance.** `spawn_sidecar_ws` calls `reap_orphan_sidecar(port)`,
which `kill -9`s any foreign `portuni-sidecar` holding the port, so a second
instance (`open -n`) kills the first one's sidecars.
`tauri-plugin-single-instance` makes a second launch focus the most recently
focused window instead (or open `active_workspace` if none is open).

## Terminal activity indicator

The `pty-foreground` signal (500 ms poll thread in `pty.rs:452-497`,
`ForegroundEvent`, `foregroundBusy` in `lib/sessions.ts`) reports "a
subprocess owns the terminal foreground". An interactive agent TUI owns it
for its whole lifetime, so the dot is lit for every terminal running an
agent, idle or not, and the signal's presence disables the output-recency
fallback (`sessions.ts:175`). It is removed. `sessionIsAgentWorking` keeps
the `isAgentCommand` gate and uses only output recency (`isSessionActive`,
1.5 s), which is harness-agnostic. No CLI-specific signal (hooks, JSONL)
replaces it; if recency proves to flicker on an idle TUI, the dot goes too.

## Phases

- **Phase 0 — terminal ↔ session correlation** (backend + `pty_spawn`):
  `PORTUNI_TERMINAL_ID`, `X-Portuni-Terminal` header, `sessions.terminal_id`
  migration, `POST /terminals/:id/exit` called from the PTY exit path, GC
  backstop close. Independent of multi-window; closes the stale-`running`
  gap on its own. Same phase, separate issue: removal of the
  `pty-foreground` signal (above).
- **Phase 1 — window identity**: `ws_of`, label-derived routing in every
  workspace-bound command including the html protocol, auth and PTY paths;
  `bootstrap` window; `windows: []` in `tauri.conf.json`; capabilities glob;
  `ConfigLock`. Still one window; no user-visible change.
- **Phase 2 — multi-window**: `open_windows` restore, switcher opens/focuses,
  per-window events and readiness on window create, localStorage namespacing
  + migration + `storage` sync, `workspaces-changed` broadcast, disable/delete
  refusal while a window is open, sidecar teardown moved to app exit,
  sequential-close quit with `decline_exit` and the `quitting` flag, updater
  restart on the same path, `tauri-plugin-single-instance`,
  `tauri-plugin-window-state`. Closing a window with running terminals uses
  the plain confirm.
- **Phase 3 — session-aware close**: the Ukončit / Pozastavit / Zrušit dialog
  on window close, and a "Pozastavit" action in `DetailPane.sessions.tsx` for
  rows whose `terminal_id` matches a live terminal in this window.

## Testing

Server: `terminal_id` round-trip through the header, exit endpoint closes
only that terminal's `running` sessions and leaves `suspended` alone, GC
backstop close. Rust: `ws_of` parsing and validation against config,
`open_windows` round-trip and its preservation across quit, PTY command
refusal across workspaces, disable/delete refusal while a window is open,
`decline_exit` clearing the fallback timer. Web: namespaced keys and their
one-time migration, switcher focus-vs-open, `sessionIsAgentWorking` without
`foregroundBusy`. Gate: `scripts/agent-gate.sh`.

Window behaviour has no automated path: `tauri-driver` supports Linux and
Windows only, and the agent loop runs in Docker without a display. Each
phase-2/3 PR carries a manual checklist run on a signed local build: two
windows reach different sidecar ports (Settings → MCP shows each window's
own port), terminal output stays in its window, close dialog per window,
Cmd+Q with a declined close in one window aborts the quit, restart via the
updater, second launch via `open -n` focuses instead of respawning.

## Docs site

`clients/desktop-app.md:32` states "the UI switcher only changes which one
you're looking at" — rewrite for one window per workspace, in the same branch
as phase 2. Check the Settings description at line 17 and
`guides/working-in-the-app.md` for switcher wording while there.

## Explicitly out of scope

- In-place workspace switching inside a window.
- Several windows over the same workspace.
- Terminal correlation for Codex and Vibe: their config formats have no
  runtime header expansion; their sessions close through the GC backstop.
- External deep links (no handler exists).

## References

- Prerequisite: PR #200, `docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md`.
- Multi-workspace model: `docs/archive/specs/2026-07-04-desktop-multi-workspace-design.md`.
