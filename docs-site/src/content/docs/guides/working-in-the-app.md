---
title: Working in the Desktop App
description: Daily-driver workflows in Portuni.app — graph navigation, the workspace layout, embedded terminals, and the settings surface.
---

This guide covers what you actually do in `Portuni.app` once it's installed. For installation and first-run setup, see [Desktop App](/clients/desktop-app/).

The app has three views, switched from the left sidebar:

- **Graph** — the Cytoscape force-directed visualisation. Default landing view.
- **Workspace** — the three-column layout with a node list, terminal tabs, and a detail pane. Where most daily work happens.
- **Settings** — Turso credentials, theme, agent-command preset, MCP server section, and actors management.

The currently selected node lives in the URL as `?node=<id>`, so deep-linking and copy-pasted URLs work across views.

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

**Agent prompt builder.** From a node's detail pane (`Pencil` icon → "Copy launch command") the app builds an agent-ready prompt: it tells the agent to call `portuni_get_node` first to refresh state, then attaches a snapshot of the node (description, status, edges, recent events, files) as orientation context. The launch command is your preset template (`claude {prompt}`, `codex {prompt}`, etc.) with `{prompt}` substituted. You can paste this into any of your tabs or have the app spawn a tab pre-loaded with it.

**Activity indicator.** Each tab tracks `lastOutputAt`; the activity dot stays lit for a few seconds after every byte the PTY emits. Useful when you have several long-running agents in background tabs.

**Closing a tab.** The `X` on the tab calls `pty_kill` and removes the session. The PTY does not survive a quit of the app.

**Browser-mode fallback.** If you run `app/` directly via `vite` outside Tauri (for UI work on the codebase), the terminal pane renders a placeholder explaining that embedded terminals require the desktop app — the rest of the UI still works.

## Detail pane interactions

The detail pane on the right is editable in both Graph and Workspace views:

- **Edit fields** — name, description, goal, lifecycle state, owner, visibility. Each field has its own `Pencil` toggle; changes commit on `Save`.
- **Responsibilities** — add, edit, reorder (drag), delete; assign actors per row.
- **Data sources & tools** — add/remove with name + optional URL.
- **Edges** — outgoing and incoming, with a `→` / `←` indicator. Click an edge target to navigate to it (updates `?node=`).
- **Files** — list of tracked files with `remote_path` and the derived `local_path` for this device. Open in Finder, copy path, or delete (confirm-first).
- **Events** — recent timeline; resolve / supersede inline.

Every mutating action calls back through `onMutate` which refetches the graph and the node detail, so the rest of the UI stays consistent.

## Settings

Three sections worth highlighting:

- **Theme** — light / dark; the choice persists in `localStorage` and is reapplied on launch.
- **Agent command preset** — pick which CLI agent your "Copy launch command" / new-terminal default uses. Built-in presets: Claude Code (`claude {prompt}`), Codex CLI (`codex {prompt}`), Gemini CLI (`gemini -p {prompt}`), Cursor Agent (`cursor-agent {prompt}`), OpenCode (`opencode run {prompt}`), Mistral Vibe (`vibe --trust {prompt}`). You can also type a custom template; `{prompt}` is the placeholder for the shell-escaped prompt. (The Vibe preset passes `--trust` so it loads the mirror's project config and auto-seeds scope — see [Mistral Vibe](/clients/mistral-vibe/).)
- **MCP server** — shows the sidecar's URL (typically `http://localhost:4011/mcp`), port, and whether an auth token is set. The bearer token itself lives in macOS Keychain (Tauri-only); reveal it on demand or rotate with one click. The install buttons write the URL + token into `~/.claude.json`, `~/.codex/config.toml`, and `~/.vibe/config.toml` so external clients can talk to the app's sidecar without manual config editing.

## Recommended daily flow

1. Open `Portuni.app`. Workspace view.
2. Pick the node you're working on from the left list (or jump from the graph view).
3. `+` to spawn a fresh terminal tab. The PTY starts in the node's mirror folder.
4. Either type a shell command, or use the detail pane's "Copy launch command" to spawn the configured agent with the node's orientation prompt.
5. Work. The agent uses Portuni MCP tools (`get_node`, `get_context`, `log`, `store`, etc.) via the embedded sidecar — same surface external clients see.
6. When done, `portuni_status` (or rely on the agent to call it) before ending the session so disk / DB / remote stay consistent — this rule is enforced by the server-level instructions.

## See also

- [Desktop App](/clients/desktop-app/) — install, first run, update flow
- [Symbiotic Workflows](/guides/symbiotic-workflows/) — how the agent and the human share the graph
- [Local Mirrors](/concepts/mirrors/) — the per-device mirror model the workspace view surfaces
