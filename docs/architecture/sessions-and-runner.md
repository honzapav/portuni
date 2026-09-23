# Sessions and the runner

A session is the unit of agent work on a node: a `sessions` row that exists
before any process runs, a task layer underneath it (`session_runs`,
`session_events`), one runtime implementation that always executes on the
device, and a store seam that decides whether that runtime writes to the
local graph db or to the central server. A thread has **two halves**: the
**record** (that it exists, on which node, whose it is, its state, runner,
instance, runs and scope) and the **content** (the first message, every
transcript event, the inline handoff summary). The record goes to the
record store; the content always goes to this device's `content.db`, in
both workspaces. An agent runs only as a task
(`POST /sessions`, the SessionChat surface) or as a hand-opened CLI that
connects over MCP; there is no embedded terminal, PTY or sandbox profile.
Specs: `docs/superpowers/specs/2026-09-12-runner-and-session-design.md`,
`docs/superpowers/specs/2026-09-15-task-surface-design.md`,
`docs/superpowers/specs/2026-09-22-local-sessions-design.md` (the
record/content split).

## Session row and binding

- **The session exists before the runner.** `startTask`
  (`domain/runner/session-runtime.ts`) creates the row first and then starts
  a run whose MCP connection carries the row id in `X-Portuni-Spawn-Id`
  (`RunStart.mcp.headers`). The handshake of that connection binds to the
  existing row; it never creates a second one.
- `createMcpServer` returns `bindSession(cli?)`; the caller invokes it at its
  own post-handshake signal (`transport.ts` `onsessioninitialized`,
  `stdio-entry.ts` `server.server.oninitialized`). A hand-opened CLI has no
  pre-existing row, so `bindSession` creates one there.
- Binding is decided before `createMcpServer` runs
  (`mcp/session-persistence.ts` `lookupSpawnSessionForBind`):
  - a row under `X-Portuni-Spawn-Id` that is `running` and owned by the
    connecting identity is bound (`bindExistingSessionPersistence`
    rehydrates `session_scope` into the connection's `SessionScope`,
    `bindExistingSessionHandshake` fills `cli` and touches
    `last_active_at`);
  - a row that exists but is not running, or belongs to someone else,
    refuses the whole connection with the 503-with-reason shape and code
    `SESSION_BIND_REFUSED`;
  - no row keeps the create-with-preassigned-id path.
- A resumed connection's `bindSession` is a no-op (`resumeSessionPersistence`
  already attached the row).
- A row is only created once a connection completes a real `initialize`.
  Sync-agent mode opens its upstream connection to central only for such a
  request, so a probe at the local front door burns no row on the central server.
- `cli` comes from the handshake's `params.clientInfo.name`, normalized to
  `claude | codex | vibe` (`client-name.ts`), never from a header.
- `wireOngoingSync` persists the session's home node as `writable=1`:
  `guardWrite` allows it implicitly and `getSessionWriteCount` counts only
  persisted rows.
- `sessions.terminal_id` is a dead column: permanently null for every new
  row, kept until a migration drops it. Nothing reads or writes it.
- The task layer (migration 034): `sessions` carries
  `runner`/`host_id`/`waiting_since`/`instance_id`/`model`/`effort`, and
  each attempt to run the task is a `session_runs` row.
  `domain/runner/store.ts`'s `SessionStore` (`DbSessionStore`,
  `CentralSessionStore`) is the only writer of that record; it has no
  event methods and carries no `brief`.
- The canonical, append-only transcript is `session_events` in the
  device's `content.db`, written and read only through
  `domain/runner/store-content.ts`'s `SessionContentStore`, which also
  owns `session_content(brief, handoff_inline)`. Every event kind and
  payload is in `domain/runner/types.ts`'s `CanonicalEvent` union. The
  `sessions.brief` and `sessions.handoff_inline` columns and the graph
  db's own `session_events` table still exist; nothing writes them after
  #456 except the two central record-half routes that keep accepting them
  for a sidecar released before it, and the central migration drops them.
- `GET /sessions/:id/events` answers from the `content.db` of the device
  serving it, in both routers. When that device has no rows for the thread
  and the record's `host_id` is another device, the answer carries
  `transcript_host` -- the host's label if this process can name it, the
  host id otherwise (`domain/runner/hosts.ts` `transcriptHostLabel`, #458)
  -- and the chat says "Transkript je na zařízení X" instead of showing an
  empty conversation. On the device that ran the thread the field is
  absent, empty transcript or not. There is no transcript backup: a
  transcript exists on exactly one device.

### States

`domain/sessions.ts` `ALLOWED_TRANSITIONS`:

| from | to |
|---|---|
| `draft` | `running` (deletion is the only other exit, `deleteDraftSession`) |
| `running` | `suspended`, `closed` |
| `suspended` | `running`, `closed` |
| `closed` | `archived` |

`closed` is reached only by the user's explicit Uzavřít (or `continue`, see
below) and `archived` only by the auto-archive sweep
(`sweepArchivedSessionsOnBoot` in `boot/session-sweep.ts`, run at boot of the
process that owns the graph db: closed for more than 30 days moves to
archived, an archived session's event log is dropped after 90 days; the
row, runs, audit and handoff stay). Everything else that ends a run
suspends.

