# File state and sync runs — runtime rules

File state is maintained, never re-derived by an agent: the mirror watcher
keeps the local side current on every disk change, the remote watcher on
the central server keeps the remote side current, and a deliberate sync run is the only
thing that moves bytes. The same rules hold in a personal workspace and in
team workspace; the sections below say where the two differ and why.
Design background: [`file-sync.md`](./file-sync.md) (adapters, hash identity,
data model, tool contracts) and
[`file-mutation-propagation.md`](./file-mutation-propagation.md) (tombstones,
move detection, deletion semantics). This page is the operational layer on
top of both.

## Modes in one table

| | Personal workspace (`isLocalWorkspace()`: not `PORTUNI_AUTH_MODE=google`, not `PORTUNI_AGENT_MODE=1`) | Team workspace, the device (sidecar as sync agent, `PORTUNI_AGENT_MODE=1`) | Central server itself (`PORTUNI_AUTH_MODE=google`) |
|---|---|---|---|
| Engine | `engine.ts`, `sync-run.ts` | `engine-central.ts`, routes in `agent-router.ts`, record half via `CentralClient` | `engine.ts` direct, adapter-direct file lifecycle, `file-content-remote.ts` |
| Remote | none, ever (`LOCAL_MODE_NO_REMOTE`) | central resolves it; device holds no Drive credentials | Drive via service account |
| Classification input | `file_state.cached_local_hash` only | `file_state` + `files.current_remote_hash` from the central server | live adapter stat |
| Possible classes | `clean`, `deleted_local`, `new_local` | all | all |
| Mirror watcher | yes | yes | only if it carries mirrors |
| Remote watcher | no | no | yes |

A behaviour change on the file plane touches both device engines or states
in its PR why one is out of scope; a route the desktop UI calls needs an
entry in `is_local_only_path` (`apps/desktop/src/lib.rs`) and a handler in
`agent-router.ts`, or it never reaches the device in a team workspace.

## Registration and classification

- **Registration never requires a remote.** `registerLocalFile` (local) and
  `registerFileRecordRemote(s)` (central/REST) leave `remote_name` NULL when
  routing does not resolve; `remote_path` is always computed, because it is
  derived from the node's identity, never from the remote.
  `idx_files_unique_remote` is keyed on `(node_id, remote_path)` alone, so a
  later `storeFile`/write on the same path backfills `remote_name` onto the
  existing row instead of creating a duplicate.
- **Registration is record-only.** No upload happens at registration. On a
  personal workspace the file reads `clean` (there is nothing to push to). On a
  workspace where a remote can resolve it reads `push` until a deliberate
  `portuni_store` or sync run pushes it.
- **Where a remote is required.** `storeFile`, `pullFile`, `runNodeSync` and
  `snapshotService` refuse with `LocalModeNoRemoteError`
  (`LOCAL_MODE_NO_REMOTE`, REST 409, MCP `isError` with `code`) on a local
  workspace, checked before any other work. Where a remote can resolve,
  `storeFile` still requires one and throws `ROUTING_GUIDANCE` otherwise:
  that guidance belongs at the moment of a deliberate sync, not at
  registration.
- **Sync classes** are `clean | push | pull | conflict | remote_missing |
  remote_error | native | deleted_local` (`SyncClass`,
  `shared/api-types.ts`), plus the untracked buckets `new_local`,
  `new_remote`, `deleted_remote`. There is no `orphan` class and no `moved`
  bucket: move pairing happens at reconcile time, never at scan time.
- **A `StatusFileEntry` carries the class of the bucket it is in**, including
  `deleted_local`. REST derives `sync_class` from the bucket array;
  `portuni_status` serializes the raw `StatusResult`, so `entry.class` must
  give the same answer.
