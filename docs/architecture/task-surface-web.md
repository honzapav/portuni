# Task surface — the web layer

How `apps/web` shows and steers agent threads: the Práce view with
`SessionChat` in the centre, thread sub-rows in the sidebar, the Relace tab
on a node and the inbox card on Přehled. Every surface reads the same
`sessions` rows the server owns; the web adds no state of its own beyond
what the server cannot hand back (open drafts, composer text) and a live
overlay from the sessions WebSocket. Server behaviour (runs, promotion,
suspend, resume, access tiers) is in
[`sessions-and-runner.md`](./sessions-and-runner.md); the design intent is
`docs/superpowers/specs/2026-09-15-task-surface-design.md`.

Workspaces: the web layer is the same in a personal workspace and a team-workspace
workspace. Every session route it calls is served by the device sidecar in
both kinds of workspace, and the WebSocket always targets that sidecar. The only
mode-aware pieces are unrelated to threads: sync actions and the file row's
restore button are hidden on a personal workspace (`useDataMode()` in
`DetailPane.tsx` and `SyncOverview.tsx`).

## Surfaces

### Práce (`WorkspaceView.tsx`)

The layout follows one rule: the thread takes the centre whenever the
selected node has an open thread, and the node surface moves to a
collapsible right aside.

- `hasOpenSession` is true for `running`, `suspended` and `draft`. `closed`
  and `archived` fall through to the plain node detail; they are history.
- The node surface is `EditorPane` when a file is open for that node,
  otherwise `DetailPane`. Without a thread it is the centre and there is no
  aside.
- The aside's visibility is `workspace.detailVisible`, stored under a
  workspace-scoped localStorage key (`scopedKey` from
  `lib/workspace-storage.ts`). Every per-window UI preference goes through
  `scopedKey`; all windows share one origin, so an unscoped key leaks
  between workspaces.
- `SessionChat` is lazy-loaded (`lazy(() => import("./SessionChat"))` +
  `Suspense`).
