# Sessions: the central server holds the record, the device holds the content

Supersedes, in `docs/superpowers/specs/2026-09-12-runner-and-session-design.md`,
rule 3 as far as *where* events are stored, and, in
`docs/superpowers/specs/2026-09-12-remote-hosts-and-task-queue-design.md`,
the "Visibility and control" table and the task queue. The runtime
(states, runs, the Claude adapter, the live channel, suspend by writing,
`--resume`), the MCP handshake, `session_scope` and the write gate stand
unchanged. Reference: [t3code](https://github.com/pingdotgg/t3code): the
conversation lives on the machine that ran it; what people share is the
repository.

## Principle

Portuni owns no content. A thread has two parts:

- **The record**: that the thread exists, on which node, whose it is,
  its state, runner, instance, model, its runs and its scope. The
  central server holds it, because scope enforcement, the MCP handshake
  and the write gate key on it.
- **The content**: what was said. The first message, every event of the
  transcript, the inline handoff summary. It is stored on the device that
  ran the thread, in the sidecar's own database, and never sent to the
  central server.

A thread is its owner's. Nobody else reads the record or the content:
not a teammate who sees the node, not `manage`. The same person on
another device sees the record and that the transcript is on the other
machine.

Consequences, settled:

- Relace, Přehled, the sidebar and the running count list the owner's
  threads; other users' threads do not appear anywhere.
- The handoff file `wip/sessions/<id>-handoff.md` in the node is a work
  artefact, shared like any file in the node. It is written only when
  the owner asks (**Předat**) or when a run ends with a server-written
  summary as today; the spec does not add automatic sharing.
- There is no backup of transcripts. Losing the device's database loses
  its transcripts; the record on the central server and the handoff
  files remain.
- A personal workspace already stores everything on the device; it
  keeps doing so. The content split changes only where a team
  workspace's sidecar writes.

## Scope

In: the content store on the device, the split of every session write
between record and content, the access rule, the central migration,
lists and Přehled, the live channel's replay source, the boot sweeps,
"Předat" and "Navázat na handoff" as the cross-device path, docs.

Out: the web's session state management (next spec), a permission-mode
picker, remote hosts, message queueing, reading the CLI's own transcript
files.

## Record and content, column by column

`sessions` on the central server keeps: `id`, `node_id`, `user_id`,
`session_type`, `cli`, `instance_id`, `agent_session_id`, `terminal_id`,
`runner`, `host_id`, `waiting_since`, `state`, `handoff_path`,
`handoff_hash`, `name`, `name_is_custom`, `model`, `effort`,
`created_at`, `last_active_at`, `closed_at`, `context_used_tokens`,
`context_max_tokens`. `brief` and `handoff_inline` leave it.
`session_runs` stays whole (runner, instance, host, timestamps,
`end_reason`, `usage`; `usage` is counters, not content).
`session_scope` stays whole. `session_events` leaves the central server.

The device content db has three tables, no foreign keys, keyed by the
central session id:

- `session_content(session_id PRIMARY KEY, brief, handoff_inline)`
- `session_events(id, session_id, run_id, seq, kind, payload, created_at, UNIQUE(session_id, seq))`, the shape it has today
- `device_schema(version)`

`name` stays on the record. It is derived from the first message today
and stays so: only the owner sees the record.

## The content store on the device

- A new `infra/device-content-db.ts` opens `$PORTUNI_DATA_DIR/content.db`
  (libsql, file) with its own three-statement DDL and its own version
  row; it does not use `MIGRATIONS`, `schema.ts` or `getDb()`.
  `desktop.ts` opens it in both modes; a standalone server opens it in
  `PORTUNI_DATA_DIR` or `cwd()`, next to `runners.json`. A personal
  workspace uses it too, so `DbSessionStore` has one code path for
  content; its `session_events` and the two columns in its graph db are
  dropped by the same migration as central's, after a one-time copy into
  `content.db` on first boot (personal workspaces are one user's own
  machine; the copy keeps their history). Both entry points that can be a
  personal workspace (`desktop.ts`, the standalone `index.ts`) run the same
  boot step. The central server never opens a `content.db`.
- A team workspace's history is kept the same way: on its first boot a
  sync agent downloads from the central server the legacy content (events,
  `brief`, `handoff_inline`) of the threads its user owns that ran on this
  device (the record's `host_id` or a run's), and writes it into
  `content.db`. Two central routes serve it, owner-only
  (`GET /sessions/legacy-content?host_id=…`, `GET
  /sessions/:id/legacy-content`), through two `CentralClient` methods. The
  central copy stays until the central migration. Both imports are
  per thread and one transaction each, keyed on `device_schema.version`,
  and a failure leaves the version unchanged so the next boot retries.
- `SessionStore` splits: `appendEvents`, `listEvents`, `getContent`,
  `setContent` go to a `SessionContentStore` backed by `content.db` in
  both workspaces; every other method stays on the record store
  (`DbSessionStore` locally, `CentralSessionStore` in a team workspace).
  The runtime takes both. `CentralClient` loses `appendSessionEvents`
  and `listSessionEvents`; its `patchSessionRecord` and
  `createSessionRecord` lose `brief`.
- `promoteDraftAndStart` writes the first message to `session_content`
  and the `user_message` event to `session_events`, then patches the
  record (`state`, `name`, `runner`, `instance_id`).
- Suspend: the summary is written to the handoff file in the node as
  today (`session-handoff.ts`), `handoff_path`/`handoff_hash` go to the
  record, `handoff_inline` goes to `session_content`. The central
  fallback (`suspend-fallback-central.ts`) that wrote a summary on the
  central server when the device was gone is removed: the central
  server has no content to summarise. A thread whose device disappears
  mid-run stays `running` until the device's boot sweep (below) ends it.
- Until the central migration, a sidecar released before this change
  still sends content to the central server (`POST /sessions/:id/events`,
  `brief`/`handoff_inline` on the record routes) and reads it back from
  there (`GET /sessions/:id/events`, `resume-info`). On the central server
  both sides use the same legacy graph-db rows, so such a sidecar reads
  what it wrote.
- `--resume` and `checkConversationResumable` are unchanged; they read
  the CLI's own transcript on the device.

## Access

`auth/session-access.ts`'s table becomes one line: every action
(`read`, `message`, `stop`, `resume`) is the owner's. `manage` sees no
session it does not own. A non-owner gets `SESSION_NOT_FOUND` for a
node-anchored session too; the node's visibility no longer grants
anything about its threads. `sessions-ws.ts`'s `canSee` in both modes
is the same owner check. Central list routes (`GET /sessions`,
`GET /nodes/:id/sessions`, the sessions part of `GET /overview`
including `activity.session_writes`) filter by `user_id = identity`.

## Lists and Přehled

`GET /nodes/:id/sessions` and `GET /sessions?state=…` return the owner's
sessions of every state, drafts included; the `state !== "draft"` filter
is removed. Přehled's `sessions` field carries records only; `brief` is
gone from `OverviewSessionRow`, the row shows `name`.

## Routing

`GET /sessions/{id}/events` is already device-local and now reads
`content.db`; on a device that did not run the thread it answers 200
with an empty list and `transcript_host: <host_id>` from the record,
which the chat shows as "Transkript je na zařízení X". No route moves
between the central and device lists. The two legacy-content routes
are central and are listed in the `central` section of
`device-local-routes.json`.

## Boot sweeps

The central server's `sweepStaleRunningSessionsOnBoot`,
`sweepStaleDraftSessionsOnBoot` and `sweepArchivedSessionsOnBoot` stay
(they are record maintenance). On the central server the running sweep,
like the MCP transport's close, suspends only a session whose only life
was its MCP connection to that process (no runner, no open run), record
only and with no summary. A thread a device drives is never suspended
there. The device's `sweepOrphanedRunsOnBoot` stays. With the central
summary fallback gone, the device's sweep is what ends a run whose
process died: it patches the run `host_lost` and the record `suspended`
with no handoff, and appends the `run_ended` event locally.

## The central migration

One `MIGRATIONS` entry and the matching `PG_BASELINE_DDL` change, per
`docs/lessons-learned.md` §7: rebuild `sessions` without `brief` and
`handoff_inline` (one `executeMultiple`, `DDL_SESSIONS` and the 030/036
rebuild history updated to the new shape), `DROP TABLE session_events`.
The DDL replay in `schema.ts` and `db-export.ts`/import lose the table.
The rows in Turso are not discarded before every device has kept its
share: each sync agent downloads the legacy content of its user's
threads that ran on it on its first boot after the sidecar release (see
"The content store on the device"), and the personal-workspace copy into
`content.db` runs at boot as well, both keyed on
`device_schema.version`. The migration drops the rows only after that.

## Handing work to another machine

Two new runtime operations, each with a REST verb on the device, the
sidebar row and the chat header:

- **Předat** (`POST /sessions/:id/handoff`, owner): on a running thread,
  `interrupt()` the current turn and wait for the run to drain; then
  the suspend-by-summary path that a limit or idle end uses today,
  called deliberately: summary written to the handoff file in the node,
  file registered so the next sync carries it, record `suspended`. On
  an already suspended thread with a handoff file, a no-op that answers
  the file's path. On a suspended thread without one, the same summary
  path writes the file now, from the content on this device. Not
  offered on drafts or closed threads. It refuses (409, Czech message)
  before any side effect when the node has no mirror on this device,
  when the run is live on another device, or when the thread's
  transcript is on another device; the message names that device.
- **Navázat na handoff** (`POST /sessions` with `handoff_path`, the
  node's Relace tab): the tab lists the node's `wip/sessions/*-handoff.md`
  files from the file records with the summary's title and date,
  including files another device wrote. Choosing one creates a new
  thread on this device (a new record, `runner`/`instance_id` resolved
  as for a draft, `name` from the summary's title) whose first run gets
  the file's content as orientation, the way `resumeMode: "handoff"`
  hands a session its own summary today, generalised to a file that
  belongs to another session. No events are imported; the new thread's
  transcript starts on this device. The source thread is untouched.

## Desktop

`desktop.ts` opens `content.db` from `PORTUNI_DATA_DIR` in both modes
(today it derives only the graph db path, and only in local mode).
Removing a workspace keeps its data dir as it does today. No new Tauri
command; the chat's "Transkript je na zařízení X" needs nothing from the
shell.

## Web

Only what this spec forces: `OverviewSessionRow.brief` is gone; the
events response carries `transcript_host`; two thread actions
(**Předat**, **Navázat na handoff**) and the Relace tab's handoff list.
`localDrafts` stays until the next spec removes it; lists now carry
drafts, `dropPromotedDrafts` dedupes as today.

## Tests

- `SessionContentStore` against a temp `content.db`; the runtime tests
  run with the fake record store and a real content store.
- `CentralSessionStore` tests lose the event methods; the fake
  `CentralClient` refuses `appendSessionEvents`.
- Access: owner-only for every action, `manage` gets `SESSION_NOT_FOUND`,
  list routes filter by owner, `activity.session_writes` filters by owner.
- Migration on both drivers: the rebuild, the drop, export/import
  without `session_events`; the personal-workspace copy.
- Events route on a device that did not run the thread: empty list plus
  `transcript_host`.
- Předat: running → drained → suspended with the file registered;
  suspended → no-op with the path. Navázat na handoff: a file another
  session wrote becomes a new thread's orientation; the source thread is
  unchanged.
- The boot sweep ends a run whose process died without a central
  fallback.

## Docs

`docs/architecture/data-modes.md` (the planes table gains **Session
record** on the central server and **Session content** on the device),
`sessions-and-runner.md` (the store split, the sweeps, the two actions),
`task-surface-web.md`, `database-and-dialects.md` (the second db file),
`docs/env-vars.md`, `CLAUDE.md` ("Sessions and runner": the store line
and the migration line), and in `sites/docs`: `reference/runners.md`,
`clients/connector.md`, `concepts/scope-enforcement.md` wherever a
thread's visibility or the central server's role is described.

## Rollout

The server deploys from CI on merge, the desktop on release; the two are
not one step. Order: (1) sidecar release that writes content to
`content.db`, stops sending events to the central server while the
central server still accepts them, and on its first boot downloads its
own threads' legacy content; (2) after the desktop is updated on every
device and each has imported, the central migration in the next merge.
Today that is one person's devices. Rollback of (2) is not offered: by
then every device holds its own threads' content.
