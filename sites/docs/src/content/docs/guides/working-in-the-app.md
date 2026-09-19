---
title: Working in the Desktop App
description: Daily-driver workflows in Portuni.app — graph navigation, the workspace layout, the task chat, and the settings surface.
---

This guide covers what you actually do in `Portuni.app` once it's installed. For installation and first-run setup, see [Desktop App](/clients/desktop-app/).

The app has four views, switched from the left sidebar:

- **Overview (Přehled)** — a read-only, workspace-wide dashboard. Default landing view.
- **Graph** — the Cytoscape force-directed visualisation.
- **Workspace (Práce)** — the node list on the left and, in the centre, the selected node's detail or its task chat. Where most daily work happens.
- **Settings** — workspaces, account, runners, sync, MCP server section, and actors management.

The currently selected node lives in the URL as `?node=<id>`, so deep-linking and copy-pasted URLs work across views.

## Overview (Přehled)

The default landing view: one aggregate, permission-filtered snapshot of the whole workspace (`GET /overview`), composed deterministically — no LLM involved. Four cards:

- **Relace** — your own inbox: running/suspended sessions you started, ordered "Čeká na mě" (an open question) first, then running, then suspended (`GET /overview` itself returns every session on a node you can see, workspace-wide; the card narrows that to yours — the team-wide view is a later, host-aware feature), plus a headless review queue: nodes a `headless` session reached only via search with no edge path (`session_scope.added_via = 'disconnected'`) — see [Scope Enforcement](/concepts/scope-enforcement/).
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

```
┌──────────────┬──────────────────────────────┬──────────────┐
│ Node list    │  Task chat                   │ Node detail  │
│ (300 px)     │  (the node's open session)   │ (collapsible)│
│              │                              │              │
│ Sessions     │  — or, with no session, the  │              │
│ under each   │    node detail centre-stage  │              │
│ node, [+]    │    and no right column       │              │
└──────────────┴──────────────────────────────┴──────────────┘
```

