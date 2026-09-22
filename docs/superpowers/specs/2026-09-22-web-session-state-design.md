# Web: one record per thread

Follows `docs/superpowers/specs/2026-09-22-local-sessions-design.md`
(lists carry the owner's drafts; the events route reports where the
transcript is). Supersedes, in
`docs/architecture/task-surface-web.md`, the section **State ownership
in `App.tsx`**.

## Principles

1. **Every fact about a thread exists in the window once.** Name, state,
   waiting, runner, instance, model, effort, node, host: one record per
   session id, and every surface reads that record. What the sidebar,
   the chat header and the composer show is the same value at the same
   moment.
2. **The server is the truth, the window is a cache.** A change is:
   send → the server answers with the row → replace the record. An
   optimistic write is allowed but is always replaced by the answer; a
   refusal restores the previous record and the surface says why.
3. **The live channel updates records, never replaces them.** A
   `session_state` frame carries state, waiting and name; folding it
   into the record leaves runner, instance and model as they were. No
   handler holds a copy of a session to send back.
4. **Lists are derived, never stored.** "Threads of node X", "the shown
   thread", "running count" are selectors over the records plus what is
   selected. A refetch fills records; it decides nothing.
5. **A draft is a thread.** No local draft map, no promotion bookkeeping;
   the record's `state` says `draft` until the first message.
6. **A component holds only what is its own.** `SessionChat` holds the
   transcript, the delta buffers, `sending`, the composer text and the
   working-row clock; the thread itself it reads from the store by id.
   It has no `live` copy of state.
7. **Rules are held by scenario tests**, not by helper tests alone.

## The store (`apps/web/src/lib/session-store.ts`)

A plain TypeScript module, no React, no library:

```ts
interface SessionStore {
  get(id): SessionSummary | undefined
  put(row: SessionSummary): void            // replace; same reference when equal
  putMany(rows): void
  remove(id): void
  applyFrame(frame: SessionStateMessage): void   // fold state/waiting/name into the record; unknown id: create a stub record marked `partial`
  subscribe(listener): () => void
  snapshot(): ReadonlyMap<string, SessionSummary>
}
```

- Created once per app (`useState(() => createSessionStore())`), bound
  to the `SessionsClient` once: `sessionsClient.onSessionState(store.applyFrame)`.
- Every REST call that returns a row calls `store.put(row)`; every REST
  list calls `store.putMany(rows)`; a `DELETE` calls `store.remove`.
  The `api.ts` functions do this themselves, so a caller cannot forget.
- A record marked `partial` (known only from a frame) is completed by
  the next `put`; selectors treat it as a row with unknown name and
  runner.
- Equality: `put` keeps the existing reference when every field is
  equal, so selectors and effects keyed on identity do not fire.

## Reading (`useSessionStore`)

`useSyncExternalStore` with selectors, all pure and tested:

- `selectSession(id)`
- `selectNodeThreads(nodeId)`: running, waiting, suspended, draft rows of
  the node, ordered as `sortInboxSessions` orders today
- `selectShownThread(nodeId, requestedId)`: `pickOpenChatSession` over
  `selectNodeThreads`
- `selectMountedThreads(openNodeIds, shownId)`: `mountedChatSessions`
  over the store
- `selectRunningCount()`: `countRunningSessions`

The existing pure helpers in `session-views.ts` survive where they are
selectors; the folds that exist only to sync copies (`applySessionStateFrame`
on a separate map, `mergeSessionIntoNodeMap`, `applyNodeSessionsRefetch`,
`dropPromotedDrafts`, `mergeDraftsIntoNodeMap`, `applySessionUpdateToDrafts`,
`pruneNodeSessions`) are deleted with their tests.

## Writing

- Thread actions (`startDraftThread`, rename, close, delete, runner/
  instance, model/effort, continue) call the API; the API puts the
  returned row. The action's own optimistic `put` is optional and, when
  used, is paired with a restore on failure:
  `const before = store.get(id); store.put({...before, ...patch}); api(...).catch(() => { store.put(before); setError(...) })`.
- `SessionChat` never calls `onSessionUpdated`; the prop is removed. It
  reads `useSessionStore(selectSession(session.id))`.
- Refetches: `refreshNodeSessions(nodeId)` stays coalesced per node and
  ends in `putMany`; it runs on node open and on a frame for a node that
  is open, as today. It no longer decides what is shown.

## What leaves `App.tsx`

`sessionStates`, `localDrafts`, `workspaceOpenSession`,
`openSessionsByNode`, `updateWorkspaceOpenSession`,
`registerSessionStarted`'s three writes (it becomes `store.put(session)`
plus `requestChatSession`), the `workspaceOpenSession` effect and its
four dependencies, `openSessionsByNodeWithDrafts`,
`liveOpenSessionsByNode`. What stays: `requestedChatSessionByNode`
(selection, not a fact about a thread), `openNodeIds`, the
`SessionsClient`.

## `SessionChat`

- Props: `sessionId`, `sessionsClient`, callbacks for actions. The row
  comes from the store.
- Local state: `events`, delta buffers, `liveRunId` (derived from
  events), `sentAt`, `sending`, `loading`, `error`, rename UI, dialogs,
  `noticeDismissed`, `runners`/`instances`/`models` lists.
- `live` is deleted; `session.state` and `session.waiting_since` come
  from the record and the frame handler only folds into the store.
- `sentAt` is set before the send is awaited and cleared by
  `run_started`, `run_ended` and a failed send.
- The events response's `transcript_host` renders the "Transkript je na
  zařízení X" state instead of an empty transcript.

## Scenario tests (`test/session-store.test.ts`, `test/session-store-scenarios.test.ts`)

Pure, against the store and selectors with recorded API answers:

- pick instance → server answers → frame for another thread on the node
  arrives → node switch → back: the composer's record shows the picked
  instance throughout.
- pick instance → server refuses 409 → record restored, error set.
- draft created → appears in the node's threads at once → first message
  → frame `running` → still one record, name from the server row.
- rename in the sidebar → chat header shows it without a refetch.
- frame for an unknown id → partial record → list refetch completes it.
- close a thread → removed from every selector.
- `sentAt`: send → `run_started` before the reply resolves → `run_ended`
  with error → working row gone.

Plus the browser e2e suite planned in Asana, which exercises the same
scenarios through the UI against the dev backend with the fake runner.

## Docs

`docs/architecture/task-surface-web.md` (**State ownership** rewritten
as the seven principles and the store), `CLAUDE.md` "Web": one line,
"a fact about a thread lives in the session store; a component or map
that copies it is a bug".
