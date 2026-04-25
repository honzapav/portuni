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

## portuni_list_files

List files across all nodes with optional filtering. Each row includes a
**derived** `local_path` (from the current mirror + `remote_path` +
`sync_key`); it is `null` when the node has no mirror on this device.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | no | Filter by node |
| `status` | enum | no | Filter by status (`wip` or `output`) |

Returns: Array of files with `node_name`, `remote_name`, `remote_path`,
`current_remote_hash`, `last_pushed_at`, `is_native_format`, and the
derived `local_path`.

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
`deleted_local`).

## portuni_list_remotes / portuni_setup_remote / portuni_set_routing_policy

Manage the pluggable remote backends and the priority-ordered routing
rules that pick a remote for each `(node_type, org_slug)` combination.
See `concepts/mirrors` for the per-device mirror model.