- **Sidebar header** (every tab) — the workspace switcher under the brand, the Přehled / Graf / Práce toggle, "Hledat uzel…" (also `⌘K` / `Ctrl+K`) opening a command palette that filters nodes by name, description and type, and "Nový uzel". The block is identical on every tab; in Graf a pick selects the node in the graph, in Práce it opens the node.
- **Node list** (left, "Otevřené") — two arrangements, switched by the Uzly | Stav toggle (remembered per workspace). **Uzly**: every open node in the order you opened them, with a node-type dot and at most one activity dot (waiting on an answer, running, or suspended, from live `session_state` frames); its task sessions (including an empty, just-opened draft) sit as sub-rows flush under the node name, the state in the tooltip — click one to jump straight to the chat, double-click to rename inline, and the `×` revealed on hover closes it (a draft is deleted outright; anything else asks first). Hovering a node itself shows `+` (opens a new, empty thread on that node — the same one-click action as the detail pane's "Nový úkol") and `×` (close the node — its sessions keep running on the sidecar). **Stav**: tasks only, grouped Vyžadují pozornost / Pracují / Pozastavené / Nové / Hotové, each with its node's name underneath.
- **Centre** — [the task chat](#task-chat-práce) when the selected node has an open (running/suspended/draft) session; otherwise the same `DetailPane` the graph view uses, in "embedded" mode.
- **Node detail** (right) — shown only while a chat occupies the centre, so the node stays visible next to its thread. The chevron at the top collapses it; the state persists in `localStorage` under `portuni:workspace.detailVisible`. A file opened from the Files tab replaces the detail with the editor in the same column.

Tasks run in the sidecar, not in this window: closing the window or the app never stops a run.

## Detail pane interactions

The detail pane on the right is editable in both Graph and Workspace views:

- **Identity row** (under the name) — the node id (click to copy) and, for every node but an organization, either the local mirror's path (left-truncated so the leaf folder stays readable, full path in the tooltip, click to copy) with a Finder button next to it, or — when this device has no mirror for the node yet — a button to create one. A remote-folder action follows either way: a Google Drive icon (or a generic link icon for a non-Drive remote) to copy its sharing link, plus a button to open it. There is no lifecycle/status badge here any more; project health still shows in its own place (see [Lifecycle States](/concepts/lifecycle-states/#project-health)).
- **Edit fields** — name, description and goal have their own `Pencil` toggle and commit on `Save`; lifecycle state and owner save immediately on selection.
- **Sharing (Sdílení)** — the visibility selector (Všichni / Soukromé / Skupina). A node that inherits a group ACL from its organization (or nearest restricted ancestor) shows a single read-only summary ("Přebírá sdílení z ...", the effective mode, the inherited recipients) with one action, "Nastavit vlastní sdílení pro tento uzel"; that opens a card prefilled from the inherited list, and nothing is sent to the server until "Uložit" ("Zrušit" discards it). Once a node has its own list — its own override, or a group set directly on a node with no restricted ancestor — the same card autosaves every change immediately, with a brief "Uloženo" readout, plus a "Zrušit vlastní sdílení a přebírat z organizace" action to drop the override. The two destructive cases — switching away from a group with existing grants, or removing its last recipient — ask for an inline confirmation first. A group with no recipients yet is the only unsaved autosave state; it persists once the first recipient is added.
- **Responsibilities** — add, edit, reorder (drag), delete; assign actors per row.
- **Data sources & tools** — add/remove with name + optional URL.
- **Edges** — outgoing and incoming, with a `→` / `←` indicator. Click an edge target to navigate to it (updates `?node=`).
- **Files** — list of tracked files with `remote_path` and the derived `local_path` for this device, plus a sync button (central mode only — a local workspace has no remote at all, see [Data Modes](/concepts/data-modes/)) that mounts as soon as the node has a mirror, even with nothing tracked yet. It's never disabled: with something to push/pull it reads "Synchronizovat (N…)"; once nothing is locally pending it reads "Zkontrolovat remote" instead of claiming the node is done — a run's remote sweep is the only way to notice a file that showed up on Drive out of band, so a freshly created, still-empty mirror needs the same button as a busy one. Open in Finder, copy path, or delete (confirm-first). Opening a file swaps the editor into this same right column in place of the node detail — a "← zpět" button returns to it. Every file but a Showtime deck offers a Náhled | Editace toggle: Markdown and HTML open in Náhled (rendered preview) by default, anything else opens in Editace (source editor); switch either way any time. "Uložit" (Cmd/Ctrl+S) shows up only in Editace, and only once the file is dirty, sitting left of the toggle so its appearing/disappearing never shifts the other buttons. A ⤢ next to it expands the editor to a fullscreen overlay with the same controls (mode toggle, Uložit, plus ⤡ to collapse back and × to close). A `.showtime` deck (a [Showtime](https://github.com/honzapav/showtime) bundle) opens as the rendered preview the bundle carries once the Showtime integration is on (Settings → Integrace); the preview is read-only and offers „Otevřít v Showtime" when Showtime.app is installed. That button hands Showtime the deck **and** the node: the agent Showtime starts beside the deck connects to the Portuni MCP server with this node as its home (so it appears under the node's Relace like a task started from Portuni) and gets the node's mirror as a second working directory. The bearer never travels in the link; Portuni mints a one-time code and Showtime exchanges it over loopback. A refused handoff shows its reason in the preview bar and opens nothing; a Showtime without the `showtime://` deep link asks you to update Showtime. With the integration on and Showtime.app found, „+ Nový soubor" is a split button: the chevron offers „Nový soubor" and „Nová prezentace". The latter hands Showtime the node's `wip/` and a one-time code (`showtime://new`); Showtime's New Deck screen opens with that folder fixed and the node named, you pick the design system, template and name there, and the bundle it writes shows up under Files through the mirror watcher — the agent beside it is a session on this node, as for „Otevřít v Showtime". Disabled (with the reason) on a node without a mirror on this device: Showtime writes to disk, so there is nowhere to put the deck. Which agent runs beside the deck is Showtime's own setting, not Portuni's agent preset. A bundle saved by a Showtime older than the bundled preview says so instead of rendering.
- **Events** — recent timeline; resolve / supersede inline.
- **Relace (Sessions)** — persistent sessions anchored to this node (`GET /nodes/:id/sessions`), newest-active first: state (running/suspended/closed/archived, archived hidden behind a "Zobrazit archivované" filter), last activity, CLI + instance (CLI is read from the MCP handshake itself, not a header — populated for Claude Code, Codex and Mistral Vibe alike), the task `brief` and `runner` when the session was started as a task, `waiting_since` when its run is blocked on a question, and write count (size of the session's write scope, which always includes the session's own home node — a session that only ever wrote there still reports 1, not 0). Name defaults to `<node> · <date> <time>` (the time component keeps two same-day sessions on the same node distinguishable) and is enriched from the handoff's title at suspend, but is always renamable inline. A `sessions` row is only ever created once a connection completes its MCP handshake — a client's protocol probe, an aborted connection, or any other non-`initialize` first request never leaves a row behind. A `running` row is never simply dropped: a run that ends for any reason other than Uzavřít — a dropped MCP connection, `PORTUNI_RUN_IDLE_MS` (default 30 min) of inactivity, a provider limit (the runner's own spend/rate limit, whose message lands in the transcript as a provider error), an error, or a startup sweep finding a row from a process that no longer exists (crash, restart) — *suspends* it instead, with a mechanical summary the server writes itself from the session's own event log (last messages, files changed, any open question, the write set) — `closed` is reached only by explicitly clicking Uzavřít or by the auto-archive sweep of old closed sessions. Such a row shows "pozastaveno serverem" with the reason (odpojení, nečinnost, restart serveru, proces osiřel po restartu) so it reads differently from a handoff a hand-opened CLI's own agent wrote on purpose via `portuni_session_suspend`. A suspended row shows whether the underlying CLI conversation is still resumable or will fall back to the summary, and links to the handoff file when one exists (or, when this device has no local mirror for the node, the handoff text is still resumable from — it was simply never written to a file here) — this is informational only now: there is no separate resume action, sending the next message into the thread is what resumes it, `--resume` on the last run when still valid, from the summary otherwise. Each row's status dot doubles as a chip (Běží / Čeká na mě / Pozastaveno / Hotovo / Archiv, "Čeká na mě" overriding "Běží" while a question is open), shows the task `brief`'s first line when set, and — for a row you don't own — the owner's name (when resolvable; below `manage` scope it's silently omitted rather than showing a raw id). "Otevřít chat" jumps to [the task chat](#task-chat-práce); a closed row you can resume shows a single "Navázat" button — `POST /sessions/:id/continue`, which starts a fresh, running session on the same node seeded with this one's summary and switches Práce to it. Which of these appear at all follows #321's access table: only the owner ever sees Navázat; Uzavřít (asks first) needs the owner or `manage` scope; Otevřít chat and Zobrazit handoff need only to see the node (the client hides what would 403; the server is the actual gate).

The action bar below the pane (non-organization nodes) is "Nový úkol" — see [Task chat (Práce)](#task-chat-práce).

Every mutating action calls back through `onMutate` which refetches the graph and the node detail, so the rest of the UI stays consistent.

### Task chat (Práce)

"Nový úkol" on a node's detail pane (or the "+" on its sub-row in the
left column) opens a thread immediately — one click, no dialog: `POST
/sessions` with just `{ node_id }` creates a `draft` session (a name,
a node, an owner, nothing else yet) and Práce's centre column switches to
`SessionChat` for it right away, composer focused. There is no runner or
instance to pick up front. The first message you send
(`POST /sessions/:id/messages`) is what promotes the draft to `running`
and starts its first run: the server picks the first installed &&
logged-in runner (`GET /runners`) and, when the node's organization has a
default instance registered for it (Settings → Runnery), that instance —
the same rule a manual picker used to apply, just resolved server-side
instead of asked up front. The thread's name comes from that same first
message (first line, trimmed, cut at ~60 characters), not from the node
and date the way an ownerless chat session still defaults to. A draft
closed before a first message is sent is deleted outright, and one left
open longer than 24 hours is pruned by the same server sweep that resolves
a `running` row orphaned by a crashed process.

`SessionChat`'s header shows the session name, a status chip derived from
`state` and `waiting_since` ("Běží", "Čeká na mě" when a question is
open, "Pozastaveno", "Uzavřeno", "Archivováno"), and the runner/instance.
Stopping a turn is not a header action any more: the composer's own
submit button doubles as a stop control (a stop square) whenever a run is
live, and Esc does the same — both just call `interrupt()`, which cancels
whatever the model is doing right now without ending the run, so you can
keep typing straight after. The two remaining header actions are
**Pokračovat v nové session** (offered any time there's an open thread —
`POST /sessions/:id/continue`, which closes this session, seeds a new one
with its summary, and switches Práce to it) and **Uzavřít**, which asks
for confirmation first (the only irreversible action here) before doing
the same close `interrupt` never does. Both follow the access table below;
a refused action surfaces the server's own error, there is no client-side
prediction of who may do what.

The event list renders the session's canonical log, delivered entirely
over the live WebSocket below (a subscribe replays the persisted log,
then streams what follows): user and assistant messages as chat bubbles,
reasoning as a collapsible aside, `tool_call` collapsed from its `started`
and `completed`/`failed` pair into one row showing the title (click it to
expand the input summary and output excerpt), `file_change` linking into
the Files tab, and `compaction`, `handoff`, `state_changed` and
`run_ended` as centered system markers. Both assistant text and reasoning
stream in from `delta` frames — a `channel: "text"` delta builds up
towards the next `assistant_message` event, a `channel: "reasoning"` one
towards the next `reasoning` event — and each buffer clears once its own
matching event lands; the reasoning aside stays open while its deltas are
still arriving and collapses once the batched event replaces it. A
question panel appears above the composer while
`waiting_since` is set — option buttons for an approval, a text field for
free-form input — and the composer itself disables while closed or
archived, or when you are not the session's owner (messages and answers
are owner-only; anyone who can see the node can read along). Unlike
before, it does **not** disable while suspended: a suspended thread shows
a dismissible notice above the composer instead ("the process was ended;
the next message replays the whole conversation into the model") and
stays fully usable — sending is exactly what resumes it, `--resume` on
the last run's conversation while that's still valid, from the summary
otherwise; the server decides, there is no mode picker any more.
Dismissing the notice only hides that one instance; the next time the
thread ends up here (a new run starts, then also ends other than by
Uzavřít) shows a fresh one. The header names the runner, instance and
host, plus the thread's own model/reasoning-effort override when it has
one (see
[Runners: model and reasoning effort](/reference/runners/#model-and-reasoning-effort)).
The composer has a model selector (`GET /runners/:runner/models` —
documented aliases until this device has run a task, the real list after)
and, only when the chosen model supports it, a reasoning-effort selector
labelled as applying from the next run, not the current one. While a run
is live the header also shows the restart indicator (run age, write/read-set
size, scope expansions since the run started) as plain information — no
action of its own; **Pokračovat v nové session** above is what carries the
work into a fresh context when it's needed.

A session can also be driven directly over REST, ahead of or instead of
the chat UI above: the same `POST /sessions` plus `POST
/sessions/:id/messages` (send a chat message — starts a fresh run first
if the last one ended other than by Uzavřít, `--resume` or from the
summary, the server's own choice), `POST
/sessions/:id/questions/:request_id` (answer an open question), `POST
/sessions/:id/interrupt` (cancels the current turn only — the run stays
live), `POST /sessions/:id/continue` (closes this session, seeds a new
one on the same node from its summary, returns `{ session, run }` for the
new one), `POST /sessions/:id/close`, `GET /sessions/:id/signals`, and
`GET /sessions/:id/events?after&limit` for the canonical event log the
chat view above renders from. `POST /sessions/:id/suspend` and `POST
/sessions/:id/resume` are gone — there is no separate suspend handshake
any more, and resuming is just sending a message.

Who may call what follows one access table across every task route: **read**
(`GET /sessions/:id/events`) is anyone who can see the session's anchor
node; **message** (send a message, answer a question, rename) and
**resume** (`continue`) are the owner only; **stop** (interrupt/close) is
the owner or anyone with `manage` scope. A session anchored to a node you
cannot see reads as a plain 404, same as the node itself being invisible;
a node-less session (a plain interactive chat, not a task) is 404 for
everyone but the owner. An interrupt/close by someone other than
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
answers 426). The socket is mounted in both data modes: on the standalone
/ local sidecar over its own database, and on the central-mode sync agent
over the same runtime its REST task routes drive, so the window's
connection always targets its own sidecar. Opening the socket needs
`read` scope; `message`, `answer`, `interrupt`, `continue` and `close`
frames need `write` scope (`FORBIDDEN` otherwise) and, in the packaged
app, an upgrade that carried the webview-proxy proof described above
(`WEBVIEW_PROXY_REQUIRED` otherwise) — a `subscribe` works either way. Every frame is JSON `{ id?, type, payload }`; a frame
carrying `id` gets `{ id, type: "reply", payload }` on success or
`{ id, type: "error", payload: { code, message } }` on failure — the same
codes the REST routes answer with (`SESSION_FORBIDDEN`,
`SESSION_NOT_FOUND`, `NO_LIVE_RUN`, `NO_PENDING_QUESTION`, …). A refused
action is always an error frame, never a closed socket.

Client → server: `subscribe { session_id, after }` (replays the persisted
event log after `after`, then streams live), `unsubscribe { session_id }`,
`message { session_id, text }`, `answer { session_id, request_id, decision }`,
`interrupt | close { session_id }`, `continue { session_id }` (replies with
`{ session, run }` for the new session so the client can switch to it
without a second round trip) — each mapped to the same runtime call and
access tier the REST route uses.

Server → client: `event { session_id, event }` — a persisted canonical
event, carrying the `seq` the store assigned it; `delta { session_id,
run_id, channel, text }` — streamed text, never persisted, never replayed,
`channel` one of `"text" | "reasoning"` saying which persisted event this
delta is a live preview of; and
`session_state { session_id, state, waiting_since, node_id }` — sent for
every running or suspended session you can see the moment you connect
(newest activity first, at most 500), and again on every `state_changed`,
`question` or `run_ended` anywhere, with no subscription needed. This is what lets the Relace tab, the Práce sidebar and Přehled
update live instead of polling.

Reconnect rule: a client that drops and reconnects re-subscribes to each
session it cares about with the last `seq` it actually saw — nothing is
lost, because events are the durable record and deltas were always
disposable.

## Settings

Sections worth highlighting:

- **Theme** — light / dark; the choice persists in `localStorage` and is reapplied on launch.
- **MCP server** — shows the sidecar's URL (typically `http://localhost:4011/mcp`), port, and whether an auth token is set. The bearer token itself lives in macOS Keychain (Tauri-only); reveal it on demand or rotate with one click. The install buttons write the URL + token into `~/.claude.json`, `~/.codex/config.toml`, and `~/.vibe/config.toml` so external clients can talk to the app's sidecar without manual config editing.
- **Synchronizace** — informational. See below.
- **Integrace → Showtime** — off by default, stored in `localStorage` like the other settings. On, a `.showtime` deck in a node's files opens as a rendered preview (the `preview.html` Showtime packs into the bundle at every save; `GET /nodes/:id/file` returns that entry as `text/html` for a `.showtime` path) and the preview offers „Otevřít v Showtime" when Showtime.app is installed — the section shows whether Showtime.app was found (`/Applications` or `~/Applications`) and what the button hands over: the node's Portuni connection for the agent and the node's mirror as a working directory. It also puts „Nová prezentace" behind „+ Nový soubor" on the Files tab (see Files above). Off, the bundle is a binary file like any other.

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
3. "Nový úkol": opens an empty thread right away. Write the first message; it picks a runner for you and starts the run.
4. Work. The agent uses Portuni MCP tools (`get_node`, `get_context`, `log`, `store`, etc.) via the embedded sidecar — same surface external clients see.
5. When done, `portuni_status` (or rely on the agent to call it) before ending the session so disk / DB / remote stay consistent — this rule is enforced by the server-level instructions.

## See also

- [Desktop App](/clients/desktop-app/) — install, first run, update flow
- [Symbiotic Workflows](/guides/symbiotic-workflows/) — how the agent and the human share the graph
- [Local Mirrors](/concepts/mirrors/) — the per-device mirror model the workspace view surfaces
