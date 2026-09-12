# Codex and OpenCode adapters: two more runners behind one interface

Two adapters for the `RunnerAdapter` interface from
`2026-09-12-runner-and-session-design.md`: Codex through its app-server
(JSON-RPC over stdio), OpenCode through its HTTP server and SDK. Same
canonical events, same permission policy, same suspend and resume. The
UI does not change.

Step 2 of the runner plan; depends on step 1 (runtime, `permissions.ts`,
the fake adapter and the Claude adapter as the reference). Protocol facts
verified 2026-09-12 against the vendors' docs
(`learn.chatgpt.com/docs/app-server`, `opencode.ai/docs/server`,
`/sdk`, `/permissions`, `/skills`, `/mcp-servers`).

## Rules

1. **One process per live run**, spawned and owned by the sidecar,
   in its own process group, ended with the same close sequence
   (end input, 2 s, SIGTERM, 5 s, SIGKILL) and covered by the same pid
   sweep. No shared daemon between runs: a crash takes down one run.
2. **The adapter translates, it does not decide.** Every approval and
   every question goes through `permissions.ts`; the adapter maps its
   runner's native request to `{ tool, input, cwd }` and its runner's
   native decision from `allow | deny | ask`.
3. **The MCP connection carries the session.** Each run registers the
   Portuni MCP server with `Authorization: Bearer <token>` and
   `X-Portuni-Spawn-Id: <sessionId>` headers, the same as Claude, so the
   handshake binds to the pre-created row (step 1, rule 2).
4. **The runner's own login, nothing else.** `detect()` asks the CLI;
   Portuni never stores provider credentials. An instance is a
   `CODEX_HOME` / `XDG_CONFIG_HOME` directory plus env, same registry as
   Claude's `CLAUDE_CONFIG_DIR`.
5. **Orientation rides in the mirror.** Both runners read `AGENTS.md`
   from `cwd`; the marker block `scope-materialize.ts` already writes
   there carries the orientation (`buildOrientationHint` plus the handoff
   pointer on a handoff resume). The adapter re-materializes it before
   the process starts. Claude keeps the system-prompt append; the content
   is the same.

## Codex adapter (`adapters/codex.ts`)

### Process and transport

- `codex app-server` (stdio, JSONL). `initialize` with `clientInfo.name =
  "portuni"`, then `initialized`. `capabilities.optOutNotificationMethods`
  suppresses `item/reasoning/textDelta` and `fuzzyFileSearch/*`.
- Env: `PATH`, `HOME`, instance env (`CODEX_HOME` selects the account; the
  default is the user's `~/.codex`, never overridden unless the instance
  says so), `PORTUNI_MCP_TOKEN` = the run's bearer.
- MCP registration: `-c 'mcp_servers.portuni.url="<url>"'`,
  `-c 'mcp_servers.portuni.bearer_token_env_var="PORTUNI_MCP_TOKEN"'`,
  `-c 'mcp_servers.portuni.http_headers={ "X-Portuni-Spawn-Id" = "<sessionId>" }'`,
  `-c 'mcp_servers.portuni.required=true'` (a failed MCP init fails
  `thread/start` instead of running unscoped). The token stays in env,
  never in argv. **To verify on the first implementation**: the exact
  config keys for header injection in the pinned Codex version; if
  `http_headers` is unavailable, fall back to a per-run `CODEX_HOME`
  overlay that symlinks `auth.json` from the instance home and writes
  its own `config.toml`.
- Sandbox: `thread/start` with `sandbox: "workspaceWrite"` and
  `turn/start` with `sandboxPolicy: { type: "workspaceWrite",
  writableRoots: [mirror], networkAccess: true }`; `approvalPolicy:
  "unlessTrusted"`. Codex's own sandbox is an extra layer below
  `permissions.ts`, not a replacement: a write outside the mirror is
  refused by the sandbox and, when Codex asks, by the policy.

### Thread lifecycle

- Fresh run: `thread/start { cwd: mirror, model: instance.model ?? default,
  serviceName: "portuni" }` → `agentSessionId = thread.id`; then
  `turn/start` with the brief.
