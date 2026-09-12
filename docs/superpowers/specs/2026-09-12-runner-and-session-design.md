# Runner and session: the task replaces the terminal

A session is the unit of work (a task). It runs in a foreign runner
connected through an adapter, is rendered as a chat built from canonical
events Portuni stores, and survives runner restarts through handoff. The
embedded PTY terminal, the kernel sandbox and the profile-as-spawn-env
mechanism retire with it.

Vision: `docs/vision/portuni-as-workspace.md` (Úkol a relace, Runner a místo
běhu, Local vs. central). Prior spec this builds on:
`docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md`
(persistent sessions, handoff, externalized compact). Plan context:
`docs/superpowers/plans/2026-09-12-infra-batch.md` (this work runs in
parallel with batch A; batch B changes the database driver, see Storage).

## Scope

In:

- Runner interface and canonical event model in the server domain.
- First adapter: Claude Code through `@anthropic-ai/claude-agent-sdk`,
  spawned by the sidecar on this machine.
- Session as task: brief, runner, instance, "waiting for me" state, runs
  under a session, events per session.
- Chat in Práce (replaces the terminal canvas), task creation from the
  node detail, Relace tab and Přehled reading the new states.
- Suspend and resume actually wired end to end (today resume exists only
  server-side).
- Removal of PTY, xterm, Seatbelt + hardlink projection, profile env
  injection into shells, agent-command presets, terminal close guard.

Out (later plans): host reachable through central and the task queue
(step 2), Codex and OpenCode adapters (step 2), Asana (step 3), routines
and skills (step 4). Central-mode teammates keep using hand-opened CLIs in
mirrors until step 2; the materialized per-mirror configs stay for that.

## Rules

1. **One implementation.** The session runtime is server-domain code that
   runs in the sidecar in both data modes. Storage sits behind
   `SessionStore`; local mode binds it to the database, central mode to a
   thin HTTP client against the same endpoints on central. No logic lives
   in the client.
2. **The session exists before the runner.** Today the row is a side effect
   of the MCP handshake. Now the runtime creates the session, then starts a
   run whose MCP connection carries the session id in
   `X-Portuni-Spawn-Id`; the handshake binds to the existing row.
3. **Events are the record; deltas are not.** Everything the UI shows after
   a reload comes from `session_events`. Streamed text deltas travel only
   on the live channel. Tool output is stored truncated; the runner's own
   transcript keeps the rest.
4. **The runner owns the conversation; Portuni owns the task.** Auto-compact
   stays in Claude Code. Portuni's compaction is the handoff: suspend →
   handoff → new run with context provisioned by code.
5. **Permissions are enforced in the adapter, not in files.** The write
   tiers from `write-scope.ts` (`classifyWrite`) decide in the SDK
   permission callback. `.claude/settings.local.json`, `PORTUNI_SCOPE.md`
   and the guard hook stay for hand-opened CLIs only.
6. **No secret leaves the sidecar process.** MCP token and instance env go
   into SDK options in memory. The webview sees event payloads and names,
   never env values.

## Model

### Session (task)

`sessions` gains: `brief TEXT` (the task as given), `runner TEXT`
(adapter id, `claude` for now), `instance_id TEXT` (replaces the meaning of
`profile_id`; the column is renamed), `host_id TEXT` (the device/workspace
that runs it; this machine until step 2), `waiting_since TEXT NULL`.

State machine unchanged: `running ↔ suspended → closed → archived`. UI
status derives from it:

| state | waiting_since | label |
|---|---|---|
| running | null | Běží |
| running | set | Čeká na mě |
| suspended | – | Pozastaveno |
| closed | – | Hotovo |
| archived | – | Archiv |

`waiting_since` is set when a `question` event opens and cleared when it is
answered or the run ends. `terminal_id` and `closeSessionsByTerminalId` go
(no PTY to correlate); `agent_session_id` moves to runs.

### Run

`session_runs`: `id` (ULID), `session_id`, `runner`, `instance_id`,
`host_id`, `agent_session_id TEXT NULL` (the runner's own conversation id,
Claude session id), `resumed_from_run_id NULL`, `started_at`, `ended_at
NULL`, `end_reason NULL` (`completed | interrupted | suspended | error |
limit | host_lost`), `usage TEXT NULL` (JSON: input/output tokens, cost if
reported).

