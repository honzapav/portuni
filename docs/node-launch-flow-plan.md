# Node launch flow – plan

Self-contained spec for the next round of UX work on the desktop app.
Written so a fresh Claude/Codex session can execute it without re-doing
the conversation that produced it.

## Status (as of 2026-05-06)

Not started. This document is the scope agreement.

## Why this exists

Onboarding a fresh user is broken. Looking at it from someone who just
installed `Portuni.app` and opened it for the first time:

1. Wizard asks for Turso URL + auth token, or "start locally". User picks.
2. Sidecar boots. Graph loads. **Empty.**
3. There is no call to action. No "+ create your first organisation",
   no tutorial, nothing pointing at MCP. The window is dead.
4. To produce any node the user must:
   a. Know that Portuni exposes an MCP server.
   b. Have Claude Code installed.
   c. Open Claude Code in the right cwd.
   d. Ask Claude to call `portuni_create_node`.
   e. Come back to Portuni — and discover **the graph still does not
      refresh** because `App.tsx` only fetches on mount.
5. To then *work* on a node (write files, run code), the user has to:
   a. Find the right org folder under `PORTUNI_ROOT`.
   b. Find the right type folder (`projects/`, `processes/`, …).
   c. Run `portuni_mirror` (only available as MCP tool, no CLI binary).
   d. `cd` into the freshly minted directory.
   e. Launch `claude`.

Today the app behaves as a **read-only viewer** of a graph that some
other tool is supposed to produce. But "the other tool" is the same
human, and the app does not lead them there. The structural rot:

- **Node existence in the database** and **node existence as a working
  directory** are two different worlds, and the UI does not reflect the
  difference.
- "Copy launch command" in `DetailPane.files.tsx:471` silently degrades
  to a useless `claude {prompt}` (no `cd`) when the node has no mirror
  — see `app/src/lib/prompt.ts:107-110`.
- The mirror operation is MCP-only. There is no REST endpoint, no CLI
  binary, no UI. The app cannot create a working directory for a node
  it knows about.
- Empty state is a blank canvas with zero guidance.

## Goal

After this work, a brand-new user launches `Portuni.app` and:

1. Completes the Turso/local wizard.
2. Sees an **empty-state graph with a single CTA**: "Vytvoř první
   organizaci".
3. Clicks it, fills a small form (parent / type / name), submits — node
   appears in the graph, selected.
4. In the detail pane sees one button: **"Spustit Claude"**.
5. Clicks it. Mirror is created on the fly if missing, an external
   terminal (Phase 2) or an embedded xterm pane (Phase 3) opens *inside*
   the right directory with `claude` already running and the Portuni
   prompt fed in.
6. Comes back to the app the next day — graph auto-refreshes on window
   focus, so anything Claude wrote is reflected without a manual reload.

No CLI required for the happy path. MCP/CLI remains as the power-user
surface.

## Non-goals

- Replacing MCP / CLI tooling. Both stay.
- Onboarding tour / coach marks. Empty-state CTA is enough; coach marks
  come later if needed.
- Linux/Windows external-terminal launch. Phase 2 is macOS-only on
  purpose; Phase 3 solves cross-platform structurally.
- Persistent terminal sessions across app restarts (Phase 3 nice-to-have).

## Phase 1 — Plumbing + UX skeleton

Cross-platform. One commit. ~1 day.

### 1.1 REST mirror endpoint

`POST /api/nodes/:id/mirror` in `src/api/nodes.ts`. Wraps the same
domain function the MCP tool `portuni_mirror` calls. Idempotent —
existing mirror returns 200 with current path; missing mirror creates
folder structure (`wip/`, `outputs/`, `resources/`), registers in
`sync.db`, kicks off best-effort remote scaffolding, returns 201 with
`local_path` + `remote_url` if available.

Response shape:
```json
{ "node_id": "...", "local_path": "/abs/path", "remote_url": "...", "created": true }
```

### 1.2 Window-focus refresh

In `app/src/App.tsx`: `useEffect` with `window.addEventListener("focus",
refetchAll)`. Five-line change. Solves the "I created a node via MCP and
the app never sees it" symptom universally.

Edge case: if the app is already focused on initial load, the existing
mount-time fetch covers it.

### 1.3 "+ Nová node" button + modal

In `app/src/components/Sidebar.tsx`, button always visible at the top.
Opens a modal with:

- **Parent** — typeahead over existing nodes, optional. Empty parent =
  top-level (must be `organisation` type).
