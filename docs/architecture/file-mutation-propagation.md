# File mutation propagation (delete / move / rename)

A file mutation can originate on three planes, and each plane has exactly one
mechanism that reconciles the other side (disk ↔ record). All three are
deterministic — no agent involvement, no silent skips.

| Origin | Mechanism | Code |
|---|---|---|
| MCP tool on this device (central mode) | Agent front door: snapshot before proxy, local disk step after a confirmed success | `mcp/agent-tools.ts` (`snapshotForDiskMutation` / `applyLocalAfterProxiedMutation`), wired in `mcp/agent-transport.ts` (GH #78) |
| Web UI / another device / any remote plane | Delete tombstones in sync-info, matched during discovery, cleaned by the sync run | `sync-remote-api.ts` (`NodeSyncInfo.deleted`), `engine.ts` (`matchDeleteTombstones` / `cleanupDeletedRemote`), `engine-central.ts` (`matchTombstonesForContext`) (GH #79) |
| Raw `mv` / `rm` on disk | Watcher pairing at registration time by inode identity; unregister of never-pushed deletions | `reconcile.ts` (`tryApplyDiskMove`, unregister branch), `engine-central.ts` (`tryApplyDiskMoveCentral`) |

## Tombstones (GH #79)

`deleteFile` (local) and `deleteFileRemote` (central) stamp `node_id` into
their audit detail. `getNodeSyncInfo` exposes the last 200 exact-match
`sync_delete` / `sync_delete_remote` rows per node as
`deleted: {file_id, remote_path}[]`. `*_repair_needed` actions are never
tombstones — there the remote copy still exists.

Match rule (all three required, makes cleanup lossless by construction):

1. local path derived from the tombstone's `remote_path` equals the untracked
   file's path;
2. a `file_state` row for the tombstoned `file_id` exists on this device;
3. its `last_synced_hash` equals the current disk hash.

A file modified after the delete fails (3) and stays `new_local`. Matched
files classify `deleted_remote`; the sync run (`handleSyncRun` local,
`syncRunCentral` central) removes the local copy and the orphaned
`file_state` row and reports them in `SyncRunResponse.deleted_remote`. The
pending aggregates count `deleted_remote` as untracked pending work.
Tombstones written before `node_id` landed in the detail never match — the
mechanism works going forward only.

## On-disk move detection

The old `moveDetectionPhase` (statusScan, paired `deleted_local` ×
`new_local`) was dead code whenever the watcher ran: the new path was
registered before any scan could see it as `new_local`. Detection now lives
where it can see the move — the watcher's registration path:

- `file_state` carries `cached_ino` / `cached_dev` (additive sync.db
  migration), stamped by every cache writer via `statForCache`.
- When a path with no record appears, `findFileStateByInode` looks for a
  record whose cached copy had the same inode (rename(2) preserves it on the
  same volume). The pairing requires: record still exists, its derived local
  path differs and is gone from disk, and the new path's content hash equals
  the record's last known local hash (guards inode reuse and copies).
- Applied via `moveFile` with `confirmed: true` (real `adapter.rename`,
  Drive file ID — and thus shared links, comments, version history —
  preserved). `moveFile` gained optional `newFilename`, so one rename covers
  a combined move+rename. Never-pushed records are retargeted with a plain
  record update (no remote object exists). Central mode goes through
  `POST /nodes/:nodeId/files/:fileId/move` (`CentralClient.moveFileRecord`).
- Watcher reconciles are serialized in event order (`mirror-watcher.ts`):
  the mv emits events for both paths in arbitrary order and the second
  event's handling depends on the first's outcome.
- Cross-volume `mv` changes the inode and falls back to plain registration.
  The `moved` bucket in `StatusResult` is kept for API compatibility and is
  always empty.

## Deletion semantics (one action, one outcome)

- Never-pushed file deleted on disk → the record is unregistered entirely
  (`sync_unregister` audit locally; record-only DELETE on central). It was
  metadata-only; keeping it produced the confusing `orphan` state.
- Pushed file deleted on disk → record + remote copy intentionally kept,
  classifies `deleted_local` for an explicit decision (restore via
  `portuni_pull`, remove via `portuni_delete_file`). Unchanged behavior.
- Both delete paths `adapter.stat` the remote object before deleting it, so
  deleting a registered-but-never-pushed record cannot surface a bogus
  `repair_needed`.

## Known limitations

- A file **edited (not yet re-pushed) and then moved**, when the old-path
  event happens to process first, fails the hash guard (the delete branch
  nulls `cached_local_hash` and `last_synced_hash` still holds the pre-edit
  content) and degrades to today's behavior: duplicate registration +
  `deleted_local` on the old record for an explicit user decision. No data
  is lost.

- The per-node status endpoint (`GET /nodes/:id/sync/status`) runs without
  discovery, so its `untracked` list can transiently show a tombstoned copy;
  the next sync run cleans it.
- A cross-mirror `mv` in central mode falls back to plain registration
  (candidates are limited to the node's own records).
- Tombstone matching starts with deletions performed after this change
  (older audit rows lack `node_id`).

Plan: `docs/superpowers/plans/2026-07-19-delete-move-rename-propagation.md`;
issues: GH #78, #79 (both closed by this work), #80 (client timeout,
prerequisite).