A session has zero or more runs; at most one is live. A handoff resume
creates a new run; a conversation resume (`Pokračovat`) also creates a new
run with `resumed_from_run_id` and the same `agent_session_id`.

### Events

`session_events`: `id` (ULID), `session_id`, `run_id`, `seq INTEGER`
(monotonic per session, assigned by the store), `kind`, `payload TEXT`
(JSON), `created_at`. Index `(session_id, seq)`. Append-only.

Kinds, narrowed from T3 Code's canonical items to what the chat and the
task need:

| kind | payload |
|---|---|
| `run_started` | `{ run_id, runner, instance_id, resume: null \| "conversation" \| "handoff" }` |
| `run_ended` | `{ run_id, reason, usage }` |
| `user_message` | `{ text, source: "chat" \| "system" }` (system = orientation, suspend instruction, handoff pointer) |
| `assistant_message` | `{ text }` (complete message) |
| `reasoning` | `{ summary }` (only when the runner exposes one) |
| `tool_call` | `{ tool_use_id, tool, category: "command" \| "file_read" \| "file_change" \| "mcp" \| "other", title, input_summary, status: "started" \| "completed" \| "failed", output_excerpt, truncated: boolean }` — one event on start, one on completion, correlated by `tool_use_id` |
| `file_change` | `{ path, op: "create" \| "edit" \| "delete" \| "rename" }` derived from completed write tools; the Files tab links here |
| `question` | `{ request_id, type: "approval" \| "input", tool, title, detail, options: string[] \| null, decision: null \| { by, value, at } }` |
| `compaction` | `{ trigger: "auto" \| "manual" }` |
| `handoff` | `{ path, hash, generated_by: "agent" \| "server" }` |
| `state_changed` | `{ from, to, waiting: boolean }` |
| `error` | `{ class: "provider" \| "transport" \| "permission" \| "unknown", message }` |

Payload caps: `output_excerpt` 8 KB, `assistant_message.text` 64 KB,
`input_summary` 1 KB. Larger content is truncated with `truncated: true`.
There is no separate "activity" or "message" split; the chat renders the
event list.

### Live channel

`GET /sessions/:id/stream?after=<seq>` (SSE, on the sidecar): replays
persisted events after `seq`, then streams new events and `delta` frames
(`{ run_id, text }` for the assistant message in progress, not persisted).
`GET /sessions/stream` (SSE) carries `state_changed` and `question` events
for every session the caller can see, for the Relace tab, Práce sidebar and
Přehled without polling.

The webview does not open HTTP itself (security rule 3): Rust commands
`session_subscribe(session_id)` / `session_unsubscribe` hold the SSE
connection to the sidecar and re-emit frames to the calling window as
`session-event` (same per-window shape as `backend-ready`). The Vite dev
build connects directly, like `api.ts` does for REST.

## Runtime

`apps/server/domain/runner/`:

- `types.ts`: `CanonicalEvent` (the table above), `RunnerAdapter`,
  `RunHandle`, `RunStart`, `PermissionPolicy`, `RunnerAvailability`.
- `session-runtime.ts`: the only writer of runs and events. `startTask`
  (create session → provision → start run), `sendMessage`, `answer`,
  `interrupt`, `suspend`, `resume`, `closeSession`. Holds the map of live
  runs per session. Applies `waiting_since` and `state_changed`. Fans out
  to SSE subscribers.
- `provision.ts`: what the spawn path does today minus the terminal:
  ensure the mirror exists (`createNodeMirror`), build the orientation
  (`buildOrientationHint`, plus the handoff pointer on resume), resolve the
  MCP URL and token (`resolvePortuniMcpUrl`, sidecar bearer), resolve the
  instance env.
- `permissions.ts`: the `PermissionPolicy` decision function shared by
  adapters: input is `{ tool, input, cwd, sessionScope }`, output is
  `allow | deny(message) | ask(question)`. Rules: write tools
  (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) → `classifyWrite` tier 1
  allow, tier 2/3 deny with the tier message; `Bash` → allow (parity with
  today, where the guard hook never inspected shell writes; recorded as a
  known gap); `mcp__portuni__portuni_expand_scope` → ask (approval) unless
  the session policy is `auto`; `AskUserQuestion` → ask (input);
  `ExitPlanMode` → ask (approval); everything else allow. `ask` becomes a
  `question` event and blocks the callback until answered or the run ends.