- **Personal workspace scan.** `statusScan` computes `isLocalWorkspace()` once
  and short-circuits every row before touching an adapter: tracked and
  present is `clean`, tracked and gone from disk is `deleted_local`.
  `push`/`pull`/`conflict`/`remote_*` cannot occur. The web hides (not
  disables) `SyncBar`/`SyncOverview`'s "Synchronizovat" and the file row's
  "Obnovit" on a personal workspace (`useDataMode()` in `DetailPane.tsx`,
  `SyncOverview.tsx`).
- **Team-workspace scan (device and central server).** `statusScanCentral` reads only
  `file_state.cached_local_hash` and `files.current_remote_hash`; it has no
  `fast` parameter and never stats the remote. Re-deriving what the device
  does not know is the sync run's own reconcile pass
  (`resolveUnknownRemotes`), never a mode of reading.
- **Central server scan.** A server running with `PORTUNI_AUTH_MODE=google`
  that carries its own mirrors reaches `engine.ts` directly and classifies
  live against the adapter, with no persisted stat cache. The
  `remote_stat_cache` table, `RemoteStatRow`, `getRemoteStat` and
  `upsertRemoteStat` exist for `engine-central.ts`'s remote-hash observation
  cache only.
- **`portuni_status` filters.** `classes`/`path_prefix`/`limit`/`offset`
  (`status-filter.ts`); the response always carries `counts` (true
  per-bucket sizes, ignoring filters) and `truncated`.
- **Central hash tracking.** `files.current_remote_hash` is team-workspace
  classification's only source of remote truth, so every path that proves
  the remote's identity persists it: `writeFileBytesRemote`'s `ifAbsent`
  and `baseCanonicalHash` checks and `readFileBytesRemote` call
  `backfillRemoteHash`; `remote-sweep.ts`'s hash-refresh step fills a NULL
  hash and corrects a stale one whenever the listing reports a hash (Drive
  `md5Checksum`, which is how an out-of-band Drive edit is caught).
  Native-format records are excluded. A backend that reports no hash on
  listing (fs, OpenDAL) gets only NULL hashes resolved; re-verifying a known
  hash there would mean downloading every tracked file on every run.

## Watcher and reconcile

- **Where it runs.** `mirror-watcher.ts` → `reconcile.ts` (local) or the
  `*Central` counterparts. The desktop sidecar runs it by default in both
  modes (`PORTUNI_WATCH_MIRRORS=0` disables); the standalone server opts in
  with `PORTUNI_WATCH_MIRRORS=1`. Backend dev against the tmux server needs
  that flag to get the same behaviour as the app.
- **Ordering.** One reconcile chain per mirror (`reconcileChains`,
  `Map<nodeId, Promise>`): ordering holds within a mirror, mirrors do not
  block each other. A failed reconcile is recorded (`recordWatcherError`,
  surfaced through `GET /sync/health`), never retried inside the chain;
  `MirrorWatcher.sweep()` re-backfills every watched mirror every 10 minutes
  (`boot/mirror-watch.ts`) and repairs it.
- **Directory moves are walked.** `fs.watch` fires one event for a directory
  created or moved into place and none for its children, so
  `reconcilePath`/`reconcilePathCentral` recurse into a directory that
  exists on disk (`reconcileDirectory`/`reconcileDirectoryCentral`) and
  reconcile every file at its current path. Each file is then paired by
  inode (`tryApplyDiskMove`/`tryApplyDiskMoveCentral`,
  `file_state.cached_ino`/`cached_dev`) exactly as if it had fired its own
  event.
- **Backfill is the catch-up path.** `dbBackfillMirror` and
  `centralBackfillMirror` (`apps/server/desktop.ts`) route every untracked
  file through `reconcilePath`/`reconcilePathCentral`, so a `mv` that
  happened while nothing was watching (server down, missed event) gets the
  same pairing instead of a fresh duplicate record.
- **A push caches the current hash, not the pushed one.**
  `storeFile`/`storeFileCentral`/`pushEntryCentral` stat before reading the
  bytes and re-stat after; if the file changed mid-upload the cache holds
  the current content hash. Status trusts `cached_local_hash` outright, so
  an edit landing during a background push must read as `push`, not
  `clean`.