- **Type** — select from the POPP enum (resource:
  `portuni://enums`).
- **Name** — required, min 2 chars.
- **Description** — optional, multi-line.

Submit calls `POST /api/nodes` (already exists at `src/api/nodes.ts:173`).
On success: close modal, set `selectedId` to new node, `refetchAll()`.

Validation rules to mirror what `createNodeInternal` does so we fail in
the form instead of the server when possible.

### 1.4 Empty state

In `app/src/components/GraphView.tsx` (or wherever the graph canvas is
mounted): when `graph.nodes.length === 0`, render a centered card:

> **Začni vytvořením první organizace.**
> Portuni mapuje, na čem pracuješ — týmy, projekty, procesy. Začni tím,
> že přidáš svou organizaci.
>
> [+ Vytvořit organizaci]

Button opens the same modal as 1.3 with type pre-set to `organisation`
and parent disabled.

### 1.5 Visual mirror state

In `app/src/components/DetailPane.tsx` near `PathCopy` (line ~501):
- If `node.local_mirror` exists: green dot + path (current behaviour).
- If not: muted placeholder "Pracovní složka zatím neexistuje — bude
  vytvořena při spuštění Claude."

No new state, just conditional rendering.

## Phase 2 — Launch with external terminal (macOS first)

~½ day. Separate commit. macOS-only with graceful fallback for other OS.

### 2.1 New Tauri command `launch_claude_for_node`

In `src-tauri/src/lib.rs` (or wherever Tauri commands live), arg:
`node_id`. Steps:

1. HTTP call to local sidecar `POST /api/nodes/:id/mirror` (creates if
   missing, returns `local_path`).
2. HTTP call to `GET /api/nodes/:id` to get fresh `NodeDetail`.
3. Build the launch command via the existing `buildAgentCommand` logic
   (lift to shared place — TS in app, but for Rust we duplicate the
   small piece, or expose it as a sidecar endpoint
   `GET /api/nodes/:id/launch-command`). **Decision:** add a sidecar
   endpoint so Rust does not re-implement prompt generation. Endpoint
   returns:
   ```json
   { "cwd": "/abs/path", "command": "claude '...'" }
   ```
4. On macOS — invoke `osascript`:
   ```sh
   osascript -e 'tell application "Terminal" to activate' \
             -e 'tell application "Terminal" to do script "cd <cwd> && <command>"'
   ```
5. On other OS — return a structured error to the frontend so it can
   fall back to clipboard copy + toast "Otevři terminál a paste".

### 2.2 "Spustit Claude" button in DetailPane

Replaces "Copy launch command" in `app/src/components/DetailPane.files.tsx`.

- Tauri build: button calls `invoke("launch_claude_for_node", { nodeId })`.
  Disabled while pending. On success: toast "Spuštěno v Terminal.app".
  On not-supported error from Tauri: copy to clipboard, toast
  "Zkopírováno — paste do svého terminálu".
- Vite/browser dev: copy-to-clipboard fallback (current behaviour).

### 2.3 Decisions captured

- macOS uses Terminal.app, not iTerm2. iTerm support is a one-line
  variant later if anyone asks. Don't probe for iTerm — too brittle.
- Don't minimise / hide Portuni after launch. User keeps graph visible
  while working.
- No "Open in Finder" button right now (out of scope).

## Phase 3 — Embedded terminal (cross-platform, real solution)

~2–3 days. Separate branch, ships when stable.

### 3.1 Pty bridge in Rust

Add `portable-pty` crate. Tauri commands:
- `pty_spawn({ cwd, command }) -> session_id`
- `pty_write({ session_id, data })`
- `pty_resize({ session_id, cols, rows })`
- `pty_kill({ session_id })`

Plus an event channel `pty-data` (per-session payload) emitted from a
background reader task.

### 3.2 Xterm.js component

Add deps: `xterm`, `xterm-addon-fit`, `xterm-addon-web-links`. New
component `app/src/components/TerminalPane.tsx`:

- Props: `nodeId`, `cwd`, `command`.
- Lifecycle: on mount → `pty_spawn` → wire xterm `onData` to
  `pty_write` → wire Tauri event `pty-data` to `xterm.write`.
- On unmount → `pty_kill`.
- Resize observer wired to `pty_resize`.

### 3.3 Integration in DetailPane

Behind a feature toggle initially. "Spustit Claude" docks a `TerminalPane`
at the bottom of the detail pane (resizable split). Replaces external
launch on Tauri builds when enabled. Still falls back to clipboard in
browser.