- Conversation resume: `thread/resume { threadId }`, then `turn/start`
  with the next message. Handoff resume: fresh `thread/start`.
- `send(text)`: `turn/start` when no turn is active, `turn/steer
  { expectedTurnId }` when one is. `interrupt()`: `turn/interrupt`.
  `close()`: end stdin, then the process sequence.
- Suspend: step 1's flow (the suspend instruction as a user message, wait
  for `portuni_session_suspend`, else server-generated handoff), then
  `close()`.

### Translation

| Codex | canonical |
|---|---|
| `thread/started` | `run_started` |
| `turn/completed { status: completed }` | nothing (a run spans turns); usage from `thread/tokenUsage/updated` folded into the run |
| `turn/completed { status: failed }` | `error { class: "provider" }` |
| `item/agentMessage/delta` | `DeltaFrame` |
| `item/completed agentMessage` | `assistant_message` |
| `item/completed reasoning` | `reasoning { summary }` when `summary` is non-empty |
| `commandExecution` started/completed | `tool_call { category: "command", title: command, output_excerpt: aggregatedOutput }` |
| `fileChange` started/completed | `tool_call { category: "file_change" }` + one `file_change` per entry in `changes` (`kind` → `op`) |
| `mcpToolCall` | `tool_call { category: "mcp", tool: server/tool }` |
| `webSearch` | `tool_call { category: "other", title: query }` |
| `contextCompaction` item | `compaction { trigger: "auto" }` |
| `item/commandExecution/requestApproval` | policy on `{ tool: "Bash", input: { command, cwd } }` → `accept` / `decline`, or `question { type: "approval" }` when `ask` |
| `item/fileChange/requestApproval` | policy on each `changes[].path` as an `Edit` → `accept` if every path is tier 1, `decline` otherwise (tier message as the reason); `ask` only when the policy says so |
| `item/tool/requestUserInput` | `question { type: "input" }` |
| `mcpServer/elicitation/request` (from Portuni's own server, `expand_scope`) | `question { type: "approval" }` per step 1's ask rule; answered with `action: "accept"` + content |
| `item/permissions/requestApproval` | grant only the filesystem paths inside the mirror, `scope: "turn"`; network as the policy says |
| process exit | `run_ended` |

Every server-initiated request is answered; an unanswered request at
`close()` is answered `cancel`.

### Detection

`detect()`: `codex --version` (installed, version); `codex login status`
exit code (logged_in); `instances_supported = true`. Version pinned as a
minimum in `registry.ts`; an older CLI reports `installed: true,
supported: false` and cannot start a run.

### Skills

Codex discovers project skills in `<cwd>/.agents/skills/*/SKILL.md`
(symlinked directories included, verified on 0.154.0); the mirror
materialization from `2026-09-12-routines-and-skills-design.md` puts
them there, so nothing is passed on `turn/start` except, on the first
turn of a run, a `skill` input item for the home node's own skill when
one exists.

## OpenCode adapter (`adapters/opencode.ts`)

### Process and transport

- `opencode serve --hostname 127.0.0.1 --port 0` per run, cwd = mirror;
  the adapter reads the port from stdout, sets
  `OPENCODE_SERVER_PASSWORD` to a per-run random secret and connects with
  `createOpencodeClient({ baseUrl, ... })` from `@opencode-ai/sdk`. Basic
  auth means nothing on the loopback can drive a run it did not start.
- Env: `PATH`, `HOME`, instance env (`XDG_CONFIG_HOME` selects the
  account's `opencode` config directory; `OPENCODE_CONFIG` may point at an
  instance config file).
- MCP registration: `POST /mcp { name: "portuni", config: { type: "remote",
  url, headers: { Authorization, "X-Portuni-Spawn-Id" }, enabled: true } }`
  right after the server is up, before the session is created. No config
  file is written; the user's own `opencode.json` is untouched.
- Permissions: OpenCode decides from its config (`allow | ask | deny`
  per tool and pattern). The adapter sets a per-run config through
  `OPENCODE_CONFIG_CONTENT` (JSON in env, the documented override): `edit`
  → `ask`, `bash` → `allow` (parity with step 1), `external_directory` →
  `deny`, `question` → `ask`, `read` default. Every `ask` arrives as a
  `permission.updated` bus event and is answered through
  `POST /session/:id/permissions/:permissionID { response }` with the
  policy's decision (`once` for allow, `reject` for deny) or turned into a
  `question` when the policy says `ask`.

### Session lifecycle

- Fresh run: `session.create({ title: session name })` →
  `agentSessionId = session.id`; orientation injected with
  `session.prompt({ noReply: true, parts: [orientation] })`; then
  `session.prompt_async` with the brief.
- Conversation resume: the same server binary reopens the stored session
  by id (`session.get`), then `prompt_async`. Sessions are stored under
  the instance's data directory, so a resume must run on the same host
  and instance; otherwise `resume-info` reports `conversation_resumable:
  false` and only the handoff mode is offered.
- `send(text)`: `prompt_async`; OpenCode queues a message that arrives
  mid-turn. `interrupt()`: `session.abort`. `close()`: abort, then the
  process sequence.
- Events: one `GET /event` SSE stream per run (`event.subscribe()`),
  filtered by `sessionID`.

### Translation

| OpenCode bus event | canonical |
|---|---|
| `server.connected` | `run_started` |
| `message.part.updated` with a `text` part of an assistant message | `DeltaFrame` (accumulated text diff) |
| `message.updated` assistant with `time.completed` | `assistant_message`; `tokens`/`cost` folded into run usage |
| `message.part.updated` `reasoning` part completed | `reasoning { summary }` |
| `tool` part `state: running` / `completed` / `error` | `tool_call` started / completed / failed; `category` from the tool name (`bash` → command, `read`/`glob`/`grep` → file_read, `edit`/`write`/`patch` → file_change, `mcp_*`/`portuni_*` → mcp, else other) |
| completed `edit`/`write`/`patch` | `file_change` (`op` from the tool and whether the file existed) |
| `permission.updated` | policy → reply, or `question { type: "approval" }` |
| `question` tool (OpenCode's ask-the-user) | `question { type: "input" }` |
| `session.compacted` | `compaction { trigger: "auto" }` |
| `session.error` | `error { class: "provider" }` |
| `session.idle` after `abort` | nothing; process exit → `run_ended` |

### Detection

`opencode --version`; logged_in from `GET /auth` on a throw-away server
started for detection only when the version is new since the last check
(cached for the 10-minute `detect()` cycle); `instances_supported = true`.

## Shared

- `registry.ts` registers `claude`, `codex`, `opencode`. `GET /runners`
  reports all three with availability.
- `instances.ts`: an instance row gains `runner` validation and the
  runner-specific env key it selects (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `XDG_CONFIG_HOME`); the UI in Nastavení › Runnery shows one form.
- `permissions.ts` gains the two native decision mappers as pure
  functions (`toCodexDecision`, `toOpencodeResponse`) next to the Claude
  one, table-tested.
- Model selection: `instance.model` (optional) is passed where the runner
  takes it (`thread/start.model`, `session.prompt.model`); absent means
  the runner's own default.

## Testing

- Codex adapter against a scripted JSON-RPC peer (the app-server replaced
  by a stdio fake that replays fixtures): every row of the translation
  table, `turn/steer` when a turn is active, an approval round trip in
  all three policy outcomes, an elicitation from the Portuni server,
  unanswered requests cancelled on `close()`, the config `-c` argv never
  containing the token.
- OpenCode adapter against a fake HTTP server (`node:http`, SSE):
  `POST /mcp` before `POST /session`, `noReply` orientation first,
  permission reply for each policy outcome, delta accumulation, abort on
  interrupt, basic-auth header on every request.
- Detection: version parsing, `supported: false` below the minimum.
- Human, macOS: one real task per runner on the same node, suspend,
  Nahodit both ways, a write outside the mirror refused by each runner.

## Known gaps, accepted

- Codex `Bash` commands and OpenCode `bash` are allowed without a tier
  check, as for Claude in step 1.
- OpenCode's stored session lives with the instance on the host; a
  conversation resume on another host is impossible by design (handoff
  covers it).
- The OpenCode server is per run; a machine running many OpenCode tasks
  runs many servers. Acceptable until measured.
