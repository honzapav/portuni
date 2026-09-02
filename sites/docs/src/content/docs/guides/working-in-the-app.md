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
- **Files** — list of tracked files with `remote_path` and the derived `local_path` for this device. Open in Finder, copy path, or delete (confirm-first).
- **Events** — recent timeline; resolve / supersede inline.
- **Relace (Sessions)** — persistent sessions anchored to this node (`GET /nodes/:id/sessions`), newest-active first: state (running/suspended/closed/archived, archived hidden behind a "Zobrazit archivované" filter), last activity, CLI + profile, and write count (size of the session's write scope). Name defaults to `<node> · <date>` and is enriched from the handoff's title at suspend, but is always renamable inline. A suspended row shows whether the underlying CLI conversation is still resumable or will fall back to the handoff, and links to the handoff file when one exists. Resuming re-attaches the same durable session record (not a new one) and reauthorizes the resume id server-side (must be owned by you, anchored to this node, and still suspended — otherwise it's refused); handoff-change detection only works from a device that has a local mirror for this node, so a device with none shows neither "changed" nor "unchanged", just that it can't be checked from here. A `running` row moves to `closed` as soon as the desktop terminal that spawned its CLI exits (Claude Code only, via the correlated terminal id), not just after the 30-minute idle GC — the fallback that still covers Codex/Vibe and a crashed CLI. A `running` row whose terminal is a live, agent-launched tab in this window also offers "Pozastavit": it asks the agent to save a handoff and stop, waits up to 30s, then closes that terminal either way — the same mechanism the window-close dialog's own Pozastavit uses.

Every mutating action calls back through `onMutate` which refetches the graph and the node detail, so the rest of the UI stays consistent.

## Settings

Sections worth highlighting:

- **Theme** — light / dark; the choice persists in `localStorage` and is reapplied on launch.
- **Agent command preset** — pick which CLI agent your "Copy launch command" / new-terminal default uses. Built-in presets: Claude Code (`claude`), Codex CLI (`codex`), Gemini CLI (`gemini`), Cursor Agent (`cursor-agent`), OpenCode (`opencode`), Mistral Vibe (`vibe --trust`). You can also type a custom command — it runs unmodified, `cd`'d into the node's mirror. (The Vibe preset passes `--trust` so it loads the mirror's project config and auto-seeds scope — see [Mistral Vibe](/clients/mistral-vibe/).)
- **MCP server** — shows the sidecar's URL (typically `http://localhost:4011/mcp`), port, and whether an auth token is set. The bearer token itself lives in macOS Keychain (Tauri-only); reveal it on demand or rotate with one click. The install buttons write the URL + token into `~/.claude.json`, `~/.codex/config.toml`, and `~/.vibe/config.toml` so external clients can talk to the app's sidecar without manual config editing.
- **Synchronizace** — connect Google Drive so stored files leave the local mirror. See below.

## Synchronizace (Google Drive)

For a **local** workspace, Settings → Synchronizace is where you connect Google Drive:

1. **Propojit Google Drive** — a normal Google sign-in opens in your browser. The refresh token is handled entirely by the desktop shell and the local sidecar; it never reaches the web UI.
2. **Pick a target** — your My Drive (Portuni creates a `Portuni` folder) or any Shared Drive you can access.
3. **Otestovat připojení** confirms the target is reachable; **Odpojit** removes the connection (local files stay put).

Until a target is connected, stored files sit in the local mirror only — a node's Soubory pane shows a "soubory se ukládají jen lokálně" banner linking here. A **central** workspace shows nothing to configure: file sync is managed by the org's server. Under the hood this is per-user OAuth writing to a `gdrive` remote with a wildcard routing rule; the equivalent MCP setup for headless/server deployments is in [Setting Up Remotes](/guides/setting-up-remotes/).

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
