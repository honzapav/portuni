# Remote watcher: the remote side of file state becomes maintained state

File state has two sides. The local side is maintained: the mirror watcher
registers and reconciles on every disk event, and a periodic backfill sweep
catches up whatever the watcher missed. The remote side is not: a file that
appears, changes or disappears on Drive is noticed only inside a deliberate
sync run (`remoteSweep`, `resolveUnknownRemotes`). A node nobody syncs never
learns about it, and a node with no records cannot even start a sync run
from the UI.

The remote watcher is the missing counterpart: the central server observes
Drive and keeps `files` current, the same way the device's mirror watcher
keeps the local side current. Builds on
`2026-09-11-one-collaboration-mode-design.md`: Drive credentials live on
central only, so central is the only place this can run.

## Rules

1. **The remote side is observed, not re-derived on read.** `files` rows
   (`remote_path`, `current_remote_hash`, existence) are kept current by a
   process on central. `portuni_status`, `sync-info` and the UI poll read
   that state; none of them lists Drive.
2. **Registration only, no bytes to devices.** The watcher registers a new
   remote file (record + hash), refreshes the hash of a changed one, and
   deletes the record + tombstone of a removed one. A device with a mirror
   then sees `pull`; the bytes arrive through a deliberate sync, as today.
   Symmetric with the mirror watcher, which registers but never pushes.
   The user learns about the change, not the mirror: a registered `pull`
   record already lights the Files-tab dot and the SyncBar count on the
   device; what is missing is a signal outside the node detail (sync
   overview, sidebar badge), a small UI item that follows the watcher.
3. **Events plus catch-up, the same shape as the local side.** Drive Changes
   API is the event source; the existing full `remoteSweep` is the catch-up.
   Neither is optional: the sweep is what makes a lost page token, a boot
   after downtime, or a backend without a change feed recover.
4. **The watcher applies exactly what the sweep would.** One file changed on
   Drive goes through the same adopt / hash-refresh / delete + tombstone
   code the sweep runs for a whole node. No second classification path.
5. **Central only.** Local mode has no remote after the one-collaboration-mode
   spec lands; until then a local workspace with a remote keeps today's
   behaviour (sweep inside a deliberate sync run) and gets nothing new.

## Components

### Adapter: `changes()`

`StorageAdapter` gains an optional capability:

```ts
changes?(cursor: string | null): Promise<{
  cursor: string;
  changes: RemoteChange[];
  reset: boolean;          // cursor was invalid; caller must full-sweep
}>;
type RemoteChange =
  | { kind: "upsert"; path: string; hash: string | null; modified_at: Date; is_folder: boolean }
  | { kind: "remove"; path: string | null; file_id: string };
```

Drive implements it with `changes.getStartPageToken` (`driveId` =
`shared_drive_id`) and `changes.list` (`includeItemsFromAllDrives`,
`fields: newStartPageToken,nextPageToken,changes(fileId,removed,file(id,name,
mimeType,parents,md5Checksum,modifiedTime,trashed))`). A `trashed` file is a
`remove`. Path resolution reuses `search()`'s ancestor walk (`pathFor`),
promoted out of `search` and backed by a persistent `folder id -> path`
cache (see Storage) so a change costs 0–1 `files.get`, not a walk to the
root every tick. A change whose ancestry does not reach `driveRoot` is
dropped. A `404`/`410` on the page token returns `reset: true`.

fs and OpenDAL do not implement `changes()`; they run on catch-up alone.

### Domain: `domain/sync/remote-watcher.ts`

One loop per remote that implements `changes()`:

1. Load the remote's cursor. None → take a start token, then run a full
   sweep of every node routed to this remote (the baseline).
2. Every tick (`PORTUNI_REMOTE_WATCH_INTERVAL_MS`, default 60 000): call
   `changes(cursor)`. On `reset`, go to 1.
3. For each change, resolve `(nodeId, section)` from the path via the
   existing node-root logic (`buildNodeRoot` + `adoptableSection`); drop
   what falls outside a tracked section. Group by node, then apply per node
   under `withPathLock("<remote>:<remote_path>")`:
   - `upsert`, no record → adopt (same call as `remoteSweep` §2).
   - `upsert`, record exists, hash differs → refresh `current_remote_hash`
     (same as sweep §1.5).
   - `remove`, record exists and had an object → confirm with one `stat`,
     then delete + `sync_delete_remote` tombstone (same as sweep §1).
   - `remove`, no record → nothing.
4. Persist the new cursor only after every change in the batch is applied;
   a crash mid-batch replays the batch, and every step above is idempotent.

