# Workspaces: team and personal, and the two sync planes

> **Purpose:** the canonical mental model for the two kinds of workspace and
> for the unrelated axis "syncing file bytes to Google Drive". Link here
> instead of re-explaining. The rule in the next section is the one every
> server, route and tool change is measured against.

## The rule

A workspace is named by what it is for. A **team workspace** is a shared
graph with identities and permissions; a **personal workspace** is one
person's graph on one machine, and nothing in it is shared. **The team
workspace is Portuni's primary operating environment.** A team runs the
central server (`api.portuni.com`), every teammate's desktop is a team
workspace whose sidecar is a *sync agent*, and every agent task, mirror,
editor save and MCP session in real use happens there. A personal workspace
is the same server code in a box: a file database, no login, no team. It
exists so Portuni can be tried and used alone, and it must keep working, but
it is not the reference environment.

Five words, kept apart throughout the docs (code identifiers keep their
historical names, listed in the last column):

| Word | Means | In code |
|---|---|---|
| **team workspace** | a shared graph reached through the central server; the desktop runs its sidecar as the sync agent | `data_mode: "central"` |
| **personal workspace** | one person, one machine, own graph db, no remote | `data_mode: "local"`, `isLocalWorkspace()`, `SOLO_USER` |
| **central server** | the process at `api.portuni.com`: graph db, permissions, Drive, remote watcher | `PORTUNI_AUTH_MODE=google` |
| **sync agent** | the device's sidecar in a team workspace: mirrors, watcher, tasks, MCP front door, no graph db | `PORTUNI_AGENT_MODE=1`, `agent-router.ts`, `agent-transport.ts`, `agent-tools.ts` |
| **device-local** | a route or tool the sync agent serves itself instead of forwarding to the central server | `is_device_local_path`, `501 sync_agent_down`, `DEVICE_LOCAL_TOOLS`, `device-local-routes.json` |

A team workspace therefore always involves two processes. A change that
works on the central server but not in the sync agent (or the other way
round) is half done. What a given deployment can do beyond the graph
(Drive, hosts, routines, OAuth for remote MCP clients) is a property of the
central server's configuration and of what has been implemented, listed in
"What runs where" below; it is not part of either name.

Consequences for any change (from `docs/vision/portuni-as-workspace.md`,
"Local vs. central"):

- A behaviour change to the server, a REST route, an MCP tool or the session
  runtime works in **both** a personal workspace and team workspace before
  its issue is closed. A half that is missing is an **open issue named in the
  PR title**, never a "known gap" note in the docs.
- New functionality is written **once**, as domain code that runs on the
  central server and in the sidecar alike. Where the device lacks something
  only the central server has
  (the graph db, Drive credentials, the team), the code takes a **seam**
  (`CentralClient` method, injected dependency) rather than a second
  implementation. The pairs that exist today (`engine.ts`/`engine-central.ts`,
  `router.ts`/`agent-router.ts`, `transport.ts`/`agent-transport.ts`,
  `DbSessionStore`/`CentralSessionStore`, `provision.ts`/`provision-central.ts`)
  are what new work avoids adding to; a new pair must not appear.
- What would need a second implementation to run without the central server
  runs **only on the central server** and says so: Drive sync, the remote
  watcher, team permissions, hosts and the task queue, routines. A personal
  workspace never pretends to have them.
- Tests: the fake `CentralClient` in `test/agent-router*.test.ts` and
  `test/agent-tools.test.ts` is where the central half is proven. A route the
  desktop sends to the sidecar in a team workspace is listed in
  `apps/server/shared/device-local-routes.json`; `is_device_local_path` reads its
  patterns from that file at compile time and the agent router is tested
  against it, so a route added on one side without the other fails the gate.

## "Sync" means two different things

Two independent data planes, both called *sync*:

| Plane | What moves | Lives in | Shared via |
|---|---|---|---|
| **Graph plane** | nodes, edges, events, file *records* (name, canonical hash, who pushed) | the graph database (Turso today, Postgres after the cutover) | the central server |
| **File-bytes plane** | the file *contents* (markdown, PDFs, transcripts) | local mirror folders and the remote | Google Drive (service account on a shared drive) |
| **Session record** | that a thread exists, on which node, whose it is, its state, runner, instance, runs and scope | the graph database | the central server |
| **Session content** | the first message, every transcript event, the inline handoff summary | `content.db` on the device that ran the thread | nothing -- it is never shared and never backed up; what crosses machines is the handoff file in the node (a file-bytes-plane artefact) |

The graph stores the canonical content hash of each file (`hash is identity`,
see [`file-sync.md`](./file-sync.md)); the remote holds the bytes. "Sync to
Drive" is the file-bytes plane; "graph sync" is the graph plane.

## The kind of workspace decides how a client reaches the data

`DesktopConfig.data_mode` (`apps/desktop/src/lib.rs`) is a transport and
trust boundary, not a feature toggle. It is set **per workspace**, so one
desktop can host a team workspace and a local personal workspace
side by side, each with its own sidecar, port and credentials.