Every Uzavřít goes through `SessionRuntime.closeSession` (the socket's
`close` frame from the chat header, `POST /sessions/:id/close` from the
Relace tab): it ends a live run and appends `state_changed {to: "closed"}`,
which is what fires the live channel's `session_state` broadcast; a
suspended session has no run and so no `run_ended`, so without this event
the Relace row, the Práce sidebar and Přehled would keep it as suspended
until an unrelated refetch. `POST /sessions/:id/state` is a bare column
transition with no runtime behind it and is not device-local; the web never
uses it to close.

A server-side suspend (`suspendSessionServerSide`: boot sweep, dropped
transport, lost host) ends every run row of the session still open
(`ended_at`, `end_reason` `suspended`, or `host_lost` for a lost host),
appends `run_ended` for each and then `state_changed {to: "suspended"}`;
without that the log ended on a `run_started` and every client replaying
it showed a live run (working row, stop button, no composer) on a suspended
thread. A run the runtime already ended is left alone, so the runtime's
own suspend path appends nothing twice. The web never trusts the replayed
log against the server's state: `runIsLiveFor(liveRunId, state)` is live
only while the session is `running`.

**Předat** (#459) is `SessionRuntime.handoff`, `POST /sessions/:id/handoff`
(device-local, `write` tier, owner; the socket's `handoff` frame carries the
same answer `{ session, handoff_path }`): the owner hands the thread to
another machine through its handoff file. On a `running` thread it
interrupts the current turn, waits for the queue to drain and then ends the
run with `pendingEndReason` `handoff`, so the same auto-summary path a limit
or an idle end takes writes `wip/sessions/<id>-handoff.md` into the node's
mirror, registers the file and patches the record to `suspended` -- one
suspend implementation, the reason marker being the only difference
(`portuni:server-handoff reason=handoff`, the one reason a person chose).
On an already `suspended` thread with its file, it is a no-op answering the
same path. A `draft` or `closed` thread is `HANDOFF_NOT_ALLOWED` and a node
with no mirror on this device `HANDOFF_NO_MIRROR` (`SessionHandoffError`,
REST 409, Czech message): without a mirror the summary is content in
`content.db` and there is no file to hand over. The other machine picks the
work up from the file once it syncs.

**Navázat na handoff** (#460) is the other end of it:
`SessionRuntime.startFromHandoff`, `POST /sessions` with `handoff_path` (the
same device-local route a task or a draft goes through, `write` tier). The
path is node-relative and must be exactly what `handoffRelativePath` writes
(`wip/sessions/<id>-handoff.md`); the runtime reads it from the node's
mirror **on this device** (`readNodeHandoffFile`, the mirror registry in
`sync.db` plus the local bytes, so a sync agent answers it without reaching
central) before it creates anything. No mirror or no file yet is
`HANDOFF_FILE_NOT_HERE` (409, „Soubor handoffu ještě není na tomto
zařízení.") and no record is created; a path of any other shape is
`HANDOFF_PATH_INVALID` (the routers' schema rejects it as a 400 first). With
the file in hand it is `continueSession`'s shape minus the close: a new
record on this device (`runner`/`instance_id` resolved as for a draft,
`host_id` this device, `name` from the summary's own H1 via
`extractHandoffTitle`, `name_is_custom` left 0 so this thread's own first
summary may rename it), and a first run with no brief whose orientation
carries the file's content under "## Navázání na handoff", the way a resume
from a summary does -- generalised to a file that belongs to another
session. No events are imported: the transcript starts on this device, and
the source thread's record, file and transcript are never touched, which is
what lets the file come from another machine. The Relace tab of the node
lists the node's handoff files (`apps/web/src/lib/handoff-files.ts`, built
from the node's file records; the title and the host come from the source
record when the user can see it, otherwise the file name is all there is)
and that is where the action lives.

A rename is `POST /sessions/:id/rename`, device-local, through
`SessionRuntime.renameSession`: it writes `name` (`name_is_custom`) and
publishes a `session_changed` frame, which is never persisted or replayed
and only makes `sessions-ws.ts` broadcast `session_state`; that frame
carries `name`, and the web overlays it (`applyLiveSessionState`) so the
Práce sidebar, the Relace tab and the chat header in every window show the
new name at once. The plain-rename branch of `PATCH /sessions/:id` remains
the central record half only.

## Access: a thread is its owner's

`auth/session-access.ts` `sessionAccess(identity, sessionId, action)` with
actions `read | message | stop | resume` (spec: local-sessions, "Access").
The table is one line: **every action is the owner's** (#457).

- A session the caller does not own is `SESSION_NOT_FOUND` (404) for every
  action -- node-anchored or not, `manage` and `admin` included. Seeing the
  anchor node says nothing about the threads on it; a teammate is never told
  the thread exists. No session route answers 403 on access grounds any
  more, so `SESSION_FORBIDDEN` is a code the union still carries and nothing
  raises.
- The list routes follow the same rule and are filtered in SQL by
  `user_id = identity`: `GET /sessions?state=…`, `GET /nodes/:id/sessions`
  (of every state, drafts included -- the node's own read gate decides only
  whether the Relace tab exists), the `sessions` section of `GET /overview`
  and `activity.session_writes`. The running count and every sidebar list
  therefore count the owner's threads only.
- Because no non-owner can reach a stop, there is no "stopped by someone
  else" path: the `state_changed` event carrying `by` and
  `SessionRuntime.recordStoppedBy` are gone.
- The web carries no access echo. `sessionRowAccess` and the `canManage`/
  `meId` props that fed it are removed from `lib/session-views.ts`,
  `SessionChat`, `DetailPane.sessions` and `OverviewView`: every listed
  thread is the caller's own, so the state alone decides which action shows.
- Coarse route scopes (`auth/min-scopes.ts`): `GET` routes are `read`,
  every mutating `/sessions*` route and `POST /sessions` are `write`.
- In a team workspace these checks run on the central server, on every store round
  trip: the device never re-implements them. A central 404 surfaces as
  `SESSION_NOT_FOUND`.

## The runtime and its store seam

The code that runs a task (spawns the adapter, provisions mirror and
orientation, translates events, ends and suspends) is one implementation,
`session-runtime.ts`, and it always runs on the device. Only
`CreateSessionRuntimeDeps` changes between modes:

| dep | personal workspace | team workspace |
|---|---|---|
| `store` (the record) | `DbSessionStore` on this server's db (`boot/session-runtime.ts` `getSessionRuntime()`) | `CentralSessionStore` (`domain/runner/store-central.ts`), built by `createAgentSessionRuntime` for `createAgentRouter(client, { sessionRuntime })` |
| `content` (the transcript, the brief, the inline summary) | `SessionContentStore` over this device's `content.db` (`deviceSessionContentStore()`) | the same object, over the same file -- content never differs between workspaces and never reaches the central server |
| provisioning | `provision.ts`: `createMirrorForNode`, `orientationForNode` (direct db read) | `provision-central.ts`: `createMirrorForNodeCentral`, `CentralClient.orientation` (`GET /nodes/:id/orientation`) |
| `suspendFallback` | `suspendSessionServerSide(db, content, id, reason)` -- `createSuspendServerSide(localSuspendDeps(db, content))` | the same `createSuspendServerSide`, built in `boot/session-runtime.ts` with four seams: `record` = `CentralSessionStore`, `scope` = `CentralClient.sessionScopeRecord`, `suspendRecord` = a record `PATCH` over REST, `trackHandoff` = `registerLocalFileCentral`. Everything else -- the summary, the file in the device mirror, the name enrichment, the no-mirror case -- is the same code (#458). Without a mirror for the node the record gets `handoff_path: null` plus the hash, and the summary itself goes to `session_content.handoff_inline` on the device (#434, #456), so `getResumeInfo` hands the next run that text |
| `resolveNodeOrgId` | `belongs_to` graph query (a failed lookup is distinguishable from "no organization") | `CentralClient.nodeOrganizationId` (`GET /nodes/:id`, the outgoing `belongs_to` peer that is an organization) |
| `session_scope` reads (`getSessionScope` in `startRun`/`sessionSignals`) | real | degrade to an empty scope, never throw |

- `CentralSessionStore` turns every `SessionStore` call into a REST round
  trip to the central server's record half (`api/sessions.ts`: `POST /sessions/record`,
  `GET`/`PATCH /sessions/:id`, `POST /sessions/:id/runs`,
  `PATCH /sessions/:id/runs/:run_id`, `GET /sessions/:id/runs`), which are
  thin wrappers over `DbSessionStore` on the central server's own db. It
  keeps an in-process `runId -> sessionId` map (filled by
  `createRun`/`listRuns`) because `patchRun(runId, patch)` carries no
  session id. **There is no event method on it and none on
  `CentralClient`**: the transcript never crosses to the central server.
  `POST /sessions/:id/events` and the `brief`/`handoff_inline` fields of
  `POST /sessions/record` and `PATCH /sessions/:id` stay on the central
  server only so a sidecar released before #456 keeps working; the central
  migration removes them.
- Where each write goes: `promoteDraftAndStart` puts the first message in
  `session_content.brief` and the `user_message` event in the device's
  `session_events`, then patches the record (`state`, `name`, `runner`,
  `instance_id`); a suspend writes the summary to the handoff file in the
  node and `handoff_path`/`handoff_hash` to the record, with
  `handoff_inline` on the device when there is no mirror here;
  `getResumeInfo` and the live channel's replay read the content store.
- `PATCH /sessions/:id` has two shapes: `{name}` alone is a rename and
  returns `SessionSummary`; any other field (`state`, `waiting_since`,
  `handoff_path`, `handoff_hash`, promotion fields) returns the raw
  `SessionRow`, because the runtime reads columns the summary lacks.
- A resolver error in `resolveNodeOrgId` degrades to "no organization" and
  never fails a promotion; it logs one warning naming the node, only when
  the fallback is visible (two or more instances for that runner and some
  org default configured).
- The team-workspace suspend writes the same summary the personal one does
  because it is the same function (#427, #458). `session_scope` and the node's name are graph-db reads,
  so they come from `GET /sessions/:id/scope`
  (`CentralClient.sessionScopeRecord`, a record-half route like the rest);
  a scope read that fails logs and degrades to empty sections rather than
  leaving the thread `running` with no handoff. The file is then registered
  through `registerLocalFileCentral` -- record-only, exactly what the
  watcher does for a new file in a mirror -- so it appears under Files at
  once; a failed registration logs and is left to the next sync run's
  untracked-file discovery, same best-effort posture as
  `writeHandoffAndSuspend`.

### Which routes run where (team workspace)

`is_device_local_path` (`apps/desktop/src/lib.rs`) sends to the device's sync
agent (`api/agent-router.ts`): bare `POST /sessions`, and per-session
`messages`, `interrupt`, `continue`, `close`, `handoff`, `events`,
`signals`, `resume-info`, `questions/:request_id`. The record half stays on the
central server: bare `GET`/`PATCH /sessions/:id`, `/state`, `/scope`,
`/runs...`, `/sessions/record`, plus `GET /nodes/:id/sessions` and
`/overview`.
`resume-info` is device-local (#456) because both of its inputs are the
device's: the inline handoff summary in `content.db` and the handoff file
in this device's mirror, which it hashes to report `handoff_changed`.
Both routers build the answer from the one
`sessionResumeInfoPayload` in `api/sessions.ts`.
`signals` is device-local because it reads in-memory live-run state
(`liveRuns`, `runStartScopeSize`) that exists only in the process running
the task. A new per-session verb must be added to `router.ts`,
`agent-router.ts`, `is_device_local_path`, `min-scopes.ts` and, when it is a
live action, `sessions-ws.ts` in the same change.

## Runs, events, pid files and the boot sweep

- The host of a run is the machine that started it. `domain/runner/hosts.ts`
  is the whole registry there is: `localHostId()` is `PORTUNI_HOST_ID` or
  the machine name slugified (`Honzas-MacBook-Pro.local` ->
  `honzas-macbook-pro`), `localHostLabel()` is `PORTUNI_HOST_LABEL` or that
  machine name with its case intact, and `resolveHostLabel(id)` answers only
  for the host this process is -- nothing here can name another machine
  until the `hosts` table of the remote-hosts spec exists. The runtime
  stamps `localHostId()` on every session and run it creates, so in a team
  workspace the sync agent's id is what reaches the central server's record
  (`POST /sessions/:id/runs` already carried `host_id`). Ids are
  human-readable rather than ULIDs precisely because the surfaces fall back
  to them when there is no label.
- `toSummary` (`api/sessions.ts`) reports the latest run that names a host
  (`getLatestRunHostId`), falling back to the session row's own -- a thread
  that started on one machine and last ran on another shows where it last
  ran. `SessionSummary.host_id` and `host_label` are what the Relace row and
  the chat header render; neither fetches `GET /sessions/:id/runs` per row.
- `startRun` writes `<dataDir>/runs/<runId>.pid` (`domain/runner/pid-file.ts`:
  `pid`, `started_at`, `session_id`) right after `adapter.start()` and
  removes it in the `run_ended` branch of `handleAdapterEvent`.
  `resolveRunnerDataDir()` (`domain/runner/data-dir.ts`) is
  `PORTUNI_DATA_DIR` or `cwd()`, the same directory as `runners.json`.
- `boot/run-sweep.ts` walks every pid file at boot, before
  `sweepStaleRunningSessionsOnBoot`, chained with `.then` because its own
  suspend resolves a session the other sweep's `running`-row query would
  race:
  - a run already `ended_at`, or an unreadable file, or a file without
    `session_id`: delete the stale file;
  - a pid that is alive and still our child (`readProcessIdentity`/
    `isOurChild`: `ps -o lstart= -o command=` shows `claude` and a start
    time no later than the file's): SIGTERM the process group, wait 5 s,
    SIGKILL;
  - in every case `patchRun(end_reason: "host_lost")`, append
    `run_ended {reason: "host_lost"}` and patch the record `suspended` with
    **no handoff** (#458): the process that could have summarised the run is
    the one that died, and the central server has no content to summarise.
    The thread resumes from its transcript, which is on this device.
- A pid file is only ever found by the next boot of the same process on the
  same machine. Both kinds of workspace run the sweep: `index.ts` and `desktop.ts`'s
  local branch call `sweepOrphanedRunsOnBoot` (`localRunSweepBackend`,
  resolves the run by id in `session_runs`); `desktop.ts`'s `agentMain`
  calls `sweepOrphanedRunsOnBootCentral(new CentralSessionStore(client))`
  (`centralRunSweepBackend`, resolves via `store.listRuns(session_id)`).
  The outcome is the same code in both backends -- `RunSweepBackend` is
  `{store, content, resolveRun}`, nothing mode-specific about the suspend.
  Both carry the device's `SessionContentStore`: the `run_ended` event the
  sweep appends is content and goes to `content.db`.
- Server-side suspend (`domain/session-handoff.ts`
  `suspendSessionServerSide(db, content, sessionId, reason)`,
  `ServerHandoffReason` = `disconnect | idle | terminal_exit | boot_sweep |
  suspend_timeout | host_lost | run_ended | continue`) writes a minimal
  handoff into the session's home mirror when this device has one, else
  into the content store's `handoff_inline`; the record keeps
  `handoff_path`/`handoff_hash` only, and `getResumeInfo` reads whichever
  of the two is populated. The summary itself is built from the device's
  transcript, so it is the same text in both workspaces.
  The content carries a marker with its reason; `parseServerHandoffReason`
  reads it back so `GET /sessions/:id/resume-info` reports
  `generated_by: "server"` and the reason ("pozastaveno serverem
  (nečinnost 30 min)").
- A hand-opened CLI's row is suspended, never closed, by a dropped
  connection or the transport's idle GC (`mcp/transport.ts` decides
  `disconnect` vs `idle` in the same `onclose`) and by
  `boot/session-sweep.ts` finding a `running` row from a dead process.
  `closeSessionIfRunning`/`closeStaleRunningSessionsOnBoot` keep their names
  but delegate to `suspendSessionServerSide`. `portuni_session_suspend` is
  the only channel such a CLI has to write its own handoff.

## The Claude adapter

`domain/runner/adapters/claude.ts` over `@anthropic-ai/claude-agent-sdk`,
pinned exact in `package.json` (no caret; bump deliberately, never via
`npm update`). Tested against an injected fake `query`/`exec`
(`test/runner-claude-adapter.test.ts`); a real logged-in run is macOS-only
human verification.

- **Streaming-input always.** `query()`'s `prompt` is a push queue
  (`createPushQueue`), even for a brief-only run: it is the only mode with
  `interrupt()`, queued messages and `answer()`.
- **Permissions** delegate to `permissions.ts` `decidePermission`, which
  needs `RunStart.portuniRoot`/`.mirrors` (threaded from the provisioned
  mirror by `startRun`). An "ask" decision emits a `question` event and
  leaves the `canUseTool` promise open until `RunHandle.answer()`: an
  approval allows on `true` only (`false` or text denies); an input
  question (AskUserQuestion) takes a string as
  `{behavior: "allow", updatedInput: {...originalInput, answer}}`. A
  question still open when the run ends is denied; one raised after the
  end is denied outright.
- **MCP elicitation** (`onElicitation`): a dialog whose form is exactly one
  boolean field (Portuni's scope and write confirmations) emits an
  `approval` question and waits on `RunHandle.answer()`: `true` accepts
  with that field `true`, anything else declines. A form with more fields,
  any non-boolean field or a `url` dialog is declined without a question:
  the chat shows only the dialog's message, so a second field would be
  granted unseen. An open dialog is cancelled when the run ends; when the
  SDK abandons it (its timeout, an interrupted turn) the adapter also
  emits the question again with a `system` decision, which the runtime
  reads as "closed without the user" and clears `waiting_since`.
- **One question at a time** (`askInTurn`): the runtime keeps a single
  pending question per session, so a permission ask or a dialog raised
  while another question is open waits in line and is emitted once that
  one is answered; the first ask in an empty line is emitted
  synchronously. The web sends `true`/`false` for the default Ano/Ne
  buttons (`approvalChoices`), never the label.
- **Inherited claude.ai Portuni connectors** are switched off with
  `toggleMcpServer` after init: `mcpServerStatus()` entries with scope
  `claudeai` whose upstream URL origin is `PORTUNI_CENTRAL_URL` or
  `PORTUNI_PUBLIC_URL`, matched by URL, never by the user's connector name.
  Until the toggle lands, `canUseTool` denies their tools by prefix
  (`mcpToolPrefix`). The run has its own `portuni` server, and a
  connector Portuni sends its dialogs to claude.ai.
- A write tool's `file_change` (`op: "create" | "edit"`) is decided from an
  `fs.stat` taken at `tool_call started` time and carried on the
  pending-tool-call snapshot; the tool result never carries the arguments.
- `RunHandle.pid()`: the adapter overrides `spawnClaudeCodeProcess` to
  capture `child.pid`; the child is spawned `detached` so
  `signalProcessGroup` reaches its helpers. The fake adapter's `pid()` is
  `null`.
- **`interrupt()` cancels the current turn only** (`Query.interrupt()`).
  Process, queue and run stay alive; the natural completion path reports
  `"completed"`. `FakeRunnerAdapter.interrupt()` is a no-op.
- **`close()`** ends the prompt stream and bounds a child that ignores it
  (`shutdownProcess`): `closeGraceMs` 2 s, `SIGTERM`, `closeTermMs` 5 s,
  `SIGKILL`, each step skipped once the run ends or the pid is dead.
  `close()`/`interrupt()` race `endedPromise` against
  `waitForPidDeadOrTimeout` (500 ms poll, 10 s bound, test-overridable)
  and abort the losing branch's `AbortController`; a null pid waits out the
  full timeout.
- **A `result` message can be a provider failure and it ends the run.** A
  spend/rate limit arrives as `subtype: "success"` with `is_error: true`
  and the text in `result`; `error_*` subtypes carry `errors: string[]`.
  Neither ends the CLI in streaming-input mode, so the adapter does:
  `providerResultFailure` classifies it (`reason: "limit"` when the
  subtype, `terminal_reason` or a `/limit/i` match says so, else
  `"error"`), the run emits one `error` event (`class: "provider"`), ends
  the queue, and `run_ended` carries that reason exactly once
  (`emitRunEnded`, idempotent). `endAfterProviderFailure` reuses
  `shutdownProcess` as the bound. The runtime then suspends the thread as
  for any other non-close end.
- `hooks.PreCompact` and `system/compact_boundary` both translate to a
  `compaction` event (possible double emission of a cosmetic marker,
  accepted).
- `translateStreamEvent` streams both channels: `text_delta` and
  `thinking_delta` become `DeltaFrame`s with `channel: "text"` /
  `"reasoning"` (`domain/runner/types.ts`). The persisted record stays the
  batched `assistant_message` / `reasoning` event; deltas are the live
  preview and are never persisted. Delta frames carry the real `run_id`.
  The first `thinking_delta` of a block stamps `reasoningStartedAt`; the
  batched `reasoning` event carries `duration_ms` from that stamp to
  itself and clears it. A thinking block without a streamed delta has no
  `duration_ms`.
- `detect()` runs `claude --version` and `claude auth status`, 5 s timeout
  each.
- **`turn_ended` on every successful result.** The CLI stays alive between
  turns, so this is the only signal that the agent stopped working; the
  web's working row, stop button and Escape key on a turn in flight
  (`turnInFlight`). A failed result ends the run instead and emits none.
- **`context_usage` after every assistant message and every result.**
  `contextUsageFrom` reads the message's `usage`: `used_tokens` =
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  (what the model's context holds), plus `input_tokens`, `cached_tokens`,
  `output_tokens` and the `model` the message named. `max_tokens` is
  `modelUsage[model].contextWindow` from the latest `result`, null until
  one arrived. The event is persisted like every other; the runtime's
  `handleAdapterEvent` also writes the latest pair onto
  `sessions.context_used_tokens` / `context_max_tokens` (migration 039;
  `PatchSessionInput`, central `PatchSessionBody`), so a list row and the
  chat header render the ring without reading the log. `run_ended.usage`
  stays as it was.
- **`models()` never starts a process.** A module-wide `modelsCache`
  starts `null` and is filled from the first live run's
  `Query.supportedModels()` (called inside the promise chain so a missing
  method rejects into the existing `.catch`); a failure leaves it `null`
  and the next run retries. Until then `models()` answers
  `CLAUDE_ALIAS_MODELS` (`sonnet`, `opus`, `haiku`, each
  `supportsEffort: false`). `GET /runners/:runner/models` just calls it.
  `FakeRunnerAdapter.models()` returns its constructor's `models` option.

## Thread lifecycle

- **Open = draft.** `POST /sessions` without `brief` creates a `draft` row
  (name „Nový úkol", no run) through `SessionRuntime.createDraft` in both
  workspaces. The runtime resolves the organisation's defaults first
  (`resolveDraftDefaults` = `resolveTaskDefaults` with "no runner" as a
  legal answer, both null) and the store only records: `DbSessionStore` in
  a personal workspace, `CentralSessionStore` ->
  `CentralClient.createDraftSessionRecord` (`POST /sessions/record` with a
  `{draft: true, node_id, model, effort, runner, instance_id}` body;
  `RecordSessionBody` is a two-shape union) in a team workspace.
- **Runner and instance are the thread's, chosen while it is a draft.**
  `PATCH /sessions/:id` accepts `runner`/`instance_id` from a client only
  while `state = 'draft'`; on any other state, without a `state` field in
  the same body, the route answers 409 `SESSION_NOT_DRAFT`. The promotion
  patch (`state: "running"` together with them) passes.
- **The first message promotes.** `sendMessage` with no live run:
  `draft` -> `promoteDraftAndStart`; `suspended` -> `resumeByWriting`; any
  other state refuses. Promotion uses the draft's own `runner`/`instance_id`
  and resolves them (`resolveTaskDefaults`: the first `detectAll()` runner
  with `installed && logged_in`, and the node organization's default
  instance for it; `NoRunnerAvailableError` -> `400 NO_RUNNER_AVAILABLE`)
  only when the draft carries none. Central's `PatchSessionBody` accepts
  the promotion fields (`brief`, `runner`, `instance_id`, `name_is_custom`).
- **Naming.** `threadNameFromFirstMessage` (`domain/sessions.ts`, mirrored
  by hand in `apps/web/src/lib/session-chat.ts`) takes the first line of
  the first message; promotion sets `name_is_custom = 1` so handoff-title
  enrichment at suspend never overwrites it. `computeDefaultSessionName`'s
  `node · date time` stays for rows with no first message
  (`interactive_chat`).
- Promotion appends `state_changed {from: "draft", to: "running"}` so the
  live channel's `session_state` broadcast fires (`sessions-ws.ts` reacts
  only to `state_changed`, `question`, `run_ended`).
- **A list carries the caller's own threads, nobody else's** (#463, #457).
  `GET /nodes/:id/sessions` and `GET /sessions?state=…` filter on
  `user_id = identity` for every state, drafts included, so a reload, a
  second window or any other surface of the same user shows a draft without
  a client-side draft map. `GET /overview` and the WS snapshot still list
  running and suspended threads only, by the states they ask for.
- **Prune.** `sweepStaleDraftSessionsOnBoot` deletes drafts older than 24 h
  at boot of the process that owns the graph db (`index.ts`, `desktop.ts`
  local branch; on the central server for team-workspace rows). A thread's `×` deletes
  an empty draft immediately.
- **Every non-close end suspends with a summary the DEVICE writes.**
  `closingSessions: Set<string>` marks an explicit close (`closeSession`,
  `continueSession`). In `handleAdapterEvent`'s `run_ended` branch, a run
  ending without that mark calls `suspendFallback` with `pendingEndReason`
  (`"run_ended"`, or `"idle"` from the idle sweep) and then appends the
  `handoff` event (`{path, hash}` off the suspended row).
  `withSuspendReason` rewrites an adapter-reported `"completed"` to
  `"suspended"` unless the session is closing; `error`/`limit`/`host_lost`
  pass through. `HandoffEvent.payload` is `{path, hash}` only. The central
  server never writes a summary of its own: it has no transcript to build
  one from (#458). A thread whose device disappears mid-run stays `running`
  until that device's own boot sweep ends it, and that sweep suspends it
  with no handoff. The central server's `sweepStaleRunningSessionsOnBoot`,
  `sweepStaleDraftSessionsOnBoot` and `sweepArchivedSessionsOnBoot` stay,
  as record maintenance.
- **Idle is the server's.** `boot/session-sweep.ts` `startIdleRunSweep`
  (60 s, unref'd; `PORTUNI_RUN_IDLE_MS`, default 30 min) drives
  `checkIdleRunsOnce`; `endIdleRun` sets `pendingEndReason: "idle"` and
  calls `close()` on the live handle. Wired in `index.ts` and in both
  branches of `desktop.ts` against the runtime instance that actually runs
  tasks there.
- **Resume is writing.** `resumeByWriting` uses `checkConversationResumable`
  to continue the CLI's own conversation when still valid; otherwise it
  reads `handoff_path`/`handoff_inline` and starts a fresh run with it as
  orientation (`resume: "handoff"` on `run_started`, `resumed_from_run_id`
  linking the runs). There is no `POST /sessions/:id/resume`,
  `/suspend`, no mode picker and no `SUSPEND_INSTRUCTION` handshake.
- **`POST /sessions/:id/continue`** (`continueSession`; `resume` access
  tier; also a `continue` WS frame) closes this session with its own
  log-derived summary and starts a fresh running one on the same node,
  returning `{session, run}` (the WS reply carries `toSummary`'s
  `SessionSummary`). Web labels: "Pokračovat v nové session" on an open
  thread, "Navázat" on a closed one.
- No context-usage ring exists: `RunEndedEvent.payload.usage` is
  adapter-reported and untyped, so nothing tracks tokens per thread.

## Model and effort resolution

- `sessions.model` / `sessions.effort` (nullable; `effort` CHECKed against
  `EFFORT_LEVELS`, a hand-mirrored copy of the SDK enum in
  `domain/runner/types.ts`). Migration 036 adds them; `PG_BASELINE_DDL`
  and migration 030's full-shape rebuild carry them and the `draft` state
  as well. A change to the `sessions` shape must land in all three places.
- `resolveModelAndEffort(session, instanceDefaults)` in `startRun`, first
  match wins: the thread's own column, else the instance `defaults`, else
  `null` (the runner's own default). Threaded onto `RunStart.model`/
  `.effort`; the adapter never reads config. The Claude adapter omits the
  option entirely when null.
- `POST /sessions/:id/model` (`{model?, effort?}`, at least one; `null`
  means "no override") is the one way the composer changes either. It calls
  `SessionRuntime.setModelAndEffort`, which forwards a model change to the
  live run (`RunHandle.setModel` -> `q.setModel`, no-op after the run ended
  or when there is no live run) and then persists both columns through the
  store. `effort` has no live setter and applies from the next run only;
  there is no `setEffort`.
- That route is **device-local** (`device-local-routes.json`, #426): the
  live run only ever exists in the process driving it, which in a team
  workspace is the sync agent, never the central server. The device's
  runtime applies the change to the live run and its `CentralSessionStore`
  writes the record half on central (a `PATCH /sessions/:id`), so one code
  path covers both kinds of workspace. `PATCH /sessions/:id` still accepts
  `model`/`effort` as plain columns -- that is exactly what the store
  forwards -- but it never touches a live run.
- `SessionSummary` carries `model` and `effort`.

## Provider instances

`domain/runner/instances.ts` owns `<dataDir>/runners.json`
(create/update/delete/`setOrgDefault`), served by `api/runners.ts`
(`GET /runners`, `/runners/instances` CRUD, `PUT .../org-default`,
`DELETE /runners/org-defaults/:orgId`, `GET /runners/:runner/models`).

- **Device-local in every mode.** `is_device_local_path` routes every
  `/runners*` call to the sync agent; `agent-router.ts` mounts the same
  handlers, mutations behind `guardAgentRestWrite`. Central's own registry
  would describe the central host, not the machine running the task.
- Env values never reach a client (`env_keys` only); an empty submitted
  value for a known key means "leave unchanged". Secret-shaped keys
  (`shared/runner-env.ts` `isSecretShapedEnvKey`) and `PORTUNI_*` keys are
  refused with `INSTANCE_ENV_KEY_REFUSED`. A leading `~` expands to `$HOME`
  only when `getInstanceEnv` reads the value for a run.
- `defaults: { model?, effort? }`: an unknown key or invalid effort throws
  `InstanceDefaultsKeyRefusedError`; `updateInstance` replaces `defaults`
  wholesale, unlike `env`'s per-key merge.
- A run's instance lands in `sessions.instance_id`. An old desktop
  `config.json` with a `profiles` key loads; the key is ignored and dropped
  on save.

## Live channel, server side

`GET /sessions/ws` (`apps/server/api/sessions-ws.ts`) is the only WebSocket
in the codebase. The desktop bridge is documented with the desktop shell.

- Auth happens once at the `http.Server` `"upgrade"` event
  (`http/server.ts`) via `checkUpgradeAuth` (`http/middleware.ts`): host
  allowlist plus bearer/JWT identity, a refusal written as a raw HTTP
  response before the socket is destroyed. A plain GET without `Upgrade`
  gets 426 from the normal request path. The upgrade applies
  `minScopeForRoute` (`read`).
- `message`, `answer`, `interrupt`, `close`, `continue`, `handoff` frames need `write`
  scope (`FORBIDDEN`) and, with `PORTUNI_WEBVIEW_PROXY_SECRET` set, an
  upgrade that carried the proven `X-Portuni-Webview-Proxy` header
  (`UpgradeContext.webviewProven`, else `WEBVIEW_PROXY_REQUIRED`). The same
  posture gates every mutating `/sessions*` REST route on the local router
  (`guardRestSessionWrite` in `routeSessions`).
- Every frame goes through the same `sessionAccess` tier and the same
  `SessionRuntime` method as its REST twin. A refused action is an
  `{id, type: "error", payload: {code, message}}` frame, never a closed
  socket.
- **Mounted in both kinds of workspace** through `SessionsWsDeps` (`runtime`, `access`,
  `snapshot`, `canSee`): `createLocalSessionsWsDeps()` over the graph db;
  `agentMain` passes `createSessionsWsServer(createAgentSessionsWsDeps(
  client, runtime))` with the same runtime instance its router drives. The
  sync-agent snapshot is `GET /sessions?state=running,suspended&limit=500`
  on the central server (`CentralClient.listSessionRecords`), which answers
  with the device user's own records; the local snapshot is the same query
  against the graph db, bounded by the same `SNAPSHOT_LIMIT`.
- `subscribe` subscribes to the runtime first, replays
  `store.listEvents(after)` in pages of 200, buffers live events meanwhile
  and flushes them skipping any `seq` the replay covered. A published
  canonical event carries the `seq` the store assigned
  (`PublishedEvent = (CanonicalEvent & {seq}) | DeltaFrame`,
  `appendAndPublish`).
- `session_state` fans out to every connection whose identity owns the
  session (`canSee`, the same one-line rule) through one server-lifetime
  `subscribe("*", ...)` per `WebSocketServer`, created lazily on the first
  connection, and a broadcast resolves visibility once per identity. A test
  must keep one runtime and re-register the fake adapter between cases
  (`test/api-sessions-ws.test.ts`), or that subscription sticks to an
  abandoned instance. `SessionRuntime.subscriberCount(target)` exists for
  leak checks.

## Known gaps

- There is no `hosts` registry: a host has a label only where it is the
  machine asking (`resolveHostLabel`), so a teammate's device read off the
  central server shows its id. Registration, heartbeat, capabilities and
  choosing where a task runs are still only in the remote-hosts spec.

## See also

- `docs/superpowers/specs/2026-09-12-runner-and-session-design.md`
- `docs/superpowers/specs/2026-09-15-task-surface-design.md`
- `docs/superpowers/specs/2026-09-12-remote-hosts-and-task-queue-design.md`
- `docs/architecture/data-modes.md`
