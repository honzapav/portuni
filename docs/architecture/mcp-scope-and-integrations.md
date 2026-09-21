# MCP sessions, scope, and harness integrations

An agent reaches Portuni through one MCP server (`apps/server/mcp/`),
whichever of the three ways it connects: a session on a **local
workspace** (the standalone server or a local-mode sidecar, `env`
auth), a session through the **sync-agent front door** on a central-mode
device (`agent-transport.ts` proxies to the central server, `agent-tools.ts` runs the
device-local tools), or a **connector session on the central server** (claude.ai or
Claude Desktop → `api.portuni.com/mcp`, no device and no `sync.db`). Every
mechanism below states what it does in each of the three. The scope model
itself (scope set, session types, refusal contract, write set) is
documented once, in `apps/server/mcp/resources/scope-rules.md` (served as
`portuni://scope-rules`) and on the docs site under
`concepts/scope-enforcement`; this page covers the plumbing around it.

## Auth modes and scope tiers

`PORTUNI_AUTH_MODE=env` (the default for a local workspace) resolves every
request to the solo bearer identity; `google` (central) authenticates with
Google OAuth and derives the tier from group membership. Enforcement is
server-side in `apps/server/auth/`: `min-scopes.ts` names the minimum tier
per tool and REST route, `node-access.ts` decides node visibility.

| Tier | Grants | Env var (central) |
|---|---|---|
| `read` | reads only; no group needed | — |
| `write` | create/update nodes, edges, actors, responsibilities, data sources, tools, events, files | `PORTUNI_GROUPS_WRITE` |
| `manage` | `move_node`, sharing (`PUT /nodes/:id/access`, access requests), positions | `PORTUNI_GROUPS_MANAGE` |
| `admin` | deletes, users, `portuni_setup_remote`, routing policy | `PORTUNI_GROUPS_ADMIN` |

Each `PORTUNI_GROUPS_*` value is a comma-separated list of group emails.
A local workspace has one unscoped identity; the tiers only bite on
central. The sync-agent front door does not evaluate tiers itself: every
proxied call is authorized on the central server under the device token's identity,
and the device-local tools (`LOCAL_TOOLS`, below) apply the same local
write-guard posture the REST agent router does.

## Connect and auto-seed

`?home_node_id=<ulid>` on the MCP URL seeds the session's scope set with
that node and its depth-1 neighbours at connect time (`mcp/auto-seed.ts`,
called from `mcp/transport.ts`). A seed that fails for an infrastructure
reason (database unreachable, network) answers the connect with **503 and
the underlying reason**; the server never serves an empty-scope session in
place of the one the client asked for. A headless device token without
`?home_node_id` is refused at seed time for the same reason.

- Local workspace: the per-mirror configs (below) carry the parameter, so
  a CLI opened inside a mirror is seeded without any tool call.
- Agent-mode front door: the per-mirror `.mcp.json` points at the local
  sidecar (`http://127.0.0.1:<port>/mcp?home_node_id=…`); the front door
  opens the upstream connection to central only once the request carries
  a valid `initialize`, forwards the parameter, and the central server does the seed.
  A probe at the local door never creates a session row on the central server.
- Connector on the central server: no `home_node_id` and no scope set; the session is
  `interactive_chat`, permission-only reads (see scope-rules).

## Materialized scope configs

`portuni_mirror` writes the per-harness configuration into the mirror
folder (`apps/server/domain/scope-materialize.ts`) and refreshes it on
every materialization. **Never hand-edit these files or the marker blocks;
the next materialization overwrites them.**