- `adapters/claude.ts`: below.
- `adapters/fake.ts`: a scripted adapter for tests (emits a given event
  sequence, honours interrupt/close).
- `registry.ts`: adapters by id; `detect()` on each at boot and on
  `GET /runners`.
- `instances.ts`: provider instances (today's profiles) move here as
  server-side config in `<dataDir>/runners.json`: `{ id, name, runner,
  env: Record<string,string>, org_defaults }`. Same rules as before:
  secret-shaped keys refused, `PORTUNI_*` keys refused, `~` expanded, env
  values never returned to the webview (`env_keys` only). The Rust
  `ProfileConfig` registry and its six commands are deleted; the web talks
  to `GET/POST/PATCH/DELETE /runners/instances` through `api_request`.

### Runner interface

```ts
interface RunnerAdapter {
  id: "claude";
  detect(): Promise<RunnerAvailability>;  // { installed, version, logged_in, instances_supported }
  start(run: RunStart, sink: EventSink): Promise<RunHandle>;
}
interface RunStart {
  sessionId: string; runId: string; cwd: string;
  brief: string | null;                    // first user message on a fresh run
  resume: null | { agentSessionId: string; at?: string };
  orientation: string;                     // appended to the runner's system prompt
  instance: { id: string | null; env: Record<string, string> };
  mcp: { url: string; token: string; homeNodeId: string };
  policy: PermissionPolicy;
}
interface RunHandle {
  send(text: string): Promise<void>;       // next user message (queued mid-turn)
  answer(requestId: string, decision: QuestionDecision): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;                  // graceful end of the process
  agentSessionId(): string | null;
}
type EventSink = (event: CanonicalEvent | DeltaFrame) => void;
```

### Claude adapter

- `query({ prompt: userMessages, options })` in streaming-input mode: the
  prompt is an async iterable fed by `send()`; this is what makes
  `interrupt()`, queued messages and `answer()` possible.
- Options: `cwd` = mirror; `systemPrompt: { type: "preset", preset:
  "claude_code", append: orientation }`; `mcpServers: { portuni: { type:
  "http", url, headers: { Authorization: Bearer <token>, "X-Portuni-Spawn-Id":
  sessionId } } }`; `settingSources: ["user"]` (the person's own global
  settings and skills; project files are not read, so the materialized
  `.mcp.json` does not register the server twice); `includePartialMessages:
  true`; `permissionMode: "default"` with `canUseTool` delegating to
  `permissions.ts`; `env` = `{ PATH, HOME, ...instance.env }` (the SDK
  replaces the environment, so PATH and HOME are passed explicitly; HOME is
  never overridden because the CLI login lives in the Keychain under it;
  `CLAUDE_CONFIG_DIR` from the instance selects the account); `resume` /
  `resumeSessionAt` on a conversation resume; `hooks`: `PreCompact` →
  `compaction` event.
- Translation: `system/init` → `run_started` + `agentSessionId`;
  `assistant` text blocks → `assistant_message` on completion, deltas from
  `stream_event`; `tool_use` → `tool_call started`; the matching
  `tool_result` → `tool_call completed|failed` + `file_change` for write
  tools; `canUseTool` ask → `question`; `result` → per-turn usage folded
  into the run; `system/compact_boundary` → `compaction`; process exit →
  `run_ended`.
- Process lifecycle: one child per live run, in its own process group;
  `close()` = end stdin, 2 s, SIGTERM, 5 s, SIGKILL (the SDK's own
  sequence). The runtime writes `<dataDir>/runs/<runId>.pid`; the boot
  sweep kills any pid whose run has no `ended_at` and marks the run
  `host_lost`, then applies the existing handoff-less close rule
  (server-generated handoff, session → `suspended`).
- Auth is the CLI login on this machine. `detect()` reports `logged_in`
  from `claude auth status`; a run started while logged out fails with an
  `error` event whose message says so. Portuni never offers a Claude
  login of its own (Anthropic's third-party rule).
- Version pinned exactly in `package.json`; the SDK releases daily and has
  broken embedding twice in 2026.

### Suspend and resume

- **Pozastavit**: the runtime sends the suspend instruction as a
  `user_message` (source `system`), waits up to 30 s for the agent's
  `portuni_session_suspend` (which writes the handoff and flips the state,
  as today), then `close()`s the run. If no handoff arrived, the server
  generates one from the session record (phase 2b) and suspends. Either
  way a `handoff` event is appended.
- **Nahodit**: `GET /sessions/:id/resume-info` decides as today.
  *Pokračovat* starts a run with `resume`; *Předat a začít znovu* starts a
  fresh run whose orientation carries the handoff pointer (externalized
  compact). Both are one `POST /sessions/:id/resume { mode }`.
- The restart indicator becomes a session signal (`expansions since run
  start`, `write-set growth`, run age) rendered in the chat header with the
  "Předat a začít znovu" action; no terminal pane to host it.
- Closing the window does not touch runs: they belong to the sidecar. The
  window close guard keeps only the dirty-editor and unsynced-files checks.

## API

Local-only in central mode (added to `is_local_only_path` and served by
the agent router with the runtime; the record half goes to central through
`CentralSessionStore`):

- `POST /sessions` `{ node_id, brief, runner, instance_id?, policy? }` →
  session + first run. `session_type` = `interactive_task`.
- `POST /sessions/:id/messages` `{ text }`; `POST /sessions/:id/questions/:request_id`
  `{ decision }`; `POST /sessions/:id/interrupt`; `POST /sessions/:id/suspend`;
  `POST /sessions/:id/resume { mode }`; `POST /sessions/:id/close`.
- `GET /sessions/:id/events?after&limit`, `GET /sessions/:id/stream`,
  `GET /sessions/stream`.
- `GET /runners` (adapters + availability), `GET|POST|PATCH|DELETE
  /runners/instances`.

Central (record half, also what local mode's `DbSessionStore` does in
process): `POST /sessions` (record only), `PATCH /sessions/:id` (state,
waiting, name), `POST /sessions/:id/runs`, `PATCH /sessions/:id/runs/:run_id`,
`POST /sessions/:id/events` (batch append, returns assigned `seq`s),
`GET /sessions/:id/events`. Existing `GET /nodes/:id/sessions` and
`/overview` gain `brief`, `waiting_since`, `runner`.

Removed: `POST /terminals/:id/exit`, `GET /sandbox-profile`,
`GET /nodes/:id/sandbox-profile`, `X-Portuni-Profile` and
`X-Portuni-Terminal` headers.

## Web

- **Práce** (`WorkspaceView.tsx`): the centre is `SessionChat` when the
  selected node has an open session, else the node detail as today.
  `SessionChat`: header (name, status chip, runner · instance, restart
  indicator, actions Pozastavit / Přerušit / Uzavřít), event list (user and
  assistant messages, tool calls collapsed to `title` with expand,
  `file_change` rows linking to the Files tab, compaction and handoff
  markers), question panel above the composer when `waiting_since` is set
  (approval buttons or input field; answering clears it), composer
  (disabled while suspended, with Nahodit instead).
- **New task** (`DetailPane.files.tsx`, replaces `TerminalSplitButton`):
  „Nový úkol": brief, runner (from `GET /runners`, only those
  `installed && logged_in`), instance when ≥2 exist (default per
  organization from `org_defaults`), start → opens the chat in Práce.
- **Relace tab** (`DetailPane.sessions.tsx`): rows show status chip, brief
  (first line), runner · instance, last activity; actions Otevřít chat,
  Pozastavit, Nahodit (both modes), Zobrazit handoff, Uzavřít.
- **Práce sidebar** (`WorkspaceNodeList.tsx`): session sub-rows with the
  status chip; activity from `session-event` frames, not from PTY bytes.
- **Přehled** (`OverviewView.tsx`): the Relace card becomes the inbox: Čeká
  na mě first, then Běží, then Pozastaveno; click opens the chat.
- **Nastavení › Runnery** (replaces Profily and Příkaz agenta): detected
  runners with version and login state; instances list (name, runner, env
  keys, default per organization) editing through `/runners/instances`.
- **Removed**: `TerminalPane`, `TerminalTabs`, xterm packages and font,
  `lib/session-suspend.ts`, `lib/prompt.ts`, `AGENT_PRESETS`,
  `TERMINAL_PRESETS`, `ProfilesSection.tsx`, `lib/profiles.ts`, the
  terminal close guard in `App.tsx`, `AnsiPalette`, `StatusFooter`'s PTY
  count (becomes running-session count from `/sessions/stream`).

## Desktop (Rust)

- Add `session_subscribe` / `session_unsubscribe` (SSE bridge to the
  window), nothing else new.
- Remove `pty.rs` (keep `ensure_device_token`, moved to `auth.rs`, label
  renamed to "Sync agent"), `PtyState`, `pty_*` commands, `launch_claude_for_node`,
  `ProfileConfig` + the six profile commands, `resolve_profile_env`,
  Seatbelt wiring, `portable-pty` and its transitive crates, the
  `/sandbox-profile` entries in `is_local_only_path`, the terminal branch of
  the close/quit sequence.
- Sidecar env: `PATH` must include where `claude` is installed (today's
  `PATH` pass-through already does); nothing else changes.

## Server removals

`domain/sandbox-profile.ts`, `session-projection.ts`, `disk-projection.ts`,
`read-file-spill.ts` (the `as_path` spill of `portuni_read_file` moves to a
plain temp file under the session's data dir; the 1 MB inline cap stays),
`boot/session-projection-sweep.ts`, the projection branches in
`get-node.ts` / `context.ts` / `files.ts` / `expand_scope` /
`agent-transport.ts`, `readableMirrorRoot` returns the real mirror path or
null. `scripts/portuni-run.sh`. In `scope-materialize.ts`: `.vibe/config.toml`
and `.cursor/rules` writers; the `X-Portuni-Profile` / `X-Portuni-Terminal`
headers in `buildClaudeMcpJson`. Tests of the removed modules go with them.

## Storage and batch B

New tables and columns land as libsql migration 035 now. Batch B's
Postgres baseline (plan B2) is written from the schema after 035 and must
include them; the export/import tool (B5) carries `session_runs` and
`session_events`. Whichever branch merges second updates the other.
`session_events` is the first table that grows with use; the baseline
gives it `(session_id, seq)` as primary key and `created_at` for retention.
Retention: events of `archived` sessions older than 90 days are deleted by
the existing auto-archive sweep; the handoff file stays.

## Testing

- Runtime with the fake adapter: start → events persisted with monotonic
  `seq`; question sets and clears `waiting_since`; interrupt; suspend with
  and without an agent handoff; resume both modes; boot sweep on a stale
  pid; SSE replay from `after`.
- Claude adapter against an injected fake `query` (the SDK function is a
  constructor parameter): message translation for every kind, deltas,
  `canUseTool` → question round trip, `close()` sequence, env composition
  (HOME untouched, instance env merged, `PORTUNI_*` refused).
- `permissions.ts` table tests over the write tiers and the ask set.
- Instances store: secret-shaped and `PORTUNI_*` keys refused, env never in
  the list response.
- API round trips in both modes (`test/central/*` fake central for the
  record half).
- Web: typecheck + build (no browser tests, as today).
- Human, macOS: a real task on a node with a logged-in `claude`, suspend
  from the chat, Nahodit both ways, window close leaves the run alive,
  kill -9 the sidecar and check the boot sweep.

## Phases (sandcastle batches)

1. **Server**: types, runtime, permissions, fake adapter, instances store,
   storage (migration 035, `DbSessionStore`, `CentralSessionStore`), API,
   SSE. Ships without UI; verifiable through REST and tests.
2. **Claude adapter**: the real adapter behind the same tests, `GET /runners`
   detection, pid sweep.
3. **Web + Rust bridge**: `SessionChat`, new task, Relace, sidebar,
   Přehled, Nastavení › Runnery, `session_subscribe`. The terminal is still
   present in this phase behind the old button so both can be compared on
   a real node.
4. **Removal**: everything under Web/Desktop/Server removals, `CLAUDE.md`
   and docs site (`clients/desktop-app`, `guides/working-in-the-app`,
   `concepts/scope-enforcement`, `reference/scope`, `clients/claude-code`).
5. **Docs audit** of the remaining terminal vocabulary.

## Known gaps, accepted

- `Bash` writes are not tier-checked (same as today). A later change can
  route shell commands through an approval when the session policy asks
  for it.
- Anthropic's stance on subscription use from third-party harnesses may
  change; the adapter uses the CLI's own login and nothing else, which is
  the most defensible position available.
- Central-mode teammates get the chat only in step 2; until then their
  sessions are hand-opened CLIs and show up in Relace as before.
