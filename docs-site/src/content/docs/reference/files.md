---
title: Files & Mirrors
description: Tools for file management, per-device mirrors, and remote sync.
---

Files in Portuni live in two places at once: the **remote** (the source of
truth for the team) and the **local mirror** on each device. The metadata
row in `files` binds a node to a remote location; the path on the current
device is derived from the per-device mirror root, the file's `remote_path`,
and the node's `sync_key`. There is no persisted `local_path` column on
`files` -- it would go stale across devices and renames.

## portuni_mirror

Create a local folder for a node on this device and register it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node ID |
| `targets` | string[] | yes | Mirror targets (only `"local"` supported in Phase 1) |
| `custom_path` | string | no | Override default path |

Default path: `{PORTUNI_WORKSPACE_ROOT}/{org-slug}/{type-plural}/{node-sync-key}/`

Creates subdirectories: `outputs/`, `wip/`, `resources/`. Organization
mirrors additionally contain `projects/`, `processes/`, `areas/`,
`principles/` for child nodes.

Mirror registrations are **per device**. Each machine keeps its own copy
of the registry in `~/.portuni/sync.db`; the shared Turso DB does NOT
store per-device paths.

## portuni_store

Copy a file into the node's local mirror, upload it via the routed remote,
and persist a `files` row + `file_state` cache.

:::caution[Register at creation time]
Call `portuni_store` **immediately** after any tool (Claude Code `Write` /
`Edit` / `MultiEdit`, Codex `apply_patch`, shell `cp`/`mv`, app save dialog)
creates a new file inside a mirror's `wip/`, `outputs/`, or `resources/`.
Writing alone places bytes on disk but does **not** create a `files` row --
the next session, the routed remote, and teammates won't see the file.
Treat "create file in mirror" and "call `portuni_store`" as a single
atomic step. The end-of-turn `portuni_status` check is a drift safety
net, not the primary registration path. For files that already exist on
the remote (created elsewhere), use [`portuni_adopt_files`](/reference/sync/#portuni_adopt_files)
instead.
:::

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node ID |
| `local_path` | string | yes | Absolute path of the source file on this device |
| `description` | string | no | File description |
| `status` | enum | no | `wip` (default) or `output` |
| `subpath` | string | no | Optional subfolder within the section |

The file is copied to `{mirror}/wip/...` or `{mirror}/outputs/...` based
on status (or detected from the source path if it already lives inside
the mirror), then uploaded to the remote at
`{org-sync-key}/{type-plural}/{node-sync-key}/{section}/{subpath}/{filename}`.

The remote is resolved through `remote_routing` (priority-ordered).
The `sync_key`-anchored path means renaming a node does NOT change the
remote location, so existing references stay valid.

Returns: `{ file_id, remote_name, remote_path, local_path, hash }`

:::note
The node must have a local mirror on the current device. Run
`portuni_mirror` first.
:::

## portuni_pull

Two modes:

- **`file_id`** -- download the remote version into the mirror, refresh
  the local hash cache. Used to restore a deleted local copy or pull a
  teammate's update.
- **`node_id`** -- preview only. Classifies each file as
  `unchanged | updated | conflict | orphan | native` without modifying
  anything. Use this before pulling to see what would change.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_id` | string | one of | File ID (download mode) |
| `node_id` | string | one of | Node ID (preview mode) |
| `force` | boolean | no | Download mode only. Overwrite the local file even when it has unpushed local changes. Default `false` |

:::note
Download mode refuses to overwrite a local file whose content was never
pushed from this device (or that diverged from the last synced state).
Push the local changes with `portuni_store` first, or pass
`force: true` to overwrite them deliberately.
:::

## portuni_list_files

List files across all nodes with optional filtering. Each row includes a
**derived** `local_path` (from the current mirror + `remote_path` +
`sync_key`); it is `null` when the node has no mirror on this device.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | no | Filter by node |
| `status` | enum | no | Filter by status (`wip` or `output`) |
| `limit` | number | no | Max rows, newest first (default 500, max 2000) |

Returns: Array of files, each with: `id`, `node_id`, `node_name`,
`filename`, `status`, `description`, `remote_name`, `remote_path`,
`current_remote_hash`, `last_pushed_at`, `is_native_format`, the derived
`local_path`, and `updated_at`.

## portuni_status

Scan tracked files and (optionally) discover new local / new remote
files. Call this at session end when files were touched, before major
migrations, or whenever the user asks about sync state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | no | Restrict to one node |
| `remote_name` | string | no | Restrict to one remote |
| `include_discovery` | boolean | no | Walk the mirror + list the remote for new files (default: true) |

Returns: classified buckets (`clean`, `push_candidates`, `pull_candidates`,
`conflicts`, `orphan`, `native`, `new_local`, `new_remote`,
`deleted_local`, `moved`).

## portuni_list_remotes / portuni_setup_remote / portuni_set_routing_policy

Manage the pluggable remote backends and the priority-ordered routing
rules that pick a remote for each `(node_type, org_slug)` combination.
See `concepts/mirrors` for the per-device mirror model.
