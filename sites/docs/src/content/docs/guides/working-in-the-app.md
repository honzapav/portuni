---
title: Working in the Desktop App
description: Daily-driver workflows in Portuni.app — graph navigation, the workspace layout, embedded terminals, and the settings surface.
---

This guide covers what you actually do in `Portuni.app` once it's installed. For installation and first-run setup, see [Desktop App](/clients/desktop-app/).

The app has four views, switched from the left sidebar:

- **Overview (Přehled)** — a read-only, workspace-wide dashboard. Default landing view.
- **Graph** — the Cytoscape force-directed visualisation.
- **Workspace** — the three-column layout with a node list, terminal tabs, and a detail pane. Where most daily work happens.
- **Settings** — Turso credentials, theme, agent-command preset, MCP server section, and actors management.

The currently selected node lives in the URL as `?node=<id>`, so deep-linking and copy-pasted URLs work across views.

## Overview (Přehled)

The default landing view: one aggregate, permission-filtered snapshot of the whole workspace (`GET /overview`), composed deterministically — no LLM involved. Four cards:

- **Relace** — every running/suspended persistent session across the workspace (not just this device), plus a headless review queue: nodes a `headless` session reached only via search with no edge path (`session_scope.added_via = 'disconnected'`) — see [Scope Enforcement](/concepts/scope-enforcement/).
- **Vyžaduje pozornost** — processes in `at_risk`/`broken`, areas in `needs_attention`, projects with `health != on_track` (see [Lifecycle States](/concepts/lifecycle-states/#project-health)), plus pending access requests (visible to `manage` scope and above only) and stuck sync operations (`pending_file_ops` rows with a recorded `last_error` — the closest server-visible signal to a sync issue; true file-conflict state is computed on-device and is not aggregated server-side).
- **Poslední aktivita** — recent events and recent session writes (nodes added to a session's write scope), interleaved by timestamp.
- **Nové nody** — recently created nodes, human- and agent-created alike.

Every row is a link: clicking a node reference switches to Graph and selects it; clicking a session reference opens its node in Workspace and focuses that session. Nothing here is fetched automatically on an interval — use "Obnovit" to refresh.

## Graph view

The cytoscape view uses the `fcose` force-directed layout. Pan with the trackpad, zoom with pinch or scroll, click a node to focus it.

The sidebar carries four filter groups:

- **Type** — `organization`, `project`, `process`, `area`, `principle`
- **Status** — `active`, `completed`, `archived` (archived is hidden by default)
- **Relation** — `belongs_to`, `related_to`, `applies`, `informed_by`
- **Organization** — toggle each org on/off

There's also a search box that filters by name (diacritics-folded). Hide everything except one org + one type to find a needle in a large graph.

When a node is selected, the detail pane on the right shows the same payload `portuni_get_node` returns — owner, responsibilities, data sources, tools, edges, recent events, files, local mirror path.

## Workspace view

The three-column daily-driver layout:

```
┌──────────────┬────────────────────────────┬──────────────┐
│ Node list    │  Terminal tabs             │ Detail pane  │
│ (260 px)     │  + xterm panes             │ (collapsible)│
│              │                            │              │
│ Sessions     │  [tab1] [tab2] [+]         │              │
│ for each     │  ───────────────────────   │              │
│ node, with   │  $ claude                  │              │
│ activity     │                            │              │
│ indicator    │                            │              │
└──────────────┴────────────────────────────┴──────────────┘
```

- **Node list** (left) — every node that has at least one terminal session, plus the currently selected one. Each row shows an activity dot when the session has emitted output recently.
- **Terminal tabs** (middle) — per-node tab strip; `+` opens a new session attached to that node. See [Embedded terminals](#embedded-terminals) below.
- **Detail pane** (right) — the same `DetailPane` the graph view uses, in "embedded" mode. Click the chevron at the top to collapse it; the state persists in `localStorage` under `portuni:workspace.detailVisible`.

## Embedded terminals

The middle column of the workspace view holds full xterm.js terminals wired to a real PTY in the Tauri backend (`src-tauri/src/pty.rs`). They are not a JS pseudo-shell — full ANSI, colour, TUI compat, web links, Unicode 11. Hardware addons in use: `FitAddon`, `WebLinksAddon`, `Unicode11Addon`.

**Per-node tab strips.** Each node has its own set of tabs. Switching the selected node in the left list swaps to that node's tabs in the middle column. The graph view's "Open terminal" action on a node creates a new session and switches to the workspace view in one step.

**Sessions persist across node switches.** Every live session — across every node — stays mounted in the React tree with `display:none` on the inactive ones. Switching nodes does not tear down the PTY or lose the xterm scrollback. A previous version did dispose the pane on switch; the comment in `TerminalTabs.tsx` documents that failure mode if you're curious.

**Spawn semantics.** A new tab calls `pty_spawn(sessionId, cwd, command, cols, rows)` in the Rust backend. The `cwd` defaults to the focused node's local mirror folder — so the moment you open a terminal in a project node, you're already `cd`'d into the right workspace. `command` is taken from the agent-command preset (see Settings below); pass an empty command for a plain shell.

**No automatic first prompt.** A spawned terminal starts empty and ready — the app does not send an orientation message to the agent. Everything an orientation round used to fetch (context summary, responsibilities, recent events, a handoff pointer for resumed work) is written into `PORTUNI_SCOPE.md` in the mirror instead, so the agent reads it on its own the moment it starts. Your first message to the agent is your actual task. "Copy launch command" on a node's detail pane copies exactly your agent-command preset (see Settings below), `cd`'d into that node's mirror.

**Activity indicator.** Each tab tracks `lastOutputAt`; the activity dot stays lit for a few seconds after every byte the PTY emits. Useful when you have several long-running agents in background tabs.

**Closing a tab.** The `X` on the tab calls `pty_kill` and removes the session. The PTY does not survive a quit of the app.

**Browser-mode fallback.** If you run `app/` directly via `vite` outside Tauri (for UI work on the codebase), the terminal pane renders a placeholder explaining that embedded terminals require the desktop app — the rest of the UI still works.

## Detail pane interactions

The detail pane on the right is editable in both Graph and Workspace views:

- **Edit fields** — name, description and goal have their own `Pencil` toggle and commit on `Save`; lifecycle state and owner save immediately on selection.
- **Sharing (Sdílení)** — the visibility selector (Všichni / Soukromé / Skupina). A node that inherits a group ACL from its organization (or nearest restricted ancestor) shows a single read-only summary ("Přebírá sdílení z ...", the effective mode, the inherited recipients) with one action, "Nastavit vlastní sdílení pro tento uzel"; that opens a card prefilled from the inherited list, and nothing is sent to the server until "Uložit" ("Zrušit" discards it). Once a node has its own list — its own override, or a group set directly on a node with no restricted ancestor — the same card autosaves every change immediately, with a brief "Uloženo" readout, plus a "Zrušit vlastní sdílení a přebírat z organizace" action to drop the override. The two destructive cases — switching away from a group with existing grants, or removing its last recipient — ask for an inline confirmation first. A group with no recipients yet is the only unsaved autosave state; it persists once the first recipient is added.
- **Responsibilities** — add, edit, reorder (drag), delete; assign actors per row.
- **Data sources & tools** — add/remove with name + optional URL.
- **Edges** — outgoing and incoming, with a `→` / `←` indicator. Click an edge target to navigate to it (updates `?node=`).
- **Files** — list of tracked files with `remote_path` and the derived `local_path` for this device, plus a sync button (central mode only — a local workspace has no remote at all, see [Data Modes](/concepts/data-modes/)) that mounts as soon as the node has a mirror, even with nothing tracked yet. It's never disabled: with something to push/pull it reads "Synchronizovat (N…)"; once nothing is locally pending it reads "Zkontrolovat remote" instead of claiming the node is done — a run's remote sweep is the only way to notice a file that showed up on Drive out of band, so a freshly created, still-empty mirror needs the same button as a busy one. Open in Finder, copy path, or delete (confirm-first). Text files open in the editor, `.md` and `.html` in a rendered preview. A `.showtime` deck (a [Showtime](https://github.com/honzapav/showtime) bundle) opens as the rendered preview the bundle carries once the Showtime integration is on (Settings → Integrace); the preview is read-only and offers „Otevřít v Showtime" when Showtime.app is installed. That button hands Showtime the deck **and** the node: the agent Showtime starts beside the deck connects to the Portuni MCP server with this node as its home (so it appears under the node's Relace like a terminal spawned from Portuni) and gets the node's mirror as a second working directory. The bearer never travels in the link; Portuni mints a one-time code and Showtime exchanges it over loopback. A refused handoff shows its reason in the preview bar and opens nothing; a Showtime without the `showtime://` deep link asks you to update Showtime. A bundle saved by a Showtime older than the bundled preview says so instead of rendering.
- **Events** — recent timeline; resolve / supersede inline.
- **Relace (Sessions)** — persistent sessions anchored to this node (`GET /nodes/:id/sessions`), newest-active first: state (running/suspended/closed/archived, archived hidden behind a "Zobrazit archivované" filter), last activity, CLI + instance (CLI is read from the MCP handshake itself, not a header — populated for Claude Code, Codex and Mistral Vibe alike), the task `brief` and `runner` when the session was started as a task, `waiting_since` when its run is blocked on a question, and write count (size of the session's write scope, which always includes the session's own home node — a session that only ever wrote there still reports 1, not 0). Name defaults to `<node> · <date> <time>` (the time component keeps two same-day sessions on the same node distinguishable) and is enriched from the handoff's title at suspend, but is always renamable inline. A `sessions` row is only ever created once a connection completes its MCP handshake — a client's protocol probe, an aborted connection, or any other non-`initialize` first request never leaves a row behind. A `running` row is never simply dropped: a dropped MCP connection, the transport's own 30-minute idle GC, the desktop terminal that spawned its CLI exiting (Claude Code only, via the correlated terminal id), or a startup sweep finding a row from a process that no longer exists (crash, restart) all *suspend* it instead, with a minimal handoff the server writes itself — `closed` is reached only by explicitly clicking Uzavřít or by the auto-archive sweep of old closed sessions. Such a row shows "pozastaveno serverem" with the reason (odpojení, nečinnost, ukončení terminálu, restart serveru, or agent nestihl předání when a runner-driven Pozastavit timed out) so it reads differently from a handoff the agent wrote on purpose. A suspended row shows whether the underlying CLI conversation is still resumable or will fall back to the handoff, and links to the handoff file when one exists (or, when this device has no local mirror for the node, the handoff text is still resumable from — it was simply never written to a file here). Resuming re-attaches the same durable session record (not a new one) and reauthorizes the resume id server-side (must be owned by you, anchored to this node, and still suspended — otherwise it's refused); handoff-change detection only works from a device that has a local mirror for this node, so a device with none shows neither "changed" nor "unchanged", just that it can't be checked from here. A `running` row whose terminal is a live, agent-launched tab in this window also offers "Pozastavit": it asks the agent to save a handoff and stop, waits up to 30s, then closes that terminal either way — the same mechanism the window-close dialog's own Pozastavit uses.

Every mutating action calls back through `onMutate` which refetches the graph and the node detail, so the rest of the UI stays consistent.

### Task API (server-side; no chat UI yet)

A session can now be started as a task directly over REST, ahead of the
web chat UI that will replace the embedded terminal: `POST /sessions`
(`{ node_id, brief, runner, instance_id?, policy? }`) creates the session
and starts its first run. From there: `POST /sessions/:id/messages`
(send a chat message), `POST /sessions/:id/questions/:request_id`
(answer an open question), `POST /sessions/:id/interrupt`,
`POST /sessions/:id/suspend` (waits up to 30s for the agent's own handoff
before the server writes one), `POST /sessions/:id/resume`
(`{ mode: "conversation" | "handoff" }`), `POST /sessions/:id/close`, and
`GET /sessions/:id/events?after&limit` for the canonical event log a
future chat view renders from.

Who may call what follows one access table across every task route: **read**
(`GET /sessions/:id/events`) is anyone who can see the session's anchor
node; **message** (send a message, answer a question, rename) and
**resume** are the owner only; **stop** (interrupt/suspend/close) is the
owner or anyone with `manage` scope. A session anchored to a node you
cannot see reads as a plain 404, same as the node itself being invisible;
a node-less session (a plain interactive chat, not a task) is 404 for
everyone but the owner. An interrupt/suspend/close by someone other than
the owner is recorded in the event log with who did it.

A task's own MCP connection (the one the runner spawns to talk back to
Portuni) binds to the session `POST /sessions` already created instead of
minting a second row — this is why a task's Relace row appears the moment
you start it, not only once its first tool call lands.

### Live channel: `GET /sessions/ws`

The REST task routes above are for scripts and tests; the desktop window
itself talks to one WebSocket, `GET /sessions/ws` (upgrade, same bearer/
JWT auth as every other route — an upgrade that fails auth is refused with
401 and the socket is closed; a plain `GET` without an `Upgrade` header
answers 426). Every frame is JSON `{ id?, type, payload }`; a frame
carrying `id` gets `{ id, type: "reply", payload }` on success or
`{ id, type: "error", payload: { code, message } }` on failure — the same
codes the REST routes answer with (`SESSION_FORBIDDEN`,
`SESSION_NOT_FOUND`, `NO_LIVE_RUN`, `NO_PENDING_QUESTION`, …). A refused
action is always an error frame, never a closed socket.

Client → server: `subscribe { session_id, after }` (replays the persisted
event log after `after`, then streams live), `unsubscribe { session_id }`,
`message { session_id, text }`, `answer { session_id, request_id, decision }`,
`interrupt | suspend | close { session_id }` — each mapped to the same
runtime call and access tier the REST route uses.

Server → client: `event { session_id, event }` — a persisted canonical
event, carrying the `seq` the store assigned it; `delta { session_id,
run_id, text }` — streamed text, never persisted, never replayed; and
`session_state { session_id, state, waiting_since, node_id }` — sent for
every session you can see the moment you connect, and again on every
`state_changed`, `question` or `run_ended` anywhere, with no subscription
needed. This is what lets the Relace tab, the Práce sidebar and Přehled
update live instead of polling.

Reconnect rule: a client that drops and reconnects re-subscribes to each
session it cares about with the last `seq` it actually saw — nothing is
lost, because events are the durable record and deltas were always
disposable.

## Settings

Sections worth highlighting:

- **Theme** — light / dark; the choice persists in `localStorage` and is reapplied on launch.
- **Agent command preset** — pick which CLI agent your "Copy launch command" / new-terminal default uses. Built-in presets: Claude Code (`claude`), Codex CLI (`codex`), Gemini CLI (`gemini`), Cursor Agent (`cursor-agent`), OpenCode (`opencode`), Mistral Vibe (`vibe --trust`). You can also type a custom command — it runs unmodified, `cd`'d into the node's mirror. (The Vibe preset passes `--trust` so it loads the mirror's project config and auto-seeds scope — see [Mistral Vibe](/clients/mistral-vibe/).)
- **MCP server** — shows the sidecar's URL (typically `http://localhost:4011/mcp`), port, and whether an auth token is set. The bearer token itself lives in macOS Keychain (Tauri-only); reveal it on demand or rotate with one click. The install buttons write the URL + token into `~/.claude.json`, `~/.codex/config.toml`, and `~/.vibe/config.toml` so external clients can talk to the app's sidecar without manual config editing.
- **Synchronizace** — informational. See below.
- **Integrace → Showtime** — off by default, stored in `localStorage` like the other settings. On, a `.showtime` deck in a node's files opens as a rendered preview (the `preview.html` Showtime packs into the bundle at every save; `GET /nodes/:id/file` returns that entry as `text/html` for a `.showtime` path) and the preview offers „Otevřít v Showtime" when Showtime.app is installed — the section shows whether Showtime.app was found (`/Applications` or `~/Applications`) and what the button hands over: the node's Portuni connection for the agent and the node's mirror as a working directory. Off, the bundle is a binary file like any other.

## Synchronizace

Collaboration in Portuni is central mode — a **local** (single-machine)
workspace has no remote to connect at all, so Settings → Synchronizace has
nothing to configure there: stored files always sit in the local mirror
only, and a node's Soubory pane shows a "soubory se ukládají jen lokálně"
banner. A **central** workspace shows the server URL that manages file sync
— nothing to configure client-side either. Configuring the actual Google
Drive remote (a Service Account on the central server) is an MCP-only,
one-time admin task; see [Setting Up Remotes](/guides/setting-up-remotes/).

## Recommended daily flow

1. Open `Portuni.app`. Workspace view.
2. Pick the node you're working on from the left list (or jump from the graph view).
3. `+` to spawn a fresh terminal tab. The PTY starts in the node's mirror folder.
4. Either type a shell command, or use the detail pane's "Copy launch command" to spawn the configured agent — the terminal starts empty, ready for your first message.
5. Work. The agent uses Portuni MCP tools (`get_node`, `get_context`, `log`, `store`, etc.) via the embedded sidecar — same surface external clients see.
6. When done, `portuni_status` (or rely on the agent to call it) before ending the session so disk / DB / remote stay consistent — this rule is enforced by the server-level instructions.

## See also

- [Desktop App](/clients/desktop-app/) — install, first run, update flow
- [Symbiotic Workflows](/guides/symbiotic-workflows/) — how the agent and the human share the graph
- [Local Mirrors](/concepts/mirrors/) — the per-device mirror model the workspace view surfaces
