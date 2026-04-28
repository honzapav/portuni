# Portuni sync model

Each node can have a local mirror -- a folder on this device that
shadows the node's remote storage. Files are tracked in Portuni's DB,
synced to a remote (Drive, etc.) per the node's routing policy, and
materialised on disk in the mirror.

The same node can be mirrored on multiple devices; each device has its
own `.portuni/sync.db` registry. Stale rows (node deleted on another
device) are skipped and cleaned up lazily.

## Mirror layout

The workspace root is configured via `PORTUNI_WORKSPACE_ROOT`. Each
mirror has standard subdirectories:

- `outputs/` -- final, published files
- `wip/` -- work in progress
- `resources/` -- reference material

Organization workspaces additionally contain `projects/`, `processes/`,
`areas/`, `principles/` for organizing child-node mirrors.

## sync_key vs display name

Remote folder paths are built from immutable `sync_key` identifiers,
NOT from human-readable names. You can rename a node freely; remote
folders stay stable. This is why `portuni_get_node` returns both the
display name (mutable) and the local path (derived from sync_key).

## File-sync workflow

The model is "tracked or not, drift detectable". A file is one of:

- **tracked**: registered in Portuni DB, with a known sync_key path
  and last-synced hash.
- **untracked local**: present in the mirror folder, no DB row.
- **untracked remote**: present on the remote, no DB row.

`portuni_status` scans tracked files and (with `include_discovery=true`,
the default) reports untracked local + untracked remote + deleted
local. Each tracked file is classified:

- **clean** -- local hash == remote hash == last-synced hash
- **push** -- local newer than remote
- **pull** -- remote newer than local
- **conflict** -- both diverged
- **orphan** -- DB row exists, file gone from both sides
- **native** -- non-byte-stream remote (e.g. Google Doc) where hash
  comparison doesn't apply

Reconcile drift via:

- `portuni_store(node_id, local_path)` -- promote a new local file to
  tracked.
- `portuni_pull(file_id)` -- download remote content into the mirror
  for a tracked file.
- `portuni_adopt_files(node_id, paths)` -- register existing remote
  files (surfaced as `new_remote` by `portuni_status`) as tracked
  files.
- `portuni_delete_file(file_id, mode)` -- remove a tracked file.
  `complete` removes remote+local+DB row; `unregister_only` drops
  just the DB row when the file is already gone from disk and
  remote.

## Confirm-first patterns

Destructive sync operations require explicit confirmation. The pattern
is "first call previews, second call applies":

- `portuni_delete_file` -- first call returns a preview; second call
  with `confirmed: true` executes.
- `portuni_move_file` -- first call returns a preview; second call
  with `confirmed: true` executes.
- `portuni_rename_folder` -- defaults to `dry_run: true`. Show the
  affected file list to the user; second call with `dry_run: false`
  applies.
- `portuni_adopt_files` -- non-destructive. Safe to run after
  `portuni_status` surfaces `new_remote` entries.

The agent must surface the preview to the user verbatim (or summarise
faithfully), get explicit confirmation, and only then re-call with
the apply flag. Never fabricate user confirmation.

## Operation semantics

- Operations are best-effort ordered: remote, then local, then DB.
- On partial failure the service returns a structured status
  `repair_needed` with a `repair_hint` describing the next step.
  Surface the hint to the user and follow it.

## Data-safety defaults

- Portuni never auto-deletes and never auto-merges conflicts.
- File identity is by hash, not timestamp.
- Remote delete is soft (Drive trash, 30-day recovery). Drive
  versioning is not disabled by Portuni.

## Session discipline

After any local file modification in a Portuni-mirrored repo (`git mv`,
`git rm`, edits, plain `mv`), call `portuni_status` before ending the
turn. This detects drift between local files, the Portuni DB, and the
remote -- catching it inside the same session keeps reconciliation
cheap. Skipping the check leaves silent drift for the next session
to discover.
