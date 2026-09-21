# Sessions and the runner

A session is the unit of agent work on a node: a `sessions` row that exists
before any process runs, a task layer underneath it (`session_runs`,
`session_events`), one runtime implementation that always executes on the
device, and a store seam that decides whether that runtime writes to the
local graph db or to the central server. An agent runs only as a task
(`POST /sessions`, the SessionChat surface) or as a hand-opened CLI that
connects over MCP; there is no embedded terminal, PTY or sandbox profile.
Specs: `docs/superpowers/specs/2026-09-12-runner-and-session-design.md`,
`docs/superpowers/specs/2026-09-15-task-surface-design.md`.

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
  `brief`/`runner`/`host_id`/`waiting_since`/`instance_id`/`model`/`effort`;
  each attempt to run the task is a `session_runs` row; the canonical,
  append-only transcript is `session_events`. `domain/runner/store.ts`'s
  `SessionStore` (`DbSessionStore`, `CentralSessionStore`) is the only
  writer of runs and events. Every event kind and payload is in
  `domain/runner/types.ts`'s `CanonicalEvent` union.

### States

`domain/sessions.ts` `ALLOWED_TRANSITIONS`:

| from | to |
|---|---|
| `draft` | `running` (deletion is the only other exit, `deleteDraftSession`) |
| `running` | `suspended`, `closed` |
| `suspended` | `running`, `closed` |
| `closed` | `archived` |

`closed` is reached only by the user's explicit Uzavřít (or `continue`, see
below) and `archived` only by the auto-archive sweep. Everything else that
ends a run suspends.

## Access tiers

`auth/session-access.ts` `sessionAccess(identity, sessionId, action)` with
actions `read | message | stop | resume` (spec: remote-hosts-and-task-queue,
"Visibility and control"):

- A node-anchored session hidden from the caller is `SESSION_NOT_FOUND`
  (404) for every action, manage scope included.
- A visible session with an insufficient tier is `SESSION_FORBIDDEN` (403):
  `message` and `resume` require ownership; `stop` (interrupt, close)
  requires ownership or manage scope; `read` requires seeing the node.
- A node-less session (`interactive_chat`) is `SESSION_FORBIDDEN` for anyone
  but the owner.
- A stop by someone other than the owner appends a `state_changed` event
  carrying `by` (`SessionRuntime.recordStoppedBy`) so the chat shows who.
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
| `store` | `DbSessionStore` on this server's db (`boot/session-runtime.ts` `getSessionRuntime()`) | `CentralSessionStore` (`domain/runner/store-central.ts`), built by `createAgentSessionRuntime` for `createAgentRouter(client, { sessionRuntime })` |
| provisioning | `provision.ts`: `createMirrorForNode`, `orientationForNode` (direct db read) | `provision-central.ts`: `createMirrorForNodeCentral`, `CentralClient.orientation` (`GET /nodes/:id/orientation`) |
| `suspendFallback` | `suspendSessionServerSide(db, id, reason)` | `domain/runner/suspend-fallback-central.ts`: writes the same handoff into the device mirror (scope sections from `CentralClient.sessionScopeRecord`), registers it record-only and patches the record over REST |
| `resolveNodeOrgId` | `belongs_to` graph query (a failed lookup is distinguishable from "no organization") | `CentralClient.nodeOrganizationId` (`GET /nodes/:id`, the outgoing `belongs_to` peer that is an organization) |
| `session_scope` reads (`getSessionScope` in `startRun`/`sessionSignals`) | real | degrade to an empty scope, never throw |

- `CentralSessionStore` turns every `SessionStore` call into a REST round
  trip to the central server's record half (`api/sessions.ts`: `POST /sessions/record`,
  `GET`/`PATCH /sessions/:id`, `POST /sessions/:id/runs`,
  `PATCH /sessions/:id/runs/:run_id`, `GET /sessions/:id/runs`,
  `POST`/`GET /sessions/:id/events`), which are thin wrappers over
  `DbSessionStore` on the central server's own db. It batches `appendEvents` within a
  50 ms window into one POST and keeps an in-process `runId -> sessionId`
  map (filled by `createRun`/`listRuns`) because `patchRun(runId, patch)`
  carries no session id.
- `PATCH /sessions/:id` has two shapes: `{name}` alone is a rename and
  returns `SessionSummary`; any other field (`state`, `waiting_since`,
  `handoff_path`, `handoff_hash`, promotion fields) returns the raw
  `SessionRow`, because the runtime reads columns the summary lacks.
- A resolver error in `resolveNodeOrgId` degrades to "no organization" and
  never fails a promotion; it logs one warning naming the node, only when
  the fallback is visible (two or more instances for that runner and some
  org default configured).
