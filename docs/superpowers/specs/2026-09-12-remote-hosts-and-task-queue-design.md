# Remote hosts and the task queue: the place of execution is a choice

A task runs on a host: a machine with a Portuni agent process that owns
mirrors, runner logins and the runner processes. Today the only host is
the desktop's own sidecar. This spec makes a host a first-class record on
central, lets a task pick one (this machine, my server, the team's
agent), and routes the chat through central so the client never talks to
the host directly.

The primary picture is the **team agent**: one machine (a server, the
old Mac) running `portuni-host`, registered once by an admin, shared with
the whole workspace. Anyone who can write a node may start a task on it.
A personal desktop sidecar is the same kind of host, just not shared.

Vision: `docs/vision/portuni-as-workspace.md` (Runner a místo běhu,
Nastavení, Local vs. central). Builds on
`2026-09-12-runner-and-session-design.md` (runtime, runs, events, the live channel);
that spec's step 1 must be merged first. Step 2 of the runner plan,
together with `2026-09-12-codex-and-opencode-adapters-design.md`.

## Scope

In:

- `hosts` on central: registration, heartbeat, capabilities (detected
  runners and instances), personal vs. shared.
- Host connection: one outbound WebSocket from the host to central that
  carries commands down and events up. No inbound port, no tunnel.
- Task placement: `POST /sessions` takes `host_id`; a run is queued until
  its host accepts it; `host_lost` when the host disappears mid-run.
- Delegated token: a run on a host the requester does not own gets a
  device token on the requester's name, scoped to the session, revoked at
  run end.
- The client channel on central: `GET /sessions/ws` served by central
  from the same event store the host writes to; the desktop's
  `sessions_connect` points at central in central mode.
- Host packaging: the sidecar binary as a service (`portuni-host`), started
  by launchd/systemd, configured by env, logged in with a device token.
- Nastavení › Hosty: list, default per organization, mark as shared.

Out: installing a host over SSH from the desktop (later, after the manual
path is stable); host-to-host session migration other than through a
handoff; Windows hosts.

## Rules

1. **The host is the sidecar in agent mode, unchanged in kind.** A host
   runs the same server-domain code as the desktop sidecar (`desktop.ts`'s
   `agentMain`): mirror watcher, central client, runner runtime. The
   desktop's own sidecar is simply the host that happens to be on this
   machine. There is no second runtime.
2. **Central holds the record, the host holds the process.** Sessions,
   runs and events live on central (`CentralSessionStore` from step 1); the
   live run (child process, SDK handle) lives on the host. Nothing about a
   run is reconstructible from central alone except its record.
3. **Outbound only.** The host opens the connection; central never
   connects to a host. A host behind NAT, on a laptop, on a home server,
   all work the same way. When the connection drops, the host keeps its
   runs alive and reconnects; central marks the host `unreachable` and,
   after the grace period, its live runs `host_lost`.
4. **The requester's rights, never more.** A run executes with a token
   that identifies the person who started the task. On a shared host that
   token is minted per run and revoked when the run ends. The host owner's
   own token never serves someone else's task.
5. **Local mode is one process.** No `hosts` table, no WebSocket, no
   delegated token: `host_id` is the fixed local id and `POST /sessions`
   dispatches in-process. The API shape is identical.

## Model

### Host

`hosts` (central only):

| column | meaning |
|---|---|
| `id` | ULID, minted at first registration, stored in the host's data dir |
| `owner_user_id` | who registered it and holds its device token (an admin for a team agent) |
| `label` | "MacBook Pro Honza", "tempo-agent-01" |
| `shared` | `0 \| 1`: whether anyone with write access to a node may place that node's tasks here. `1` is the default for a `portuni-host` service install, `0` for a desktop sidecar |
| `version` | Portuni version of the host process |
| `capabilities` | JSON: `{ runners: RunnerAvailability[], instances: { id, name, runner }[] }` (env values never leave the host) |
| `status` | `online \| unreachable \| offline` (derived from `last_seen_at` and the connection state) |
| `last_seen_at`, `created_at`, `revoked_at` | |