Catch-up: `remoteSweep` for every node routed to the remote, bounded
concurrency 3 (`PORTUNI_SYNC_JOB_CONCURRENCY`, the bulk-sync setting), at boot, after a `reset`,
and every `PORTUNI_REMOTE_SWEEP_INTERVAL_MS` (default 6 h). Runs through the
same `sync-jobs.ts` worker pool the bulk sync uses, so it never overlaps a
user-triggered job on the same node.

Guards, all reusing `central/reachability.ts`: skip a tick while the
previous one runs; exponential backoff on Drive `429`/`5xx`/network
(60 s → 2 → 4 → … cap 1 h), reset on success; a tick that fails leaves the
cursor untouched.

### Boot

`boot/remote-watch.ts`, started from `index.ts` only when
`PORTUNI_AUTH_MODE=google` (the central server). An env-mode server never
starts it (rule 5). Single instance in-process, like `backfillSweep`. If
central ever runs more than one instance, the loop needs a DB lease before
it is safe; noted, not built.

### Storage

Migration adds:

- `remote_cursors (remote_name PK, cursor TEXT, updated_at)` — the Changes
  page token per remote.
- `remote_folder_cache (remote_name, folder_id, path, PRIMARY KEY
  (remote_name, folder_id))` — the ancestor cache; rows are dropped when a
  folder is renamed/moved (a folder `upsert` whose path differs) or `remove`d.

### API and UI

- `SyncRunResponse` unchanged. `GET /sync/watch` (read) returns per remote:
  `cursor_updated_at`, `last_tick_at`, `last_error`, `backoff_until`,
  `last_full_sweep_at`. Settings → Synchronizace shows it as one line per
  remote ("Drive sledován, poslední změna před 2 min").
- Node detail, Files tab: `SyncBar` mounts whenever the node has a mirror,
  regardless of record count, and stays enabled with the label
  „Zkontrolovat remote" when nothing is pending. `POST /sync/jobs` with no
  `node_ids` keeps its `total > 0` default. This is a separate, bounded
  change and does not wait for the watcher.

## Cost on central

For today's central (1 remote, ~95 active nodes):

| what | calls to Drive | when |
|---|---|---|
| tick, no changes | 1 | every 60 s → 1 440/day |
| one change | 1 + 0–1 `files.get` (+1 `stat` for a remove) | per change |
| full sweep | ~1 `files.list` per folder, ~1 000 per round | boot, reset, every 6 h → ~4–5 k/day |

Project quota is 12 000 queries/min; the steady state is well under 1 % of
it. Bursts stay under Drive's per-user rate limit through the bounded
concurrency. Turso: one read per touched node, writes only on a difference;
an idle tick writes nothing. Nothing changes on the device: it reads
maintained state, as it does for the local side.

## Testing

- `changes()` for Drive against the mocked `driveFetch`: first token,
  pagination, `removed`/`trashed`, path resolution through the cache,
  `reset` on an invalid token.
- Watcher core as a pure reducer over `RemoteChange[]` + a fake adapter +
  the in-memory schema: adopt, hash refresh, delete + tombstone, out-of-root
  drop, out-of-section drop, cursor persisted only after a full batch,
  replay of a batch is a no-op.
- Catch-up never overlaps a user job on the same node (sync-jobs pool).
- End to end on the fake central server (`test/central/*`): a file added to
  the fake Drive shows up as `pull` on the device's next status read without
  any sync run.

## Out of scope

- Automatic pull into a device mirror, including pull on opening a node
  (rule 2): both are an unrequested write into the mirror.
- Drive push notifications (`changes.watch`: Google calls a public HTTPS
  endpoint with an empty "something changed" request; the server still has
  to call `changes.list`). Can later trigger the same tick early; channel
  renewal and verification are not worth it at a 60 s interval.
- Change feeds for fs/OpenDAL backends.
- A DB lease for multi-instance central (a row naming which instance runs
  the loop until a deadline, renewed each tick; a second instance stays
  idle). Central is one process today; two would double every Drive call
  and race on the cursor.
- Local mode: no new behaviour (rule 5).

## References

- `docs/superpowers/specs/2026-09-11-one-collaboration-mode-design.md` —
  why Drive access is central-only.
- `docs/superpowers/specs/2026-08-28-deterministic-file-reconciliation-design.md`
  — the local-side model this mirrors.
- `apps/server/domain/sync/remote-sweep.ts` — the per-file operations the
  watcher reuses.
- `apps/server/domain/sync/central/reachability.ts` — backoff.
- `apps/server/domain/sync/sync-jobs.ts` — the worker pool for catch-up.