- The team-workspace suspend fallback writes the same summary the personal
  one does (#427). `session_scope` and the node's name are graph-db reads,
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

`is_local_only_path` (`apps/desktop/src/lib.rs`) sends to the device's sync
agent (`api/agent-router.ts`): bare `POST /sessions`, and per-session
`messages`, `interrupt`, `continue`, `close`, `events`, `signals`,
`questions/:request_id`. The record half stays on the central server: bare
`GET`/`PATCH /sessions/:id`, `/state`, `/resume-info`, `/scope`,
`/runs...`, `/sessions/record`, plus `GET /nodes/:id/sessions` and
`/overview`.
`signals` is device-local because it reads in-memory live-run state
(`liveRuns`, `runStartScopeSize`) that exists only in the process running
the task. A new per-session verb must be added to `router.ts`,
`agent-router.ts`, `is_local_only_path`, `min-scopes.ts` and, when it is a
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
    `run_ended {reason: "host_lost"}`, suspend with reason `host_lost`
    (Relace label "proces osiřel po restartu") and append a `handoff` event.
- A pid file is only ever found by the next boot of the same process on the
  same machine. Both kinds of workspace run the sweep: `index.ts` and `desktop.ts`'s
  local branch call `sweepOrphanedRunsOnBoot` (`localRunSweepBackend`,
  resolves the run by id in `session_runs`); `desktop.ts`'s `agentMain`
  calls `sweepOrphanedRunsOnBootCentral(new CentralSessionStore(client))`
  (`centralRunSweepBackend`, resolves via `store.listRuns(session_id)`,
  suspends via `createSuspendFallbackCentral`).
- Server-side suspend (`domain/session-handoff.ts`
  `suspendSessionServerSide(db, sessionId, reason)`, `ServerHandoffReason`
  = `disconnect | idle | terminal_exit | boot_sweep | suspend_timeout |
  host_lost | run_ended | continue`) writes a minimal handoff into the
  session's home mirror when this device has one, else into
  `sessions.handoff_inline`; `getResumeInfo` reads whichever is populated.
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
  leaves the `canUseTool` promise open until `RunHandle.answer()`:
  `true`/`false` are allow/deny, any other value becomes
  `{behavior: "allow", updatedInput: {...originalInput, answer}}`. A
  question still open when the run ends is denied; one raised after the
  end is denied outright.
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
- `detect()` runs `claude --version` and `claude auth status`, 5 s timeout
  each.
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
  (name „Nový úkol", no runner, no run). Locally the route writes through
  `createDraftSession`; in sync-agent mode `SessionRuntime.createDraft` goes
  through `SessionStore.createDraft` (`CentralSessionStore` ->
  `CentralClient.createDraftSessionRecord`, the same `POST /sessions/record`
  with a `{draft: true, node_id, model, effort}` body; `RecordSessionBody`
  is a two-shape union).
- **The first message promotes.** `sendMessage` with no live run:
  `draft` -> `promoteDraftAndStart`; `suspended` -> `resumeByWriting`; any
  other state refuses. Promotion resolves the runner itself
  (`resolveTaskDefaults`: the first `detectAll()` runner with
  `installed && logged_in`, and the node organization's default instance
  for it; `NoRunnerAvailableError` -> `400 NO_RUNNER_AVAILABLE`). There is
  no picker before the first message. Central's `PatchSessionBody` accepts
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
- **Every list excludes drafts** (`GET /nodes/:id/sessions`, `GET /overview`,
  the WS snapshot). A draft is visible only in the window that created it.
- **Prune.** `sweepStaleDraftSessionsOnBoot` deletes drafts older than 24 h
  at boot of the process that owns the graph db (`index.ts`, `desktop.ts`
  local branch; on the central server for team-workspace rows). A thread's `×` deletes
  an empty draft immediately.
- **Every non-close end suspends with a server-written summary.**
  `closingSessions: Set<string>` marks an explicit close (`closeSession`,
  `continueSession`). In `handleAdapterEvent`'s `run_ended` branch, a run
  ending without that mark calls `suspendFallback` with `pendingEndReason`
  (`"run_ended"`, or `"idle"` from the idle sweep) and then appends the
  `handoff` event (`{path, hash}` off the suspended row).
  `withSuspendReason` rewrites an adapter-reported `"completed"` to
  `"suspended"` unless the session is closing; `error`/`limit`/`host_lost`
  pass through. `HandoffEvent.payload` is `{path, hash}` only.
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

- **Device-local in every mode.** `is_local_only_path` routes every
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
- `message`, `answer`, `interrupt`, `close`, `continue` frames need `write`
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
  on the central server (`CentralClient.listSessionRecords`), visibility-filtered
  there; the local snapshot is bounded by the same `SNAPSHOT_LIMIT`.
- `subscribe` subscribes to the runtime first, replays
  `store.listEvents(after)` in pages of 200, buffers live events meanwhile
  and flushes them skipping any `seq` the replay covered. A published
  canonical event carries the `seq` the store assigned
  (`PublishedEvent = (CanonicalEvent & {seq}) | DeltaFrame`,
  `appendAndPublish`).
- `session_state` fans out to every connection that can see the session
  (`api/overview.ts` `filterSessions`'s rule) through one server-lifetime
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