- **A watcher-driven delete unregisters only on a confirmed `status: "ok"`.**
  `reconcilePathCentral`'s never-pushed-delete branch treats a thrown
  failure and a `repair_needed` alike: `file_state` stays, the result is
  `{action: "noop"}`, and the next event or backfill sweep retries. A
  one-shot watcher event never silently degrades (same rule as
  `tryApplyDiskMoveCentral`).

## File lifecycle routes in a team workspace

Central's own create, rename and delete are adapter-direct (it has no device
mirror). The desktop UI's REST calls for them are routed to the device
(`is_local_only_path` matches `POST /nodes/:id/files`, `DELETE
/nodes/:id/files/:fileId`, `POST …/:fileId/{resolve,rename,move}`), and
`agent-router.ts` splits each into a central record half and a local disk
half:

- **Create** (`POST /nodes/:id/files`). With a mirror on this device the
  handler writes the file into the mirror, calls `registerLocalFileCentral`
  (record only, no Drive call) and answers immediately, then fires
  `storeFileCentral` in the background (not awaited; failure logged, not
  surfaced). Until the push lands the row reads `push`, then `clean` once
  `upsertFileState` writes `last_synced_hash`: the same lifecycle as a file
  created directly in the mirror. Answering only after the Drive upload
  would leave the editor's first save with no baseline and a permanent
  `conflict` (local hash, no `last_synced_hash`, remote hash `md5("")`);
  `classifyRecord`'s "no baseline → conflict" rule is correct, the inputs
  would be wrong. Without a mirror the handler falls back to
  `CentralClient.createFile` (the mirror-less create the central server serves).
- **Pending pushes.** The background upload is tracked per mirror path
  (`pending-pushes.ts`); delete, resolve and rename on the same path
  `awaitPendingPush` first so an `adapter.put` cannot land after the record
  is gone and resurrect the remote object. Both dispatchers do this:
  `agent-router.ts`'s REST handlers and `agent-transport.ts`'s proxied MCP
  mutations.
- **Rename** (`…/rename`). Central keeps the record and remote step
  (`CentralClient.renameFile`); the handler waits for a pending upload, then
  renames the mirror copy and refreshes its hash cache.
- **Move** (`…/move`). `CentralClient.moveFileRecord` first; only after
  the central server confirms does the device relocate its mirror copy. A cross-node
  move resolves the target node's mirror root and node root independently
  (`loadNodeContext`); a target with no mirror on this device reports
  `repair_needed` with a hint instead of stranding the old copy.
- **Resolve** (`…/resolve`, `keep_local | take_remote | restore`). Served
  against the device's own mirror (`findEntryByFileId` +
  `storeFileCentral`/`pullFileCentral`). Central has no mirror to resolve
  against, so this route must never be forwarded there.
- **Delete** (`DELETE …/files/:fileId`). `CentralClient.deleteFileRecord`
  for the record and remote object, then the local `rm` + `deleteFileState`
  on the device. In every mode the local `rm` runs whenever
  `mode === "complete"` and a local path resolves, independent of whether a
  remote object existed; a row with `remote_name` NULL still loses its
  local copy, otherwise the next backfill sweep re-registers it. The MCP
  tools (`portuni_delete_file`, `portuni_move_file`, `portuni_rename_folder`)
  get the same disk step from `agent-tools.ts`'s `isProxiedDiskMutation` /
  `applyLocalAfterProxiedMutation`.
- **Still central-only.** `/nodes/:id/file-url` and `/nodes/:id/folder-url`
  are served Drive-direct by the central server and are deliberately not device-local.

Personal workspace equivalents: `createFile` (`file-content.ts`) resolves the
remote first and calls `storeFile` (register + push) or `registerLocalFile`
(record only) when nothing is routed, so a retry never hits `EXISTS` for
bytes already on disk; `deleteFile`/`moveFile`/`renameFile`/`renameFolder`
in `engine-mutations.ts` do the record, remote and disk steps in one
process.

