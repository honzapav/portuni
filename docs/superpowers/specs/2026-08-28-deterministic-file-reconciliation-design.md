# Deterministic file reconciliation

Every change to a synced file, on any plane (mirror disk, remote, Portuni
record), is reconciled by the sync run or the watcher without an agent
having to notice it. Decisions that need a human (conflict, restore vs.
delete) are surfaced with actions in the UI; nothing waits for an LLM.

## Rules

1. **Deleted on the remote** (Drive UI, another tool): the sync run's remote
   sweep removes the record and writes a `sync_delete_remote` tombstone.
   Each device then applies the existing tombstone rule: a local copy
   byte-identical to its last synced state is removed; a copy modified after
   the last sync is untracked, adopted and pushed back (local edit wins over
   remote delete). Native Google documents: record + tombstone only.
   Records never pushed (`current_remote_hash IS NULL`) are not touched.
2. **New on the remote** (`new_remote`): the sweep registers the record
   (`adoptFiles`); every device pulls it in the same run. Only paths under
   `<nodeRoot>/{wip,outputs,resources}/` qualify; basenames starting with
   `.` are ignored.
3. **No `orphan` class.** Replaced by:
   - `pull` — remote object exists, this device has no copy and no baseline;
   - `remote_missing` — record exists but the remote object does not (either
     registered elsewhere and never pushed, or gone and awaiting the next
     sweep); skipped by the sync run;
   - `remote_error` — remote stat failed; transient, skipped.
4. **Moves and renames leave tombstones.** `sync_move`, `sync_rename` (per
   file, also from `renameFolder`) carry `node_id` and the old remote path.
   Tombstone matching treats an untracked local copy at a moved-from path
   like a deleted one (same hash guard), so a device that missed the move
   cannot push the old copy back. Cleanup keeps `file_state` when the record
   is still alive.
5. **Mutations are intents.** `moveFile`, `renameFile`, `renameFolder`,
   `deleteFile`, `deleteFileRemote` enqueue a row in `pending_file_ops`
   before the first side effect and remove it on success. A partial failure
   still returns `repair_needed`, but the next sync run retries the op
   idempotently (`retryPendingFileOps`) until it completes; unrepairable ops
   are reported as `pending_repairs` with the last error.
6. **Human decisions have UI actions.** `POST /nodes/:id/files/:fileId/resolve`
   with `keep_local` (push local over remote), `take_remote` (force pull),
   `restore` (pull a locally deleted copy). Delete-everywhere is the existing
   delete. The file row shows the buttons for `conflict` and `deleted_local`.
7. Detection runs only in the deliberate sync run (`POST /nodes/:id/sync`,
   "Synchronizovat"), never in status polling. Push/pull stay deliberate.

## Modes

- Local (owner): `handleSyncRun` runs retry → sweep → scan → push/pull →
  tombstone cleanup → adopt.
- Central (teammate): the agent calls `POST /nodes/:id/sync/remote-sweep` on
  central (retry + sweep run there, where the Drive credentials are), then
  continues with the existing central sync run; tombstones arrive through
  sync-info as today.

## Out of scope

Drive-side renames keep no identity (delete + new record). Drive Changes API,
automatic native-document snapshots.
