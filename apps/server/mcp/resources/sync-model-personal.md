# Portuni file model (personal workspace)

This is a personal workspace: one person, one device, no remote. Files
live in the node's local mirror on this device and nowhere else; there
is nothing to upload, download or synchronize.

## Mirror layout

The workspace root is configured via `PORTUNI_WORKSPACE_ROOT`. Each
mirror has standard subdirectories:

- `outputs/` -- final, published files
- `wip/` -- work in progress
- `resources/` -- reference material

Organization workspaces additionally contain `projects/`, `processes/`,
`areas/`, `principles/` for organizing child-node mirrors.

Folder paths are built from immutable `sync_key` identifiers, not from
display names, so renaming a node never moves its files.

## Registration

The desktop app watches every mirror: a file created in `wip/`,
`outputs/` or `resources/` is registered automatically, and edits,
moves and deletions on disk are reflected without any action from you.

## File state

`portuni_status` reports three local classes:

- **clean** -- registered and present on disk
- **deleted_local** -- registered, but the file is gone from disk.
  Remove the record with `portuni_delete_file` once the user confirms
  the file is meant to be gone.
- **new_local** (with `include_discovery=true`, the default) -- on disk
  in a mirror section but not registered yet. Normally the watcher
  registers it within moments; a file that stays here means automatic
  tracking is not active in this environment.

## Moving, renaming, deleting

`portuni_move_file`, `portuni_rename_folder` and `portuni_delete_file`
change the file on disk and its record together.

## Confirm-first patterns

Destructive operations require explicit confirmation. The pattern is
"first call previews, second call applies":

- `portuni_delete_file` -- first call returns a preview; second call
  with `confirmed: true` executes.
- `portuni_move_file` -- first call returns a preview; second call
  with `confirmed: true` executes.
- `portuni_rename_folder` -- defaults to `dry_run: true`. Show the
  affected file list to the user; second call with `dry_run: false`
  applies. An apply call is bounded (`limit`, default 20 files); when
  the result's `remaining` is > 0, call again with the same arguments
  to continue.

The agent must surface the preview to the user verbatim (or summarise
faithfully), get explicit confirmation, and only then re-call with the
apply flag. Never fabricate user confirmation.

## Data-safety defaults

- Portuni never auto-deletes a file.
- File identity is by hash, not timestamp.

## Session discipline

After any local file modification in a mirror (`git mv`, `git rm`,
edits, plain `mv`), call `portuni_status` before ending the turn when
you need to be sure the records match the disk.