| File | Harness | Content |
|---|---|---|
| `.mcp.json` | Claude Code | server entry with `?home_node_id=…`, token as `${PORTUNI_MCP_TOKEN}` env expansion |
| `.claude/settings.local.json` | Claude Code | declarative write-scope deny list, `portuni_managed` marker, optional `PreToolUse` guard hook |
| `.codex/config.toml` | Codex | written only when missing or already carrying the Portuni marker comment |
| `.vibe/config.toml` | Mistral Vibe | project-scoped `mcp_servers` entry with `?home_node_id=…` and the token env var |
| `.cursor/rules` | Cursor | plain-text write-scope hint, refreshed |
| `PORTUNI_SCOPE.md` | any | harness-agnostic hint plus the orientation section (below) |
| `CLAUDE.md` / `AGENTS.md` | any | write-scope hint injected between `BEGIN/END` Portuni-managed markers, only when the file already exists; everything outside the markers is preserved |

Rules that hold in every mode:

- **The token is never a literal.** Per-mirror files reference
  `PORTUNI_MCP_TOKEN` (standalone) or `PORTUNI_MCP_TOKEN_<ID>` (a desktop
  workspace, `<ID>` from `PORTUNI_WORKSPACE_ID`). The desktop app has no
  terminal of its own to inject it into; a shell outside the app exports
  it itself (Settings → MCP Server shows the `export` line).
- **Vibe must be started with `vibe --trust`.** Vibe loads the per-mirror
  `.vibe/config.toml` (and therefore auto-seeds) only in a trusted folder;
  untrusted, it falls back to `~/.vibe/config.toml`, which has no
  `home_node_id`, and starts unscoped. Vibe union-merges project
  `mcp_servers` over the user file by `name`, so the per-mirror file stays
  minimal and never clobbers the user's models or providers.
- **User-scoped fallbacks** for a session outside any mirror are the
  desktop commands `install_claude_global` (`~/.claude.json`),
  `install_codex_global` (`~/.codex/config.toml`) and `install_vibe_global`
  (`~/.vibe/config.toml`). They carry no `home_node_id`;
  `portuni_session_init(home_node_id)` is the manual seed there.

Per mode:

- Local workspace: the sidecar materializes directly from its graph db.
- Agent-mode device: the sidecar materializes the same files
  (`materializeAllRegisteredMirrors` at sync-agent boot in `desktop.ts`),
  pointing `.mcp.json` at the local front door instead of central.
- Connector on the central server: nothing to materialize; there is no mirror.

## Disk read scope and `portuni_read_file`

Read scope on disk is **the real mirror path or nothing**. There is no
sandbox, no projection directory and no kernel-enforced boundary: the
runner spawns the CLI unsandboxed and permissions are decided in the
adapter's `canUseTool` callback (`domain/write-scope.ts`'s
`classifyWrite`; see `sessions-and-runner.md`). Consequences:

- A node with a local mirror on this device is fully readable at that
  path regardless of home/neighbour/ad-hoc status. `portuni_get_node`,
  `portuni_get_context` and `portuni_list_files` return it as
  `readable_path` / `local_path` (`null` when this device has no mirror
  of the node), and `portuni_expand_scope` returns a `readable` map
  (`node_id` → mirror path) for every newly accepted node that has one.