### 3.4 Per-node session lifecycle

- One pty per node, kept alive while the node is selected.
- Switching to another node → keep prior session in the background
  (tabs across the bottom for active terminals).
- Closing app → kill all sessions on Rust side (graceful).
- Persistent sessions across app restarts: explicitly out of scope.

### 3.5 Cross-platform cost

`portable-pty` covers macOS, Linux, Windows from one API. Xterm.js is
JS, OS-agnostic. The only extra work is **CI** — building the sidecar
and Tauri bundle for Win/Linux. That is a build-pipeline change, not a
code change in this plan.

## Cross-platform notes

| Concern | macOS | Linux | Windows |
|---|---|---|---|
| Phase 1 (REST + UI) | works | works | works |
| Phase 2 (external terminal) | osascript Terminal.app | falls back to clipboard copy | falls back to clipboard copy |
| Phase 3 (embedded xterm) | works via portable-pty | works | works |
| Sidecar bundling | already done | needs CI work | needs CI work |
| Claude Code invocation | user installs locally | user installs locally | user installs locally |

If at some point we want native external-terminal launch on Linux/Windows
without going to Phase 3, the cost is ~3–4 hours: detect terminal via
`$TERMINAL` env / `xdg-mime` / `wt.exe`, special-case Windows `cmd /d`
syntax, ~50–100 lines in `src-tauri`. Skip until requested.

## File map

Files this plan touches, in implementation order:

**Phase 1**
- `src/api/nodes.ts` — add `POST /api/nodes/:id/mirror` route
- `src/api/router.ts` — register route
- `src/domain/sync/...` — extract or reuse mirror domain function (look
  at how `src/mcp/tools/mirrors.ts` calls it; no new domain code if
  possible)
- `app/src/api.ts` — add client `createMirror(nodeId)`
- `app/src/App.tsx` — focus listener; pass create-node callback to
  Sidebar / GraphView empty state
- `app/src/components/Sidebar.tsx` — "+ Nová node" button + modal
- `app/src/components/GraphView.tsx` — empty-state CTA
- `app/src/components/DetailPane.tsx` — visual mirror state near
  `PathCopy`
- `test/` — unit test for the new REST endpoint

**Phase 2**
- `src/api/nodes.ts` — `GET /api/nodes/:id/launch-command`
- `src-tauri/src/lib.rs` (or appropriate) — `launch_claude_for_node`
  command, gated on `cfg(target_os = "macos")`
- `src-tauri/Cargo.toml` — no new deps (uses std `Command`)
- `app/src/components/DetailPane.files.tsx` — replace "Copy launch
  command" with "Spustit Claude" + clipboard fallback
- `app/src/lib/prompt.ts` — keep for browser fallback

**Phase 3**
- `src-tauri/Cargo.toml` — add `portable-pty`
- `src-tauri/src/pty.rs` — new module
- `src-tauri/src/lib.rs` — wire commands + event channel
- `app/package.json` — add xterm + addons
- `app/src/components/TerminalPane.tsx` — new
- `app/src/components/DetailPane.tsx` — embed `TerminalPane`

## Open questions

1. **Top-level org creation.** When the modal in Phase 1.3 has empty
   parent and type=`organisation`, what scope does the resulting node
   live under? Need to confirm with `portuni://scope-rules` whether the
   solo-user device implicitly owns top-level org creation, or whether
   we need an explicit "workspace" picker.
2. **`buildAgentCommand` ownership.** Currently TS-only in
   `app/src/lib/prompt.ts`. Phase 2 needs Rust or sidecar access. The
   plan picks "expose via sidecar endpoint"; alternative is to keep
   command building entirely in the webview and have Rust just receive
   a ready string. The latter is simpler — adopt unless there's a reason
   to centralise.
3. **Conflict with existing `agentCommand` setting.** The Settings page
   lets users customise the launch template. Phase 2 must respect it.
   Already covered by exposing the same `buildAgentCommand` logic, but
   noting it so a future executor doesn't hardcode `claude {prompt}`.

## Out of scope (deferred)

- Onboarding tour after first node creation.
- "Open in Finder" / "Reveal in Explorer" buttons.
- iTerm2 / Alacritty / Wezterm preference picker.
- Editor integrations (open mirror in VS Code from the app).
- Multi-user / per-user routing (current solo-user assumption holds).
- Drag-and-drop node creation in the graph.