The desktop's own sidecar registers as a host too (label from the
machine name, `shared = 0`) so "this machine" and "a remote host" are
the same row type and the same dispatch path. Local mode has one
implicit host with id `local` and no row.

`sessions.host_id` and `session_runs.host_id` (from step 1) reference
`hosts.id`. `session_runs` gains `queued_at TEXT` and `accepted_at TEXT
NULL`; a run with `accepted_at IS NULL` is queued.

### Delegated token

`device_tokens` gains `delegated_session_id TEXT NULL` and
`issued_to_host_id TEXT NULL`. A delegated token is minted by central when
a run is dispatched to a host whose `owner_user_id` differs from the
session's `user_id`: `user_id` = the requester, `headless = 1`,
`expires_at` = now + 24 h (renewed by the host every hour while the run is
live), revoked in `patchRun` when `ended_at` is set. It is sent to the host
once, inside the dispatch command, held in memory by the host's runtime
and passed to the adapter as `RunStart.mcp.token`. It is never written to
disk on the host and never listed in `GET /device-tokens` for the owner
(filtered by `delegated_session_id IS NULL`), but it is visible to the
requester there with the session name, so they can see and revoke it.

A run on the requester's own host (the desktop sidecar, their own server)
uses that host's existing device token, as today.

### Placement