## Deliberate sync run and remote sweep

`POST /nodes/:id/sync` (`runNodeSync` in `sync-run.ts` locally,
`syncRunCentral` on the device in sync-agent mode, which calls the central server's
`POST /nodes/:id/sync/remote-sweep` for the credential-holding steps) is the
only operation that moves bytes. Step order is in
[`file-sync.md`](./file-sync.md#deliberate-sync-run): pending ops retry,
remote sweep, scan, push/pull, tombstone cleanup, adopt untracked. Rules
that follow from it:

- **`portuni_status` never sweeps.** Reading status is side-effect free; the
  remote sweep, tombstone cleanup and adoption run only inside a sync run.
- **Remote sweep scope.** A pushed record whose remote object is confirmed
  gone is deleted and tombstoned; a file newly present on the remote
  anywhere under `wip/`, `outputs/` or `resources/`, at any depth, skipping
  any dot-prefixed segment, is adopted and pulled in the same run. Never
  the node root (an organization's root spans its children). Nothing fires
  until the node root is confirmed reachable, so an unreachable remote
  never destroys records.
- **Pending ops.** `moveFile`/`renameFile`/`renameFolder`/`deleteFile`
  record intent in `pending_file_ops` before touching the remote; the next
  run retries idempotently. `runDelete` resolves this device's own mirror
  path (`getMirrorPath` + `resolveNodeInfo` + `deriveLocalPath`) so a
  retried delete cleans up locally too.
- **Decisions are not automated.** `conflict` and `deleted_local` are
  reported, never auto-resolved; the human resolves them via
  `POST /nodes/:id/files/:fileId/resolve` or the equivalent
  `portuni_store`/`portuni_pull` call.

## Bulk jobs and pending accounting

- **Job.** "Synchronizovat vše" is `POST /sync/jobs` (body `{ node_ids? }`,
  default every node with `computeSyncPending` `total > 0`), answered `202`
  at once. `sync-jobs.ts` runs each node through a `runNode` callback with
  bounded concurrency (`PORTUNI_SYNC_JOB_CONCURRENCY`, default 3):
  `runNodeSync` locally, `syncRunCentral` in sync-agent mode. `GET
  /sync/jobs/:id` polls; `GET /sync/jobs/current` lets a remounted UI
  reattach. One job per user: a second `POST /sync/jobs` reattaches and
  appends any node not already covered. State is in-memory; a restart
  loses the progress view, never work, since each node's run is
  idempotent. The routes are device-local in both `is_local_only_path` and
  `agent-router.ts`.
- **Per-node serialization.** The pool wraps each node in
  `withNodeSyncLock` (path lock `sync-node:<id>`), so a central catch-up
  sweep and a user-triggered run on the same node never overlap; the later
  one waits.
- **Pending accounting** (`SyncPendingNode`, both `computeSyncPending` and
  `computeSyncPendingCentral`): `total` is `push + untracked` (what a run
  can clear); `decisions` is `conflict + deleted_local` (needs a human);
  `pull` counts towards neither, because the unsynced badge and the quit
  guard must not report a teammate's edits as the user's own backlog, but a
  node holding only `pull` records stays in the aggregate. A node with only
  decisions appears with `total: 0`. `SyncOverview.tsx` shows the split as
  `+N k rozhodnutí` and puts only actionable nodes in a job's default set;
  the sidebar's „Nové na remote: N uzlů" and the overview's per-node
  down-arrow read `pull`. A finished run's residual accounting
  (`apps/web/src/lib/sync-pending-residual.ts`, what clears a just-synced
  node from the overview before the next aggregate scan) reads
  `SyncRunResponse.errors[].sync_class`: every error entry carries the class
  the file had when the run acted on it (`sync-run.ts` and `syncRunCentral`
  both tag theirs), so a failed pull stays a pending `pull` instead of
  being counted as a push the user is expected to clear.
- **Every caller of a node sync run takes the node lock**, not only the
  pool: `api/nodes.ts`'s `handleSyncRun` (`POST /nodes/:id/sync`) and
  `handleRemoteSweep` (`POST /nodes/:id/sync/remote-sweep`, what the sync
  agent asks the central server for), and `agent-router.ts`'s own
  device-side `POST /nodes/:id/sync`. Without it a user-triggered sync and
  the watcher's catch-up of the same node interleave (double adopt, double
  tombstone, unique-constraint errors).
- `/sync/pending` and `/sync/health` are device aggregates (the device's
  mirrors, the device's watcher errors); central would answer empty, so both
  are device-local routes.

## Remote watcher on the central server

- **Central only.** `boot/remote-watch.ts`'s `RemoteWatchLoop` starts when
  `authMode() === "google"` and nowhere else; an env-mode standalone server,
  the desktop sidecar and the sync agent skip it. Every
  `PORTUNI_REMOTE_WATCH_INTERVAL_MS` (60 s) it calls `changes(cursor)` on
  each remote that implements the feed and applies the batch through
  `domain/sync/remote-watcher.ts`. Spec:
  `docs/superpowers/specs/2026-09-12-remote-watcher-design.md`.
- **Change feed.** `FileAdapter.changes?(cursor)` (`types.ts`,
  `RemoteChange`/`RemoteChanges`) is optional; only the Drive adapter
  implements it, fs/OpenDAL rely on the full sweep. Drive pages
  `changes.list` with the shared drive's `driveId` (never `corpora`, which
  belongs to `files.list` and is rejected here), reports `removed` or
  `trashed` as a `remove` (a hard delete carries no metadata, so `path` is
  null), and answers a 410/404 page token with `reset: true` plus a fresh
  start token. `RemoteChange.upsert` carries the backend's own `file_id`
  next to the path.
- **Ancestor cache, two tiers.** Paths resolve through `pathFor`/
  `folderInfo` backed by `drive-folder-cache.ts`: `createFolderPathCache`
  is an insertion-ordered LRU memo bounded by
  `PORTUNI_DRIVE_FOLDER_MEMO_MAX` (5 000) over `createDbFolderPathStore(db,
  remoteName)`, one row per folder in `remote_folder_cache` (folder id →
  path relative to the remote root). `adapter-cache.ts` hands the store to
  `createDriveAdapter(remote, tokens, { folderCache })`; an adapter built
  without it (a test) is memo-only. Lookup order is memo → row → Drive;
  writes go to both tiers, except a negative entry ("this ancestry does not
  reach the remote root"), which is memo-only. Invalidation is by path: a
  folder reported by the feed recomputes its own path from the change (no
  network call) and, when it moved, drops its old path and everything under
  it in both tiers; a removed folder drops the same subtree; the adapter's
  own writes narrow `invalidatePrefix` to the written subtree; a feed
  `reset` truncates the remote's rows, since the full sweep that follows
  refills them. Descendants refill lazily on the next miss, one `files.get`
  each.
- **Correlation by object id, not path alone.** `files.remote_file_id`
  (migration 038 + `PG_BASELINE_DDL`; the index `(remote_name,
  remote_file_id)` lives in `DDL_AFTER_MIGRATIONS`, never in the DDL replay)
  carries Drive's file id; every path that proves an object's identity
  persists it through `remote-sweep.ts`'s `persistRemoteFileId` (adopt,
  `storeFile`'s upsert, `createFileRemote`, `writeFileBytesRemote`, the
  sweep's hash refresh, `backfillRemoteHash`); fs/OpenDAL report none and
  the column stays NULL. That makes three feed events same-tick work
  instead of "wait for the sweep": a **hard delete** (no metadata) is
  planned as `remove_by_id`, `findRecordByRemoteFileId` finds the row and
  `deleteRemovedRecords` confirms and tombstones it; a **rename or move**
  arrives as an upsert at a new path whose id already belongs to a record,
  so the record is relocated (`writeRelocatedRecord`, the same call
  `moveFile` makes, plus a `sync_move` audit tombstone, which is what makes
  a device drop its stale copy at the old path instead of re-adopting and
  pushing it back); a **folder rename or move** reports the folder and
  nothing for its children, so the reducer resolves it to its node and
  returns `sweepNodeIds`, which the tick hands to
  `RemoteWatchTickArgs.sweepNodes`, a bounded catch-up sweep of exactly
  those nodes that is never recorded as the periodic whole-workspace sweep.
  `remote_file_id` never leaves the central server: `SyncInfo.files` does
  not carry it, classification does not read it, and a relocation reaches
  a device through the `sync_move` tombstone the sync-info tombstone query
  already ships.
- **One classification path.** `remote-sweep.ts` exports its three steps
  (`adoptRemoteFiles`, `refreshRemoteHashes` with `needsHashRefresh`,
  `deleteRemovedRecords`) and both `remoteSweep` and the watcher call the
  same functions, so one changed file and a whole-node sweep cannot
  disagree. The adopt branch resolves each genuinely new file's `FileRef`
  with `adapter.stat(path)` because `RemoteChange` carries no mime: a
  synthesised ref would mark a Drive-native Doc as binary, its hash
  backfill would fetch bytes Drive refuses (403), the batch would error and
  the cursor would never advance. A path whose stat finds nothing (created
  and deleted between change and tick) is skipped.
- **Reducer and locking.** `planRemoteChanges` is pure: a change with
  neither a path nor a file id (`no_path`), a path outside every node root
  and a path outside `wip`/`outputs`/`resources` are dropped; a folder
  change resolves to its node's catch-up sweep; longest node root wins (a child
  project owns its files, not its organization); last change per path
  wins. `applyRemoteChanges` runs each operation under
  `withPathLock("<remote>:<remote_path>")`, the same key the adapter-direct
  central write path uses.
- **Registration only, never bytes.** The watcher maintains
  `files.current_remote_hash`; a device with a mirror reads `pull` on its
  next scan and the bytes arrive through a deliberate sync.
- **Cursor and catch-up.** `remote_cursors` is persisted only after every
  change of a batch applied; a failed batch leaves it untouched and is
  replayed, safe because each operation is idempotent. A tick that throws
  **and** a tick whose batch did not fully apply both back off from the
  tick interval (60 s → 2 → 4 … cap 1 h, `backoffMsFor`) and leave the
  cursor alone; without the backoff a failing batch replays once a minute
  against a remote already answering 429. Catch-up is the full
  `remoteSweep` for every node routed to the remote: at boot, after a feed
  `reset`, and every `PORTUNI_REMOTE_SWEEP_INTERVAL_MS` (6 h), run through
  `sync-jobs.ts`'s pool. **A sweep is recorded when it finishes, not when
  it starts**: `runCatchUp` awaits the job (`awaitSyncJob`) and throws on
  the first node error; `beginCatchUp` runs it detached (a tick is a
  heartbeat, a sweep is a whole-workspace job; `RemoteState.sweepsInFlight`
  is a counter, since a node-scoped sweep can overlap the periodic one) and
  sets `lastFullSweepAt` only on a clean finish. **A failed sweep backs off
  on its own schedule** (`RemoteState.sweepBackoff`/`sweepError`, 60 s →
  1 h): a node the sweep cannot list is not a feed failure, so the feed
  keeps being polled and `watching` stays true; `maybeFullSweep` honours
  the backoff, a full sweep the feed asks for while backing off clears
  `lastFullSweepAt` so the first tick past the backoff sweeps, and
  node-scoped sweeps are never gated.
- **Status seam.** `GET /sync/watch` (read tier) answers `{remotes:
  [{remote_name, watching, cursor_updated_at, last_tick_at, last_error,
  backoff_until, last_full_sweep_at, sweep_error, sweep_backoff_until}]}`,
  ISO-8601 UTC throughout
  (`isoFromDbTimestamp` normalizes `remote_cursors.updated_at`'s zone-less
  form). `handleSyncWatch` (`api/nodes.ts`) reads the loop through
  `domain/sync/remote-watch-status.ts`, which the loop registers with at
  start; a server with no loop answers `[]`, and `isLocalWorkspace()`
  short-circuits to the same. **Deliberately not device-local**: no
  `is_local_only_path` entry, no `agent-router.ts` route, no `CentralClient`
  method, no MCP tool. The team-workspace desktop reaches it through the
  ordinary proxy to the central server, the only process that runs the loop. Web
  helpers (`apps/web/src/lib/remote-watch-view.ts`: `remoteWatchLine`,
  `pullNodeCount`) are pure and server-tested; Nastavení → Synchronizace
  renders one line per remote and nothing on a personal workspace.

## Per-path locking

- `path-lock.ts`'s `withPathLock(key, fn)` is a per-key async mutex around
  the whole check-then-write critical section. Keyed on the local absolute
  path: `engine.ts`'s `pullFile`/`storeFile`, `engine-central.ts`'s
  `pullFileCentral`/`storeFileCentral`/`pushEntryCentral`,
  `file-content.ts`'s `writeFileContent`/`createFile`. Keyed on
  `remote_name:remote_path` (no local path exists there):
  `file-content-remote.ts`'s `writeFileContentRemote`/
  `writeFileBytesRemote`/`renameFileRemote`, and the remote watcher.
- Everything the decision depends on belongs inside the lock. A pull
  downloads its bytes inside it, or it can overwrite a newer push with older
  content and record the stale hash as this device's baseline.
  `pushEntryCentral` re-reads its baseline under the lock rather than
  trusting the scan entry.
- **Not reentrant**: never take it around a call that takes it again
  (`createFile` releases it before calling `storeFile`).
- **In-process only**: it does not protect against another device or
  process writing the same Drive object. Storage-level preconditions
  (ETag/If-Match) are a known gap, marked at the `writeFileContentRemote`/
  `writeFileBytesRemote` call sites.

## Relocation and pending ops

- `relocateRemoteObject` (`file-relocation.ts`) stats source and
  destination first: same path is a no-op, both present is an ambiguity it
  refuses to guess away, only-destination is `already_at_target`.
  `moveFile`, `renameFile`, `renameFolder`, `renameFileRemote` and
  `pending-ops.ts`'s `runMove` all route through it, plus
  `writeRelocatedRecord`, which folds a colliding shadow row into the
  survivor inside the same `db.batch` as the UPDATE instead of raising a
  constraint error.
- A cross-remote move is copy-then-delete and not atomic. When the copy
  lands and the delete fails, `moveFile` records `source_copied` on the
  pending op (`markPendingMoveSourceCopied`); that flag is the only thing
  that later tells the retry which of two present objects is its own copy.
  The retry deletes the source only when the recorded intent says so and
  the two hashes are comparable and equal.
- `portuni_rename_folder` applies at most `limit` files per call (default
  20) and reports `remaining` + `next_call`; re-running the same call
  resumes, since renamed files no longer match `old_prefix`.
- `sync_rename_remote` counts as a tombstone-qualifying action in
  `sync-remote-api.ts`.

## Delete and `file_state` cleanup

- `file_state.last_synced_hash` is the only proof a later tombstone cleanup
  (`matchDeleteTombstones` + `cleanupDeletedRemote`) has that a leftover
  local copy is an already-confirmed deletion rather than new content to
  adopt and push back. It is therefore cleared only once the local file is
  confirmed gone.
- Every delete path goes through `local-cleanup.ts`'s
  `removeLocalCopyAndState(localPath, fileId)`: `engine-mutations.ts`'s
  `deleteFile`, `pending-ops.ts`'s `runDelete`, `agent-router.ts`'s `DELETE
  /nodes/:id/files/:fileId`, `agent-tools.ts`'s
  `applyLocalAfterProxiedMutation`. It attempts the `rm` (ENOENT counts as
  success) and clears `file_state` only if that worked; on any other failure
  the state and the tombstone audit row stay and the next sync's cleanup
  pass finishes the job.
- `deleteFileRemote` treats a confirmed retry that finds nothing to delete
  as `already_deleted: true` when this file id's own
  `sync_delete`/`sync_delete_remote` audit history proves the first attempt
  landed. An unknown id still throws, and only `confirmed: true` qualifies.

## Failure reporting: `repair_needed`

A local step that runs after central already committed reports
`repair_needed`, never a 500 and never a silent success:

- REST (`agent-router.ts`) answers 200 with `status: "repair_needed"` and a
  hint.
- MCP (`agent-tools.ts`'s `applyLocalAfterProxiedMutation`) rewrites
  the central server's response itself instead of letting the caller's outer `.catch()`
  swallow it. `rename_folder` downgrades only the failed entry and
  recomputes `renamed`/`failed`, keeping the rest of the batch's outcome.
- The watcher treats `repair_needed` like a thrown failure (see above): the
  state stays and the next event retries.

## Drive: one auth path, central only

Collaboration is team workspace
(`docs/superpowers/specs/2026-09-11-one-collaboration-mode-design.md`). A
personal workspace cannot register or route to a remote, so there is no
per-user Drive OAuth anywhere. `drive-adapter.ts` takes auth from the
remote token's `service_account_json` only (`drive-sa-auth.ts`;
`assertSaDriveConfig` requires a `shared_drive_id`, since a service account
has no My Drive quota). Setup is `remote-service.ts`
(`setupRemoteService`/`setRoutingPolicyService`/`listRemotesService`, admin
tier, refused on a personal workspace with `LocalModeNoRemoteError`) reached
through `portuni_setup_remote` (MCP only; the `setup-drive-remote` prompt
walks the steps). There is no REST or web UI for connecting Drive;
`SyncSection.tsx` (Nastavení → Synchronizace) is informational: server URL
in a team workspace, a one-line "no remote" note on a personal workspace, plus
mirror-watcher errors and the remote-watcher lines in both.

## Deliberately not done

Do not re-litigate without new reasons:

- Reserving a `files` row before `createFileRemote`'s upload. Worth it only
  paired with real idempotent resume; alone it trades an invisible orphan
  blob for a phantom row nothing can complete.
- A general idempotency-key replay mechanism for the central client's
  mutation retries. Larger than one backlog item; the delete replay above
  is the reachable case.
- Making `moveFile`/`renameFile`/`renameFolder` work for a never-routed
  device-local file. Today it is a clear rejection (`"File X has no remote
  binding"`, or a per-file `repair_needed` in `renameFolder`'s batch);
  widening the public `remote_name` fields to nullable is a riskier change
  than the narrow scenario warrants.
- A `fast` parameter on either status scan. Reading is a read; reconcile is
  the sync run's job.

## See also

- [`file-sync.md`](./file-sync.md): adapters, hash identity, two-layer
  state, tool contracts, the sync run's step order.
- [`file-mutation-propagation.md`](./file-mutation-propagation.md):
  tombstones, on-disk move detection, deletion semantics.
- [`data-modes.md`](./data-modes.md): which process runs which engine and
  which routes are device-local.
- `docs/archive/specs/2026-06-28-deterministic-file-state-design.md` and
  `docs/superpowers/specs/2026-08-28-deterministic-file-reconciliation-design.md`:
  the file-state model.
- `docs/superpowers/specs/2026-09-12-remote-watcher-design.md`: the remote
  watcher.
- `docs/superpowers/specs/2026-09-11-one-collaboration-mode-design.md`:
  why a personal workspace has no remote.
