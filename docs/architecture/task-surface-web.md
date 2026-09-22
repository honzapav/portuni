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
  between workspaces. The other scoped keys are `openNodes`,
  `fileTreeCollapsed` and `fileTreePlan` -- the Files tab's move plan
  (#447), `{ [nodeId]: { moves, folders } }`, a node's entry removed once
  its plan is empty. The plan belongs to the node on this device and is
  never sent anywhere; `loadFilePlan`/`saveFilePlan` in `lib/settings.ts`
  are its only readers, wrapped by `useFilePlan(nodeId)`
  (`lib/use-file-plan.ts`). `useFilePlan` pairs the plan with the node id it
  was loaded for and re-resolves that pairing during render, not in an
  effect (#451): `DetailPaneBody` is never remounted on a node switch, and
  an effect-based reset would still let `FileTree`'s own cleaning effect
  see the new node's files laid over the previous node's plan and write it
  back under the new node's id. The plan is state of the Files tab, not of
  `FileTree`: "Nová složka" sits in the toolbar and writes to the same plan
  the tree renders, and a plan holding only a virtual folder is a tree on a
  node with no files at all (#448).
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
- The mounted set is `selectMountedThreads(store, openNodeIds, shownId)`
  (`lib/session-selectors.ts`, over `mountedChatSessions` in
  `lib/session-views.ts`): every chat-eligible thread of an open node, in
  open-node order, plus the shown thread when the store has not caught up
  with it yet (a fresh draft). Closing a node or a thread drops it from the
  set, which is what unmounts its chat and unsubscribes it.
- With several chats mounted, `onSessionUpdated` is `store.put` -- a `put`
  writes one record by id, so a hidden thread reporting its own state can
  never replace the shown one.

### SessionChat (`SessionChat.tsx`)

The chat for one thread. Header: status dot, name, status chip
(`sessionStatusChip`; a draft reads "Nový"), then on the right the context
ring and "Pokračovat v nové session" / "Uzavřít" as the only header
actions. Runner, instance, host, model and effort are the composer's, not
the header's. Below the header: the suspended-thread notice bar, the
transcript, the open question's confirmation block, the composer.

**The thread column.** Transcript content, notice bar, question panel and
composer share one centred column, `THREAD_COLUMN = "mx-auto
w-[min(80%,768px)]"`: 10 % gutters each side, 768 px at most. The scroll
container stays full-width so the scrollbar keeps the pane's edge.

**The context ring.** `contextRingState(used, max)` (`lib/context-ring.ts`)
takes the transcript's latest `context_usage` event when the log is here,
else the summary's `context_used_tokens` / `context_max_tokens` (a reload
before the replay). Null means no ring (a draft, a session that never
reported). Under 80 % the trigger is `text-dim`, from 80 % it is
`--color-node-process` and "Pokračovat v nové session" becomes the filled
button. With `max` null the label is a bare count ("12,3 k tokenů"). The
ring is AI Elements' `context` with the `ai`/`tokenlens` cost estimate
stripped (`ContextTrigger` shows the `label` prop; `maxTokens` may be null).

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

The page is `max-w-[1400px]`: a counter strip on top (`CounterStrip`,
`overviewCounters` in `lib/overview-view.ts`: Čeká na mě, Běží, Vyžaduje
pozornost, Nesynchronizováno -- each a button to Práce, Graf or the
Nesynchronizováno dialog), then the four cards in two columns. Every card
lists at most `OVERVIEW_ROW_CAP` (8) rows (`capRows`); "Zobrazit všech N"
in the card's footer expands it in place, per mount.

The Relace card is the caller's own inbox: `sortInboxSessions(running,
suspended, meId)` orders waiting first, then running, then suspended, and
keeps only rows with `user_id === meId`; `splitThreadsAndCli` then keeps
threads (`isThreadSession`) as rows and puts hand-opened CLI sessions into
the footer line "K tomu N relací z CLI (N běží)". `GET /overview` itself
returns every session on a node the caller can see; the restriction is
the client's. Rows are overlaid with live state (`mergeLiveSessionStates`,
fed a `liveStates` map `App.tsx` derives from the session store via
`selectLiveStates` -- see "State ownership: the session store" above) and
the card reloads whenever the live-state stamp changes. The unsynced
counter is `useSyncPending().pending.total` passed down from `App.tsx`.

### Sidebar thread rows (`WorkspaceNodeList.tsx`)

Every open node in Práce lists its running, suspended and draft threads as
sub-rows, in both arrangements (`NodeTree`'s `TaskRow` under the node row,
`TaskList`'s grouped rows with `TaskGroupKey` = waiting / running /
suspended / draft "Nové" / done; the grouping lives in
`lib/workspace-list.ts`). A thread is `session_type = 'interactive_task'`
with `cli = null` (`isThreadSession`); a hand-opened CLI session has no
sub-row, Relace keeps it. **One row is active** (`nodeRowActive`): the
shown thread (`activeSessionId`, which is the store's `selectShownThread`
result's id) when there is one, otherwise the selected node -- never both.
A node row's
status dot (`summarizeNodeActivity`) appears only while a thread under it
is running or waiting; suspended and draft threads show none. Metrics:
node rows 36 px, sub-rows 32 px, 4 px between sub-rows, 8 px between
nodes, 12 px column padding. A `TaskRow` renames inline on double-click
(`onRenameTask`) and has a hover-revealed `×` (`onCloseTask`). The node
row's `+` (`onNewTask`) opens a new thread; `registerSessionStarted` in
`App.tsx` also requests the new thread by id so it stays in front on a
node that already had a live one.

The ⌘K node palette (`NodeCommandPalette.tsx`) is shadcn's `CommandDialog`
on its defaults: a bare 48 px search row with a divider, 40 px rows inset
8 px with an inset active fill, the type dot in a 20 px icon slot, the type
name muted on the right (absent under a group heading), and a
`CommandFooter` of `Kbd` key hints. It finds and opens nodes only.

## State ownership: the session store

Spec `docs/superpowers/specs/2026-09-22-web-session-state-design.md`. Every
fact about a thread -- name, state, waiting, runner, instance, model,
effort, node, host -- lives in one record per session id
(`apps/web/src/lib/session-store.ts`'s `SessionStore`), and every surface
reads that record instead of holding its own copy. Seven principles:

1. **Every fact about a thread exists in the window once.** One record per
   session id; the sidebar, the chat header and the composer read the same
   value at the same moment.
2. **The server is the truth, the window is a cache.** A change is: send →
   the server answers with the row → replace the record. An optimistic
   write is allowed but is always replaced by the answer; a refusal
   restores the previous record.
3. **The live channel updates records, never replaces them.** A
   `session_state` frame folds state, waiting and (when carried) name into
   the existing record -- runner, instance and model stay what they were.
4. **Lists are derived, never stored.** "Threads of node X", "the shown
   thread", "running count" are selectors over the store plus what is
   selected (`apps/web/src/lib/session-selectors.ts`); a refetch fills
   records, it decides nothing about what is shown.
5. **A draft is a thread.** No local draft map, no promotion bookkeeping;
   the record's `state` says `draft` until the first message, so
   `selectNodeThreads` includes it like any other thread.
6. **A component holds only what is its own.** `SessionChat` holds the
   transcript, delta buffers and composer state; the thread itself it
   reads from the store by id.
7. **Rules are held by scenario tests**
   (`test/session-store-scenarios.test.ts`), not by helper tests alone.

**One `SessionsClient` and one `SessionStore` for the app's lifetime.**
`useState(() => createSessionsClient({ autoConnect: false }))` and
`useState(() => createSessionStore())`, both created once. The client
connects from an effect whose cleanup disconnects; the store is bound to
`api.ts` (`bindSessionStore`, a module-level binding so no caller of a
session-mutating function can forget to write its answer through) and to
the client (`sessionsClient.onSessionState(store.applyFrame)`) from
effects, never inside the initializer -- StrictMode runs initializers
twice, and a transport or binding done there would either run twice or,
for the socket, leak a live connection delivering every frame twice.

**`api.ts` writes the store itself.** `fetchNodePersistentSessions` →
`putMany`; `startDraftThread`/`startSession`, `renamePersistentSession`,
`closePersistentSession`, `patchSessionModelEffort`,
`patchSessionRunnerInstance`, `fetchSession`, `continueSession` → `put`;
`deletePersistentSession` → `remove`. The two device-local PATCHes
(model/effort, runner/instance) answer with the raw session row (missing
`write_count`/`host_label`, which only `toSummary` adds) -- `put` still
wants a full `SessionSummary`, so those two are carried over from whatever
the store already has for the id.

**What `App.tsx` reads off the store**, all through `useSessionStore` plus
a selector: the running count (`selectRunningCount`), the selected node's
shown thread (`selectShownThread`), each open node's own threads for the
sidebar (`selectNodeThreads`, one call per open node id), and the mounted
threads (`selectMountedThreads`). `registerSessionStarted` (every
`onSessionStarted` call site: Práce's `NewTaskButton`, Graf's `DetailPane`,
the sidebar `+`, the Relace tab's "Navázat") is `store.put(session)` plus
`requestChatSession` -- the API call that produced `session` already put it,
so the store write here only covers a caller that does not go through
`api.ts`; the request is what makes the fresh thread stick, since the pick
re-runs the moment it is tracked and without the requested id a node that
already had a thread open would snap back to it.

**What stays local to `App.tsx`:** `requestedChatSessionByNode` (a
selection, not a fact about a thread), `openNodeIds`, the `SessionsClient`,
and `refreshNodeSessions(nodeId)` -- coalesced per node (a request while one
is in flight sets a trailing flag instead of racing a second fetch), run
whenever `openNodeIds` changes and on every `session_state` frame whose
`node_id` is open (a thread started elsewhere -- Relace tab, node detail,
another window -- announces itself only through that frame, which the
store folds in as a partial record until this refetch completes it). It
decides nothing about what is shown; `fetchNodePersistentSessions` itself
writes the rows into the store.

**Two surfaces still overlay their own live-state map onto REST rows the
store doesn't hold**, because they predate one-record-per-thread and are
out of this batch's scope: Přehled (`OverviewView`'s `OverviewSessionRow`
rows) and the Relace tab (`DetailPane.sessions.tsx`'s own node-session
fetch). Both take a `liveStates`/`liveSessionStates` prop shaped like
`Record<string, SessionStateMessage>`; `App.tsx` derives it from the store
(`selectLiveStates`) instead of folding a second map itself, and
`applyLiveSessionState`/`mergeLiveSessionStates` (`lib/session-views.ts`)
still do the overlay.

Threading: `App.tsx` → `Sidebar.tsx` (`workspaceThreadsByNode`,
`workspaceActiveSessionId`, `onWorkspaceOpenSessionChat`,
`onWorkspaceNewTask`, `onWorkspaceRenameTask`, `onWorkspaceCloseTask`) →
`WorkspaceNodeList.tsx` (`threadsByNode`); `App.tsx` → `WorkspaceView.tsx` /
graph `DetailPane` (`onSessionStarted`, `onOpenChat`) → `DetailPaneBody` →
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
- **Rows, not events.** `deriveTranscriptRows(events, liveRunId)`
  (`lib/session-chat.ts`) turns the seq-ordered log into `TranscriptRow`s:
  `prompt` and `answer` render at full weight (`Message`); every
  `reasoning`, `tool_call` and `file_change` between two answers of one run
  folds into one `activity` row; `question`, `compaction` (`Checkpoint`),
  `handoff` ("Shrnutí uloženo") and `error` keep a small marker; a
  `run_ended` is nothing for `completed` and `suspended` (the ordinary
  ends), a neutral "Přerušeno" note for `interrupted`, and an error row in
  the danger colour for `error`, `limit` and `host_lost`; `run_started`,
  `state_changed` and `context_usage` render nothing. `collapseToolCalls` runs inside, so a
  `started` and its `completed`/`failed` are one item.
- **The activity group** (`ActivityGroupRow`) is a `ChainOfThought` whose
  header is `activitySummary(items)`: a sentence from verb counts
  ("Přečteno 3 soubory · upraveno 1 · 2 příkazy · uvažoval 12 s"; the
  seconds are `reasoningSeconds(items)`, the reasoning blocks' `duration_ms`
  added up and rounded, at least 1 s when there is any), a single call's own
  title, the danger colour with the failed count when a call failed. The
  verb table (`TOOL_VERBS`) covers Claude's tool names; anything else shows
  as "N × <tool>". Expanded, one `ChainOfThoughtStep` per item with the
  `Tool` card inside; a historical group expands by hand, per mount; the
  live run's trailing group (`live: true`) stays open on the tool that is
  running.
- **The working row** (`WorkingRow`, `workingPhase`): while a turn is in
  flight (`turnInFlight`: a `user_message` on the live run with no
  `turn_ended` after it; the run start alone opens no turn, so a thread
  started by Navázat or a resume waits idle for its first message) or a
  send is in flight (`sentAt`), and
  neither streaming text nor a running tool is on screen, a `Loader` with
  "Spouštím…" (until `run_started`), "Přemýšlím…" (until the first delta
  or tool) or "Pokračuji…" (after a tool finished) and a seconds counter.
  Rule 2 of the v2 spec: a turn in flight with an empty transcript end is
  a bug. Between turns nothing shows: the run is alive only to take the
  next message, and the composer's stop button and Escape apply to a turn
  in flight only (`turnActive`), never to the idle run.
- **Deltas**: two `DeltaBuffers` keyed by `run_id`, one for `channel:
  "text"`, one for `channel: "reasoning"`. Each is cleared by its own
  persisted event (`assistant_message` / `reasoning`) and on `run_ended`.
  The persisted event is the record; the delta is only its live preview.
  Frames are coalesced first (`createDeltaCoalescer`): buffered per
  (run, channel) and flushed once per `requestAnimationFrame`, so a burst
  costs one render; `run_ended` flushes, unmount clears. The desktop
  bridge forwards frames unchanged.
- **AI Elements** supply the transcript chrome under
  `src/components/ai-elements/` (`conversation`, `message`, `reasoning`,
  `tool` + `code-block`, `confirmation`, `prompt-input`, `shimmer`,
  `checkpoint`, `loader`, `chain-of-thought`, `context`), pulled with
  `npx ai-elements@latest add <name>`; each file
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
- Reasoning uses the kit's `Reasoning` with `isStreaming`; a historical
  block passes its `duration_ms` as the kit's `duration` (seconds). The
  trigger text is Czech (`reasoningTriggerMessage`: "Přemýšlím…" /
  "Uvažoval N s" / "Uvažoval několik sekund" without a duration).
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

## The composer's rows

Two rows under the textarea, inside the composer's border
(`PromptInputFooter` as a column).

**Row 1 -- the run's choices; send/stop.** The model `Select` lists
`GET /runners/:runner/models` for `session.runner ?? "claude"`. The effort
`Select` appears only when the selected model's `supportsEffort` is true
and offers that model's own `effortLevels`; its title says it applies from
the next run. Both are gated on `access.canResume` and both call
`patchSessionModelEffort`, updating the header optimistically through
`onSessionUpdated`. `SessionSummary` carries `model` and `effort`, so no
second fetch is needed.

**Row 2 -- where it runs, dimmer.** `runner · instance ▾ · host`. The
`Select` (`lib/runner-picker.ts`: `runnerPickerGroups`,
`encodeRunnerChoice`/`decodeRunnerChoice`, `runnerChoiceLabel`) lists every
logged-in runner from `GET /runners` as a group, its own default instance
first and every `GET /runners/instances` entry of it after; the draft's
initial value -- what the organisation's default resolved to at creation
-- is marked "(výchozí)". It is enabled only while `live.state ===
"draft"`; a promoted thread renders the pair as a plain label, and a draft
whose row carries no runner reads "Žádný runner není přihlášený". A change
calls `patchSessionRunnerInstance` (`PATCH /sessions/:id`, central in a
team workspace; 409 `SESSION_NOT_DRAFT` once promoted). The host is
`hostDisplayName(session)`, a label, hidden when unknown.

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
buffers and the coalescer, `collapseToolCalls`, `deriveTranscriptRows`,
`activitySummary`, `workingPhase`,
`threadNameFromFirstMessage`), `lib/session-views.ts` (row chip, access
echo, live overlay, inbox ordering, the node-map folds, `isThreadSession`,
`nodeRowActive`), `lib/workspace-list.ts` (the node dot, the Stav
grouping), `lib/runner-picker.ts` (composer row 2) and
`lib/context-ring.ts` (the ring). All are dependency-free and run under
the server's `node:test` runner (`test/session-chat-helpers.test.ts`,
`test/session-views-helpers.test.ts`, `test/workspace-list-helpers.test.ts`,
`test/runner-picker.test.ts`, `test/context-ring.test.ts`); `apps/web` has
no test runner of its own. New logic that can be pure goes there first.

## Known gaps

- The activity sentence's verb table covers Claude's tool names; another
  runner's tools show as "N × <tool>" until they are added.
- The ring's `max` is unknown until the runner's first `result`; until
  then it shows a bare count.
- The palette finds nodes only; actions ("Nový uzel", "Nový úkol v…") are
  a later group.

## See also

- [`sessions-and-runner.md`](./sessions-and-runner.md) — session rows,
  runs, promotion, suspend and resume, the live channel server side.
- [`desktop-shell.md`](./desktop-shell.md) — the Rust WebSocket bridge and
  per-window events.
- `docs/superpowers/specs/2026-09-15-task-surface-design.md` — the layout
  and lifecycle rules this implements.
- `docs/superpowers/specs/2026-09-12-runner-and-session-design.md` — the
  runner and session model.

## Shown thread and the selected node

The pane Práce shows is `shownChatSessionId(selectedNodeId, openSession)`
(`apps/web/src/lib/session-views.ts`): the open session only while it is
chat-eligible and anchored on the selected node. After a switch to another
node the open session is still the previous node's until that node's own
list is fetched and picked; nothing is shown meanwhile, so a click never
reads as ignored, and a failed fetch lands on the node surface as an error
(`workspaceDetailError`) instead of a silent null. The chat header carries
the same icon actions as a Relace row (rename, Pokračovat v nové session,
Uzavřít behind a separator); rename is inline, Enter saves, Escape cancels.