- `portuni_read_file(node_id, path)` is the channel for a node with **no
  local mirror on this device**. It reads the mirror when one exists and
  otherwise fetches the routed remote directly
  (`domain/read-node-file.ts`'s `readNodeFileOrPath`).
- Above the 1 MB inline cap (`MAX_READ_BYTES`), or on `as_path: true`, a
  file with a local mirror reports that real path (no copy); a file
  without one is fetched once into a uniquely named temp file under the
  runner data dir (`resolveRunnerDataDir()`, the same base
  `runners.json` and run pid files use). The agent reads that path with
  its own Read/Grep.
- **There is deliberately no chunked-read parameter** (`offset`/`length`).
  The server has no grep, so paging blindly through a large file would
  cost more than reading the path natively; the path is the API.

Per mode:

- Local workspace: `readable_path` comes straight from the mirror
  registry in the graph db.
- Agent-mode device: the central server's answer carries `local_mirror: null` and
  `local_path: null` (it has no device filesystem), so
  `enrichGetNodeResult` / `enrichGetContextResult` (`agent-tools.ts`)
  fill `readable_path`, `local_mirror` and `files[].local_path` from this
  device's own mirror registry for any node mirrored here, and the front
  door's `portuni_expand_scope` overlay fills `readable` the same way.
- Connector on the central server: never a mirror, so `readable_path` is always
  `null` and `portuni_read_file` is the only file read available.

`X-Portuni-Spawn-Id` is not a read-scope mechanism: it binds a fresh
run's MCP connection to the session row `startTask` created
(`mcp/session-persistence.ts`'s `lookupSpawnSessionForBind`).

## Orientation

Portuni sends nothing to a hand-opened CLI on connect. The orientation a
session needs (node context, responsibilities, recent events, a handoff
pointer for a suspended session) is written into **`PORTUNI_SCOPE.md`
only** (`write-scope.ts`'s `buildOrientationHint`, appended by
`scope-materialize.ts`); `.cursor/rules` and the `CLAUDE.md`/`AGENTS.md`
marker blocks keep the shorter write-scope hint and never carry it.

- Local workspace: `orientationForNode` reads the graph db directly.
- Agent-mode device: `materializeAllRegisteredMirrors` takes an
  `orientationFor` resolver; sync-agent boot passes
  `CentralClient.orientation` (`GET /nodes/:id/orientation`, computed on
  central, which has the graph). A failed fetch yields no orientation
  section, never a failed materialization.
- Connector on the central server: no mirror, no file; a runner-started task gets
  its orientation through the run's own provisioning instead.

## Elicitation and tool-call deadlines

Scope and write confirmations are protocol elicitations (`mcp/elicit.ts`)
when the client declared the capability. Two invariants:

1. **A dialog never outlives the client's tool-call deadline.**
   `ELICIT_TIMEOUT_MS` is 4 minutes; the sync-agent relay hop
   (`AGENT_RELAY_ELICIT_TIMEOUT_MS`, 3 minutes) is always derived as the
   outer value minus `ELICIT_RELAY_MARGIN_MS` and is never configured on
   its own, so **relay < outer** holds and an answer that arrives in time
   on the inner hop is never discarded by the outer wait. Both follow the
   single override `PORTUNI_ELICIT_TIMEOUT_MS` (positive integer
   milliseconds; anything else is ignored with one warning). claude.ai
   aborts a tool call at 300 s, so the defaults stay below that.
2. **A tool that cannot possibly succeed never opens a dialog.**
   `portuni_store` and `portuni_pull`'s download branch (`file_id`) call
   `requireLocalSyncDb()` (`domain/sync/local-db.ts`) before
   `guardNodeWrite`, so a session with no `sync.db` fails immediately with
   `PORTUNI_WORKSPACE_ROOT must be set for local sync.db` instead of first
   waiting on a write-scope confirmation. Only those two do:
   `portuni_adopt_files` is remote-only by design and
   `portuni_pull(node_id)` is a preview.

An unanswered dialog is a distinct outcome (`ElicitOutcome` `"timeout"`):
`writeGuardError` answers `write_expansion_required` with
`dialog_timed_out: true` and a retryable hint, not the
`elicitation_supported: false` wording reserved for a client that has no
dialogs at all.

Per mode:

- Local workspace: dialog rendered by the connected client; `env`
  sessions are unscoped for writes and rarely see one.
- Agent-mode device: the front door advertises the connected client's
  own capabilities upstream and relays the central server's elicitation request back
  down to that client, under the shorter relay timeout. The device-local
  tools in `LOCAL_TOOLS` (`portuni_mirror`, `portuni_status`,
  `portuni_store`, `portuni_pull`, `portuni_adopt_files`) never pass
  through `mcp/tools/files.ts`; they always run on a device that has a
  `sync.db`, so invariant 2 is satisfied by construction there.
- Connector on the central server: no `sync.db`, so `portuni_store` and a
  `portuni_pull(file_id)` fail fast; the write dialog for graph tools
  renders in claude.ai and times out under invariant 1.

## Showtime integration

Specs: `docs/superpowers/specs/2026-09-02-showtime-handoff-design.md`,
`docs/superpowers/specs/2026-09-13-showtime-new-deck-design.md`. The web
gates the whole integration behind Settings → Integrace → Showtime
(`localStorage`, off by default); the server side is unconditional.

**Preview.** A `.showtime` deck is a zip. `GET /nodes/:id/file` for a
`.showtime` path returns the `preview.html` entry Showtime packs at every
save, as `text/html` with the bundle's sha256 as `version`, and 422
`NO_PREVIEW` when the entry is missing; `PUT` refuses the path. The desktop
`portuni-html://` protocol unzips the same entry from disk
(`showtime_preview_bytes`). Domain: `domain/sync/showtime-preview.ts`.

**„Otevřít v Showtime" hands over the node, never the bearer.** The
desktop command `open_in_showtime` (not `open_path_external`, which is
allowlisted to `.html`/`.htm`) mints a one-time code on the sidecar:
`POST /auth/handoff` (`write` tier, caller must see the node, bearer is the
token Rust already holds) and opens
`showtime://open?deck=…&portuni=<sidecar base>&code=…`. Showtime trades the
code on `POST /auth/handoff/exchange` (in `AUTH_PUBLIC_PATHS`, loopback
peers only, single use, `HANDOFF_TTL_MS` 60 s, `404 HANDOFF_INVALID`) for
`{ token, mcp_url (?home_node_id=), home_node_id, node_name, mirror }`.
**The bearer never enters a URL, argv or disk.** Both routers (`router.ts`,
`agent-router.ts`) share the handlers in `api/auth.ts`; codes live in
`domain/handoff.ts`. The agent Showtime spawns connects with the node as
home, so its session shows up under the node's Relace.

**„Nová prezentace" is the same handoff before a deck exists.**
`POST /auth/handoff` returns `mirror` beside the code; the desktop
`new_in_showtime { node_id }` (shared `mint_showtime_handoff`) refuses
without a mirror, checks `<mirror>/wip` is inside the workspace root
(`showtime_new_dir`) and opens `showtime://new?dir=…&portuni=…&code=…`
(`showtime_new_url`). The web split button (`NewFileSplitButton`, decided
by the pure `lib/new-file-menu.ts`) exists only with the integration on
and Showtime.app found, and is disabled without a mirror. Portuni does
nothing after the link: Showtime writes the bundle, the mirror watcher
registers it.

Per mode:

- Local workspace: handoff minted and exchanged on the local sidecar; the
  agent connects to it directly.
- Agent-mode device: identical, against the local front door (the
  `mcp_url` in the exchange points at the sidecar), so the Showtime agent
  is proxied to the central server like any other session.
- Connector on the central server: not applicable; both commands need a mirror on a
  device.

## Environment variables

The server reads about 27 `process.env` keys; `.env.schema` declares only
the core ones. The full inventory with defaults is `docs/env-vars.md`. Two
names are easy to confuse:

- `PORTUNI_ROOT` is the write-scope tier root for agent file writes
  (`domain/write-scope.ts`).
- `PORTUNI_WORKSPACE_ROOT` is the mirror root and anchors the per-device
  `.portuni/sync.db`. It is what `requireLocalSyncDb()` checks.

## See also

- `apps/server/mcp/resources/scope-rules.md` (`portuni://scope-rules`):
  scope set, session types, refusal contract, write set, suspend/resume.
- `sites/docs/src/content/docs/concepts/scope-enforcement.md`: the public
  description of the three write-scope tiers and the generated files.
- `docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md`:
  the design the scope model comes from.
- `data-modes.md`: what runs on the device and what on the central server in each
  mode.
- `sessions-and-runner.md`: the runner's `canUseTool` permission path and
  session binding.