- **Every open thread keeps a mounted chat** (#429). `WorkspaceView` takes
  `mountedSessions` -- one pane per thread, each keyed on its session id --
  and only flips which pane is visible. Switching threads therefore keeps
  each thread's transcript, its scroll position, its streaming delta
  buffers and its composer, and re-subscribes nothing: `SessionChat`'s
  subscribe effect is keyed on `session.id`, and a keyed child React keeps
  mounted never re-runs it.
- A hidden pane is hidden with `visibility: hidden` plus `inert`, not
  `display: none` (which the design spec wrote before the scroll
  requirement): `display: none` destroys the layout box and with it the
  transcript's scroll offset, which is the thing keeping the pane mounted
  is for. `inert` keeps a hidden pane out of the tab order and out of
  reach of the pointer.
- The mounted set is `mountedChatSessions(liveOpenSessionsByNode,
  openNodeIds, workspaceOpenSession)` (`lib/session-views.ts`): every
  chat-eligible thread of an open node, in open-node order, plus the shown
  thread when the per-node map has not caught up with it yet (a fresh local
  draft). Closing a node or a thread drops it from the set, which is what
  unmounts its chat and unsubscribes it.
- With several chats mounted, `onSessionUpdated` matches by id
  (`updateWorkspaceOpenSession` in `App.tsx`): a hidden thread reporting
  its own state must not replace the shown one.

### SessionChat (`SessionChat.tsx`)

The chat for one thread. Header: status chip (`sessionStatusChip`), name,
runner, instance, host and the thread's own model and effort when set;
"Pokračovat v nové session" and "Uzavřít" as the only header actions. Below
the header: the restart hint line, the suspended-thread notice bar, the
transcript, the open question's confirmation block, the composer.

Host (#428): both surfaces render `hostDisplayName(session)`
(`lib/session-views.ts`) -- `host_label` when the server resolved one,
otherwise `host_id`, and nothing at all when the summary carries neither.
The summary is the only source; neither surface fetches a session's runs.
See `sessions-and-runner.md`, "Runs, events, pid files and the boot sweep".

### Relace tab (`DetailPane.sessions.tsx`)

REST-only list of the node's persistent sessions
(`fetchNodePersistentSessions`), archived rows behind a filter. Each row
shows `sessionRowChip`, the brief's first line, runner, instance and host,
the owner's name when the row is not the caller's own (`fetchUsers()`, which returns `[]` below manage
scope, so a plain teammate sees no name), and `resumeInfo` as information
only. Actions: "Otevřít chat" (`onOpenChat`), "Uzavřít" behind a confirm
`Dialog` (`closeConfirm`), and on a closed row "Navázat" (`continueSession`
from `api.ts`, then `onSessionStarted` and `onOpenChat` with the new
session). There is no live subscription in this tab; it reloads its list
after an action.

### Přehled (`OverviewView.tsx`)

The Relace card is the caller's own inbox: `sortInboxSessions(running,
suspended, meId)` orders waiting first, then running, then suspended, and
keeps only rows with `user_id === meId`. `GET /overview` itself returns
every session on a node the caller can see; the restriction is the
client's. Rows are overlaid with live state (`mergeLiveSessionStates`) and
the card reloads whenever the live-state stamp changes.

### Sidebar thread rows (`WorkspaceNodeList.tsx`)

Every open node in Práce lists its running, suspended and draft threads as
sub-rows, in both arrangements (`NodeTree`'s `TaskRow` under the node row,
`TaskList`'s grouped rows with `TaskGroupKey` = waiting / running /
suspended / draft "Nové" / done). The shown thread (`activeSessionId`,
which is `workspaceOpenSession?.id`) is highlighted. A `TaskRow` renames
inline on double-click (`onRenameTask`) and has a hover-revealed `×`
(`onCloseTask`). The node row's `+` (`onNewTask`) opens a new thread.

## State ownership in `App.tsx`

`App.tsx` owns everything the surfaces share. Rules that hold it together:

- **One `SessionsClient` for the app's lifetime.** `useState(() =>
  createSessionsClient({ autoConnect: false }))`, connected from an effect
  whose cleanup disconnects. Never create the client per render, and never
  connect inside the initializer: StrictMode runs initializers twice and a
  transport opened there has no cleanup, so the discarded client keeps a
  live socket delivering every frame twice.
- **`sessionStates`** is the latest `session_state` frame per session,
  folded by `applySessionStateFrame` (terminal entries are dropped once
  nothing live shares the node). It feeds `StatusFooter`'s running count
  (`countRunningSessions`), the sidebar overlay and the selected node's
  refetch. A session can be running without being open anywhere in this
  window.
- **`workspaceOpenSession`** is the thread Práce shows. It is refetched
  from `fetchNodePersistentSessions(id, false)` whenever the selected node,
  the requested session id, the node's live-state stamp or `localDrafts`
  change, and picked by `pickOpenChatSession` (requested id first, else the
  first running / suspended / draft row). `openSessionChat(nodeId,
  sessionId?)` only records the requested id and opens the node; the
  effect finds the session.
- **`openSessionsByNode`** holds each open node's running and suspended
  threads for the sidebar. `refreshNodeSessions(nodeId)` is coalesced per
  node: a request while one is in flight sets a trailing flag instead of
  racing a second fetch, and a response for a node closed in the meantime
  is dropped (`openNodeIdsRef`). It runs whenever `openNodeIds` changes and
  on every `session_state` frame whose `node_id` is open, because a thread
  started anywhere else (Relace tab, node detail, another window)
  announces itself only through that frame.
- **`localDrafts`** are the drafts this window opened. The server excludes
  drafts from every list, so the window that created one is the only place
  it can be shown. A draft is dropped from here only once a refetch of its
  node actually carries it as a real thread (`dropPromotedDrafts`); the
  promotion frame alone is not proof the list has it. `mergeDraftsIntoNodeMap`
  overlays drafts into the sidebar map, deduplicated by id, so the overlap
  window renders one row.
- **`registerSessionStarted`** is the single entry point for every
  `onSessionStarted` call site (Práce's `NewTaskButton`, Graf's `DetailPane`,
  the sidebar `+`, the Relace tab's "Navázat"): it sets the shown thread,
  requests it by id (`requestChatSession`), tracks a draft in `localDrafts`,
  and puts an already-running thread straight into the node map
  (`mergeSessionIntoNodeMap`) so its row appears before the confirming
  refetch. Requesting it is what makes it stick: the pick re-runs the
  moment the new thread is tracked, so without the requested id a node that
  already had a thread open snapped straight back to it.
- The folds above (`applySessionStateFrame`, `pickOpenChatSession`,
  `requestChatSession`, `mergeSessionIntoNodeMap`, `applyNodeSessionsRefetch`,
  `dropPromotedDrafts`, `mergeDraftsIntoNodeMap`, `pruneNodeSessions`)
  return their input unchanged when nothing changed, because effects key on
  those identities.

Threading: `App.tsx` → `Sidebar.tsx` (`workspaceOpenSessionsByNode`,
`workspaceActiveSessionId`, `onWorkspaceOpenSessionChat`,
`onWorkspaceNewTask`, `onWorkspaceRenameTask`, `onWorkspaceCloseTask`) →
`WorkspaceNodeList.tsx`; `App.tsx` → `WorkspaceView.tsx` / graph
`DetailPane` (`onSessionStarted`, `onOpenChat`) → `DetailPaneBody` →
`NewTaskButton` / `SessionsSection`. The graph view has no chat surface of
its own; its callbacks route through `openSessionChat`, which switches to
Práce.

## The sessions client (`lib/sessions-client.ts`)

One typed client, two transports behind one `Transport` interface:

- **Tauri**: invokes `sessions_connect` / `sessions_send` /
  `sessions_disconnect` and listens for `session-event` and
  `session-connection`. The socket lives in Rust; the webview never holds
  the bearer.
- **Vite dev**: `createDirectWsTransport` opens a real `WebSocket` against
  `/api/sessions/ws`. `vite.config.ts` proxies it with `ws: true` and a
  `proxyReqWs` handler that injects the bearer, so the token still never
  reaches client JS. Reconnect with doubling backoff (`nextBackoffMs`) is
  reimplemented here. `send` queues a frame until `onopen`; the first
  `subscribe()` always races the handshake.

Client rules:

- Every request frame carries an id the server echoes; the caller awaits
  the reply, and an unanswered request rejects on `REQUEST_TIMEOUT_MS`.
  `disconnect()` rejects every pending request at once.
- The client tracks the highest `seq` seen **per session** from `event`
  frames only. `delta` frames carry no `seq` and are never persisted, so
  they never move it.
- When the transport reports `open` after having been open before, the
  client resubscribes every still-wanted session with `after: <last seq>`.
  The server's replay fills exactly that gap: nothing lost, nothing
  re-delivered.
- `session_state` frames go to one global listener set (`onSessionState`,
  `Set`-backed so several listeners coexist); the server fans them to every
  connection that can see the session, subscription or not.
- Surface: `subscribe` / `unsubscribe` / `message` / `answer` / `interrupt`
  / `continueSession` / `close`, plus `onEvent` / `onDelta` /
  `onSessionState` / `onConnectionStatus`.

`test/sessions-client.test.ts` drives the direct transport against a fake
`ws` server (reply correlation, ordering, resubscribe-with-`after` across a
forced drop, deltas not moving the seq). The Tauri transport has no runtime
to test against here.

## Event rendering

`SessionChat` gets the whole log over the socket: `subscribe(id, 0)` makes
the server replay the persisted events and then stream. There is no REST
backfill. Events are inserted by `seq` (`insertBySeq`), which also
deduplicates a replay against a frame that raced it.

- `lib/session-chat.ts` mirrors the server's `CanonicalEvent` union by hand.
  `domain/runner/types.ts` is server-only on purpose, the same boundary
  `shared/api-types.ts` keeps. Change one, change the other.
- **Live run**: `run_started` sets `liveRunId`, `run_ended` clears it. The
  envelope carries no `run_id`, so the component tracks it from those two
  payloads.
- **Deltas**: two `DeltaBuffers` keyed by `run_id`, one for `channel:
  "text"`, one for `channel: "reasoning"`. Each is cleared by its own
  persisted event (`assistant_message` / `reasoning`) and on `run_ended`.
  The persisted event is the record; the delta is only its live preview.
- `collapseToolCalls` runs before render: a `started` and a `completed` or
  `failed` sharing `tool_use_id` collapse to the later row in place, one
  row per invocation.
- **AI Elements** supply the transcript chrome under
  `src/components/ai-elements/` (`conversation`, `message`, `reasoning`,
  `tool` + `code-block`, `confirmation`, `prompt-input`, `shimmer`,
  `checkpoint`), pulled with `npx ai-elements@latest add <name>`; each file
  keeps its Apache-2.0 header naming the upstream version so a later `add`
  reads as a diff. shadcn/ui primitives live under `src/components/ui`
  (`components.json`, style `radix-nova`, `cn` in `src/lib/utils.ts`).
- **No `ai` package.** Every type the copied files imported from it is
  replaced by a narrower local type matching this app's own event shapes
  (`MessageRole`; `Confirmation`'s two states `requested | responded`;
  `ToolHeader` / `ToolInput` / `ToolOutput` typed against `ToolCallStatus`
  and plain strings, since `ToolCallEvent.payload` is serialized
  server-side). `prompt-input.tsx` carries only the composer shell and the
  `PromptInputSelect*` pieces; attachments, screenshots, sources and tabs
  are not part of it. `conversation.tsx` has no download feature.
- **Token bridge, not a restyle.** shadcn's `--background`, `--foreground`,
  `--muted`, … are defined in `index.css` inside the existing
  `html[data-theme="dark"]` / `html[data-theme="light"]` blocks, each as a
  `var(--color-*)` reference. Portuni's palette is the only place a colour
  is defined; the `@theme inline` block only remaps `--color-background`
  and friends onto it. `@custom-variant dark` targets `[data-theme="dark"]`,
  never a `.dark` class, so the copied components' `dark:` variants apply.
- **Streamdown plugins are lazy.** `useStreamdownPlugins`
  (`lib/streamdown-plugins.ts`) loads cjk, math, mermaid and the code
  highlighter through one cached `Promise.all`; Streamdown renders plain
  markdown with `plugins` undefined, so the transcript never waits for
  them. The code plugin is our own `lib/streamdown-code.ts` over
  `shiki/core` with a curated language list, because `@streamdown/code`
  pulls every shiki grammar into the bundle. Add a language there, not by
  swapping the plugin.
- Reasoning uses the kit's `Reasoning` with `isStreaming`; the trigger text
  is Czech (`reasoningTriggerMessage`: "Přemýšlím…" / "Uvažoval N s").
- `react-markdown` / `remark-gfm` stay for `MarkdownPreview` (file
  preview), unrelated to the chat.
- Bundle rule: the whole kit (radix, shiki, motion, streamdown) must stay
  out of the startup chunk. Check `npm --prefix apps/web run build`'s main
  entry size when touching these imports.

## Thread actions

- **New thread**: `NewTaskButton` (`DetailPane.files.tsx`) and the sidebar
  `+` call `startDraftThread(nodeId)` (`POST /sessions` with no `brief`),
  which returns a draft. One click, no dialog, no required field. The
  draft's composer has focus; its first message is what starts a run.
- **First message** names the thread server-side from its first line;
  `lib/session-chat.ts`'s `threadNameFromFirstMessage` is the web's copy of
  the same function for optimistic display. Renaming a local draft is
  in-memory only (`workspaceRenameTask`); anything else is `PATCH
  /sessions/:id`.
- **Composer text** belongs to the session, not the component:
  `lib/session-drafts.ts`'s `sessionDrafts` keeps it per session id, in
  memory, for the life of the window.
- **Stop**: while a run is live the composer's `PromptInputSubmit` is the
  stop control (`status="streaming"`, `onStop` → `interrupt`), and Esc in
  the textarea does the same. Both are no-ops when nothing is live.
- **Composer state**: disabled when the thread is closed or archived,
  while a question is open (`isWaiting`), or for a non-owner. A suspended
  thread keeps the composer enabled, because sending is what resumes it,
  and shows a dismissible notice bar instead (`noticeDismissed`, reset
  whenever a new run starts).
- **Question**: the latest `question` event renders as
  `QuestionConfirmation` above the composer while `isWaiting`; answers go
  through `sessionsClient.answer`.
- **Close**: "Uzavřít" always asks first through a real `Dialog`
  (`closeConfirmOpen` in `SessionChat`, `closeTaskConfirm` in `App.tsx` for
  the sidebar `×`, `closeConfirm` in the Relace tab). `window.confirm` is a
  no-op in the Tauri webview; never use it. A draft's `×` deletes outright
  and is forgotten locally.
- **Continue**: "Pokračovat v nové session" (open thread) and "Navázat"
  (closed row) both call `continueSession`; the caller switches to the
  returned session.
- **Restart hint**: `formatRestartHint` renders `GET /sessions/:id/signals`
  ("Běží N min · zápis W · čtení R (+G od startu běhu)"). It is fetched
  only while `state === "running"`, refreshed when an event or state change
  arrives and at most once per `SIGNALS_MIN_INTERVAL_MS` (10 s), never on a
  timer of its own.

## Model and effort picker

The picker lives in the composer's `PromptInputTools`. The model `Select`
lists `GET /runners/:runner/models` for `session.runner ?? "claude"` (a
draft has no runner yet, and `claude` is the only registered adapter). The
effort `Select` appears only when the selected model's `supportsEffort` is
true and offers that model's own `effortLevels`; its title says it applies
from the next run. Both are gated on `access.canResume` and both call
`patchSessionModelEffort` (`PATCH /sessions/:id`), updating the header
optimistically through `onSessionUpdated`. `SessionSummary` carries `model`
and `effort`, so no second fetch is needed.

## Access echo

`sessionRowAccess(ownerId, meId, canManage)` (`lib/session-views.ts`)
mirrors the server's access table: `canResume` (message, answer, continue,
picker) is owner-only; `canPauseOrClose` is owner or manage scope. It only
decides which controls to offer, so a button that would always 403 is not
shown. The server remains the gate; a refused action surfaces its own
error. `meId` comes from `useMe()` (`fetchMe()` returns `id` and
`global_scope`).

Two chip wordings exist on purpose: `sessionRowChip` (compact rows:
Hotovo / Archiv) and `sessionStatusChip` (chat header: Uzavřeno /
Archivováno). "Čeká na mě" overrides "Běží" in both whenever
`waiting_since` is set.

## Helpers and tests

Pure helpers live in `lib/session-chat.ts` (event types, chip, delta
buffers, `collapseToolCalls`, `formatRestartHint`,
`threadNameFromFirstMessage`) and `lib/session-views.ts` (row chip, access
echo, live overlay, inbox ordering, the node-map folds). Both are
dependency-free and run under the server's `node:test` runner
(`test/session-chat-helpers.test.ts`, `test/session-views-helpers.test.ts`);
`apps/web` has no test runner of its own. New logic that can be pure goes
there first.

## Known gaps

- No context-usage ring next to "Pokračovat v nové session": there is no
  token accounting to drive it.

## See also

- [`sessions-and-runner.md`](./sessions-and-runner.md) — session rows,
  runs, promotion, suspend and resume, the live channel server side.
- [`desktop-shell.md`](./desktop-shell.md) — the Rust WebSocket bridge and
  per-window events.
- `docs/superpowers/specs/2026-09-15-task-surface-design.md` — the layout
  and lifecycle rules this implements.
- `docs/superpowers/specs/2026-09-12-runner-and-session-design.md` — the
  runner and session model.