`POST /sessions` requires `write` on the node (starting a task is a
write, the same gate `createNodeMirror` uses) and gains `host_id?`.
Default, in order: the requester's own override for the node's
organization, the organization's team default, the host the request
arrived on (the desktop's own sidecar). A default that is not `online`
is skipped and the next one tried; an explicit `host_id` that is offline
queues the run on it (the person chose it) and the UI says so. Triggers
without a person in front of them (Asana, routines) never queue: they
take the first online host in the order, else fail with a visible
reason. Validation: host exists, not
revoked, and (`owner_user_id = requester` or `shared = 1`); the runner
named in the request is in the host's `capabilities.runners` with
`installed && logged_in`; else `409 HOST_UNAVAILABLE` with the
availability payload. Nothing else is checked: a shared host is open to
everyone who may write the node.

Two levels of default: `org_settings.default_host_id` (new table keyed by
organization node id, set by `manage`, the team's choice: "tasks of this
organization run on tempo-agent-01"), and `user_settings.default_host_by_org`
(JSON keyed by organization, the person's own override, e.g. "my laptop
while I am testing").

## Visibility and control

A run on a host is team work, not a private terminal. Step 1 kept the
owner-only rule from today's `api/sessions.ts` ("a session is a personal
work record"); this spec widens it, and the API issue of step 1 (#321)
follows this table instead:

| action | who |
|---|---|
| see the row (Relace tab, Přehled, Hosty) | anyone who can see the node (`nodeVisibleTo`), as today |
| read the chat (`GET /sessions/:id/events`, `/sessions/ws`) | anyone who can see the node |
| send a message, answer a question, rename | the owner |
| interrupt, suspend, close | the owner, the host's owner, `manage` scope |
| resume | the owner (`manage` for a routine or Asana session, whose owner may be away) |

Every action carries the actor in the audit row and, for interrupt /
suspend / close by someone other than the owner, a `state_changed`
event with `by` so the chat shows who stopped it. A session without a
node (`interactive_chat`) stays owner-only throughout.

Where a running task is visible:

- **Relace tab** of the node: every session on the node, with host label
  and owner name on the row; Zastavit / Pozastavit appear according to
  the table.
- **Přehled**: the inbox stays personal (Čeká na mě, Běží, Pozastaveno
  are the caller's own), plus a section **Běží v týmu**: every running
  or waiting session on nodes the caller can see, grouped by host, with
  owner, brief, age and the same actions. Routine and Asana sessions are
  listed here, not in the personal inbox, unless the caller owns them.
- **Nastavení › Hosty**: each host row expands to its live runs (session
  name, node, owner, started) with Zastavit for the host owner and
  `manage`.
- `session_state` frames on `GET /sessions/ws` cover every session the
  caller can see, so all three views update without polling.

Local mode has one user; the table collapses to "the owner" everywhere.

## Connection

### Host → central WebSocket

`GET /hosts/connect` (upgrade), `Authorization: Bearer <device token>`.
One connection per host process. Frames are JSON, one message per frame,
same envelope both ways: `{ id?, type, payload }`; `id` present on
requests that expect a reply (`{ id, type: "reply", payload }`).

Down (central → host):

| type | payload |
|---|---|
| `run.dispatch` | `{ session_id, run_id, node_id, brief, runner, instance_id, resume, policy, token: string \| null }` — token present only when delegated |
| `run.message` | `{ session_id, text }` |
| `run.answer` | `{ session_id, request_id, decision }` |
| `run.interrupt` \| `run.suspend` \| `run.close` | `{ session_id }` |
| `host.refresh` | `{}` — re-detect runners and resend capabilities |

Up (host → central):

| type | payload |
|---|---|
| `host.hello` | `{ host_id \| null, label, version, capabilities }` — first frame; central answers with `{ host_id }` (minting one when null) |
| `host.heartbeat` | `{ live_runs: string[] }` every 30 s |
| `run.accepted` | `{ run_id }` — after `provision` succeeded and the adapter started; central sets `accepted_at` |
| `run.refused` | `{ run_id, reason }` — provision or adapter start failed; central ends the run `error` |
| `run.events` | `{ session_id, run_id, events: CanonicalEvent[] }` — batched, at most 50 or 200 ms; central appends through `SessionStore.appendEvents` and returns the `seq`s in the reply |
| `run.delta` | `{ session_id, run_id, text }` — not persisted, fanned out to client sockets |

The host's `SessionRuntime` is the same object as in local mode; the
WebSocket client is a thin dispatcher that calls `startTask` /
`sendMessage` / … on it and forwards its subscriber stream up.
`CentralSessionStore` (step 1) is what the runtime writes through; on a
host it is backed by the same WebSocket (`run.events` frames), not by
individual HTTP calls, so ordering per session is the frame order.

### Liveness

Central marks a host `unreachable` when no frame arrived for 90 s, and
`offline` when the socket is closed. A live run on an `unreachable` host
stays `running` for 10 minutes; then central ends the run `host_lost`,
generates the server-side handoff from the event log (step 1's
handoff-less close rule) and suspends the session. If the host reconnects
inside the window it sends `host.heartbeat` with its live runs and central
reconciles: runs central already ended are closed on the host
(`run.close`), runs still live continue and buffered events flush.

The host buffers `run.events` while disconnected (bounded: 5 000 events
per run, then the oldest are dropped and an `error { class: "transport" }`
event notes the gap).

### Client channel

Central serves `GET /sessions/ws` (step 1's frame set) from its own
store plus the live `run.delta` frames relayed from hosts; `message`,
`answer`, `interrupt`, `suspend`, `close` frames from a client become
the matching `run.*` command on the host's socket. In central mode the
desktop's `sessions_connect` opens the socket against central (with
`central_request`'s auth); in local mode against the sidecar, unchanged.
The web code does not know which. A later mobile client connects to the
same endpoint, through a relay when central is not directly reachable.

## Host process

- `portuni-host`: the existing sidecar binary started with
  `PORTUNI_AGENT_MODE=1`, `PORTUNI_CENTRAL_URL`, `PORTUNI_CENTRAL_TOKEN`
  (from the OS secret store or a mode-600 file the service manager
  reads), `PORTUNI_WORKSPACE_ROOT`, `PORTUNI_HOST_LABEL`. No webview, no
  Rust. `scripts/host/install-launchd.sh` and `install-systemd.sh` write
  the unit and start it; `docs/guides/running-a-host.md` documents the
  manual steps.
- The host's device token is minted from Nastavení › Účet › Tokeny
  zařízení (existing), label "host: <name>": by the person for a personal
  host, by an admin with the `headless` flag for a team agent (the
  existing admin-only mint). The admin is the row's owner for revocation
  and for stopping runs; the token identifies the machine, never a
  requester, because every foreign task on it runs on a delegated token.
- `detect()` runs at boot and every 10 minutes; a change resends
  `host.hello` capabilities. Instances come from the host's own
  `<dataDir>/runners.json` (step 1).
- Mirrors on the host are ordinary agent-mode mirrors: `provisionRun`
  creates one for the node if missing and pulls its files through a sync
  run before the adapter starts. At `run_ended` the runtime runs a sync of
  the home node so the run's outputs reach Drive; the requester's own
  device then sees them as `pull`.
- Boot sweep on the host: step 1's pid sweep; runs found `host_lost` by
  central while the host was down are closed locally without a second
  handoff.

## API

Central:

- `GET /hosts` (read; hosts visible = own + shared), `PATCH /hosts/:id`
  `{ label?, shared? }` (owner; `manage` scope to set `shared`),
  `DELETE /hosts/:id` (owner; revokes, ends its live runs `host_lost`).
- `GET /hosts/connect` (WebSocket, device token).
- `GET|PUT /me/settings` `{ default_host_by_org }`;
  `GET|PUT /organizations/:id/settings` `{ default_host_id }` (`manage`).
- `POST /sessions` gains `host_id?`; `409 HOST_UNAVAILABLE`.
- Step 1's `GET /sessions/ws` moves to central in central mode.

Sidecar (desktop, central mode): `POST /sessions` and the other task
routes are no longer local-only; they go to central, which dispatches
back to the right host. `is_local_only_path` drops them. The sidecar keeps
serving the file-plane routes as before.

## Web

- **Nový úkol** gains a host picker when more than one host is available
  (default per organization; own hosts first, shared after, offline
  greyed with the reason). Runner and instance lists come from the chosen
  host's capabilities, not from `GET /runners` of the local sidecar.
- **SessionChat** header shows the host label; `host_lost` renders as an
  error event with the resume actions.
- **Nastavení › Hosty**: table (label, status, version, runners, shared,
  last seen), expandable live runs with Zastavit, rename, share toggle,
  revoke; "Výchozí host týmu" per organization (`manage`) and "Můj
  výchozí host" per organization. Replaces nothing; sits next to Runnery.
- **Přehled**: section "Běží v týmu" (Visibility and control) and hosts
  with `unreachable` status under "Pozor".

## Testing

- WebSocket protocol against a fake host in-process: hello → id minted;
  dispatch → accepted → events with monotonic `seq`; delta fan-out to an
  client socket; disconnect → `unreachable` → reconnect inside the window
  reconciles; past the window → `host_lost` + handoff + suspended;
  delta fan-out to a client socket.
- Delegated token: minted only for foreign-owned hosts, revoked at run
  end, hidden from the owner's list, visible to the requester.
- Placement validation table (`HOST_UNAVAILABLE` cases).
- Access table: a teammate who sees the node reads events but cannot
  message; the host owner and `manage` can interrupt/close a foreign run
  and the `state_changed` event names them; an `interactive_chat`
  session stays owner-only.
- Host runtime with the fake adapter over a fake central: buffering while
  disconnected, bounded drop, flush on reconnect.
- Human: a task from the desktop to a launchd host on the old Mac, chat
  round trip, kill the host mid-run, watch `host_lost` and Nahodit.

## Phases

1. **Central record**: `hosts`, `user_settings`, delegated tokens,
   `POST /sessions` placement, `HOST_UNAVAILABLE`. Desktop sidecar
   registers itself as a host (no behaviour change yet).
2. **Connection**: host WebSocket, dispatcher on the host,
   `CentralSessionStore` over frames, liveness, client channel on central,
   `sessions_connect` retarget.
3. **Host service**: `portuni-host` scripts, guide, boot sweep
   reconciliation.
4. **Web**: host picker, Nastavení › Hosty, Přehled.

## Known gaps, accepted

- A shared host runs tasks as separate OS processes but not as separate
  OS users; isolation between two requesters' runs on one host is the
  runner's permission callback, not the kernel. Same posture as step 1.
- Files edited on the requester's device during a remote run are not
  pushed automatically; the host sees what Drive has at provision time.
  Same rule as today (push is deliberate).