- **Team workspace.** The webview's data requests go through the `api_request`
  Tauri command to `server_url` with a Google JWT; the server enforces
  permissions (groups, node access, `apps/server/auth/`). The desktop still
  runs its sidecar, as the **sync agent** (`PORTUNI_AGENT_MODE=1`): it keeps
  the device's mirror folders and watcher, moves file bytes between them and
  central with a device token, serves file content from the mirror when one
  exists, runs the agent tasks and serves the MCP front door. It never holds
  the raw database token or Drive credentials and has **no graph db** of its
  own. Setup is the onboarding wizard ("Připojit se k týmu", server URL only)
  or a hand-written `config.json` with `data_mode: "central"`.
- **Personal workspace.** Neither `PORTUNI_AUTH_MODE=google` nor
  `PORTUNI_AGENT_MODE=1` (`infra/server-config.ts`'s `isLocalWorkspace()`).
  The sidecar owns the graph db (`file:<dataDir>/portuni.db`, or Turso when
  `TURSO_URL` is set) and tracks files in mirrors on this machine. It cannot
  register or route to a remote: `upsertRemote`, `setupRemoteService` and
  `setRoutingPolicyService` throw `LocalModeNoRemoteError`
  (`LOCAL_MODE_NO_REMOTE`, REST 409, MCP `isError` with the same code), and
  so do `storeFile`, `pullFile`, `runNodeSync` and `snapshotService`. Files
  there classify as `clean` or `deleted_local` only. Legacy `remotes` rows
  from before this rule log one boot warning and are otherwise ignored.

The central server is the same backend deployed to a VPS
(`scripts/deploy-vps.sh`, auto-deployed from CI on `main`). It has no mirror
folders of its own; file content it serves is Drive-direct
(`file-content-remote.ts`).

## What runs where

| | Central server | Team-workspace device (sync agent) | Personal workspace |
|---|---|---|---|
| Graph db | yes (Turso / Postgres) | none; every graph read is a `CentralClient` call | yes (file / Turso) |
| Per-device `.portuni/sync.db` (`local-db.ts`) | no | yes | yes |
| Mirrors, watcher, reconcile | no | yes | yes |
| File content `GET/PUT /nodes/:id/file` | Drive-direct fallback | mirror first, central fallback | mirror |
| Remote (Drive) and remote watcher | yes, service account, `RemoteWatchLoop` | through the central server | never |
| Session runtime (runs the task) | no | yes, `CentralSessionStore` + `SessionContentStore` | yes, `DbSessionStore` + `SessionContentStore` |
| Session record, access checks | yes (`api/sessions.ts` record half) | on the central server | local db |
| Session content (`content.db`) | never | yes, this device's | yes, this device's |
| Live channel `GET /sessions/ws` | yes | yes (own runtime) | yes |
| MCP | `/mcp` for remote MCP clients (OAuth grant) and proxied tool calls | front door: device tools local, the rest proxied | `/mcp` |
| Runner registry `runners.json` | its own host's | this device's | this device's |
| REST write gate | central auth | `guardAgentRestWrite` (proxy-proven) | `env`-mode gate |

## Request routing in a team workspace

`api_request` sends a request to the central server unless `is_device_local_path` matches
it; then it goes to this device's sidecar, which serves it from
`agent-router.ts`. Before Google login the sidecar is not running and those
routes answer `501 {error: "sync_agent_down"}`, which the web reads as "not signed
in", never as "feature unbuilt".

The canonical list of device-local routes is
`apps/server/shared/device-local-routes.json` (sections `device_local`,
`central`, `sidecar_direct`). `is_device_local_path` is driven by that file:
it embeds it with `include_str!` and matches a request path against the
`device_local` patterns (`{name}` is one segment, the query string is
ignored). `test/agent-router-route-parity.test.ts` asserts the agent router
handles every device-local entry and serves nothing the list omits; the Rust
`device_local_path_tests` assert the `central` examples stay central. **A new
REST route touches three places at once**: the router that serves it
locally, `agent-router.ts`, and that JSON file.

Which routes stay central on purpose: graph reads and writes, the session
record half (`GET`/`PATCH /sessions/:id`, `/state`, `/resume-info`,
`/runs…`, `/sessions/record`; the live half of a model change is
`POST /sessions/:id/model`, device-local), `GET /nodes/:id/sessions`, `/overview`,
`/sync/watch`, `/nodes/:id/file-url`, `/nodes/:id/folder-url`. Per-route
detail: [`desktop-shell.md`](./desktop-shell.md) (routing, write gate),
[`file-state-and-sync-runs.md`](./file-state-and-sync-runs.md) (file
lifecycle routes and their device half), [`sessions-and-runner.md`](./sessions-and-runner.md)
(session routes).

## MCP in sync-agent mode

The sync agent serves `/mcp` itself and the per-mirror `.mcp.json` points at
it (`http://127.0.0.1:<port>/mcp?home_node_id=…`). Device-local tools
(`agent-tools.ts`'s `DEVICE_LOCAL_TOOLS`: mirror, status, store, pull, adopt_files)
run against the device's mirrors and `sync.db`; every other tool is proxied to
the central server's `/mcp` unchanged, which enforces scope and permissions.
Proxied tools that also touch the device's disk (`portuni_move_file`,
`portuni_rename_folder`, `portuni_delete_file`, `portuni_snapshot`) run their
record and remote step on the central server and their disk step here afterwards, and
report `repair_needed` when the second half fails. `portuni_get_node`,
`portuni_get_context` and `portuni_expand_scope` answers are enriched on the
device with `readable_path`/`local_path` from this device's mirror registry.
The dynamic scope set lives on the central session. Detail:
[`mcp-scope-and-integrations.md`](./mcp-scope-and-integrations.md).

## Sessions in sync-agent mode

The code that runs a task (adapter spawn, provisioning, event translation,
suspend, idle sweep, pid-file boot sweep) is one implementation and always
runs on the device. What differs is the `SessionStore` behind it and the
seams a device without a graph db needs: `CentralSessionStore` over the central server's
record REST routes, `provision-central.ts` (`createMirrorForNodeCentral`,
`CentralClient.orientation`), `suspend-fallback-central.ts`, and
`CentralClient.nodeOrganizationId` for the organization's default runner
instance. Access checks run exactly once, on the central server. Detail:
[`sessions-and-runner.md`](./sessions-and-runner.md).

## Editing files

In a personal workspace and on a team-workspace device with a mirror, the editor
reads and writes the **mirror file** (`file-content.ts`); saving never pushes,
pushing is a deliberate sync. A team-workspace device without a mirror for the
node, and a remote MCP client session (OAuth grant), go through the central server, which serves the
bytes **Drive-direct** (`file-content-remote.ts`) and refreshes the canonical
hash on write. Optimistic concurrency is the same everywhere: a stale base
version is a conflict, never a silent overwrite.

## Workspace checklist for a change

- **New or changed REST route**: `router.ts` (local) and `agent-router.ts`
  (device) or a deliberate decision that it stays central; the entry in
  `device-local-routes.json`; `is_device_local_path` and its tests; a test against
  the fake `CentralClient`.
- **New graph read inside domain code that also runs on the device**: a
  `CentralClient` method or an injected resolver, with the local default being
  the direct query. Never a `try/catch` that swallows the failure and degrades
  silently in one mode.
- **New MCP tool**: decide whether it is device-local (`DEVICE_LOCAL_TOOLS`) or
  proxied; a proxied tool that touches disk needs its device step in
  `agent-tools.ts`. A remote MCP client session (OAuth grant) on the central server has no `sync.db`
  (`requireLocalSyncDb()` fails fast).
- **Schema change**: both dialects (`MIGRATIONS` and `PG_BASELINE_DDL`), read
  `docs/lessons-learned.md` §7 first. See
  [`database-and-dialects.md`](./database-and-dialects.md).
- **Web**: a feature that has nothing to do on a personal workspace is hidden
  there (`useDataMode()`), not disabled.
- **Verification**: name in the PR what changed in `agent-router.ts`,
  `is_device_local_path`, `CentralClient` and `agent-tools.ts`, or why none of
  them is affected.

## Glossary

| Term | Meaning |
|---|---|
| team workspace, `data_mode: "central"` | the client reaches data through the central server; permissions enforced; the primary kind |
| sync agent, `PORTUNI_AGENT_MODE=1` | the team-workspace device's sidecar: mirrors, MCP front door, session runtime, no graph db |
| personal workspace, `data_mode: "local"` | one person, one machine, own graph db, no remote |
| graph sync | the graph plane |
| file sync | the file-bytes plane, mirror to Drive |
| `sync_agent_down` (501) | the sync agent is not running yet (not signed in) |
| `LOCAL_MODE_NO_REMOTE` (409) | a personal workspace was asked to do something only a team workspace has |

## See also

- [`desktop-shell.md`](./desktop-shell.md), [`file-state-and-sync-runs.md`](./file-state-and-sync-runs.md),
  [`sessions-and-runner.md`](./sessions-and-runner.md), [`mcp-scope-and-integrations.md`](./mcp-scope-and-integrations.md),
  [`database-and-dialects.md`](./database-and-dialects.md), [`task-surface-web.md`](./task-surface-web.md).
- [`file-sync.md`](./file-sync.md), the file-bytes plane design.
- `docs/superpowers/specs/2026-09-11-one-collaboration-mode-design.md`, why
  collaboration is team workspaces only; `docs/archive/central-file-content-phase-b.md`,
  file content over the server; `docs/archive/plans/2026-06-10-central-cutover.md`,
  the graph cutover; `docs/archive/plans/2026-07-05-agent-mode-mcp-front-door.md`,
  the front door.
