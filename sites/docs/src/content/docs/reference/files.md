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
(organizations mirror directly to `{PORTUNI_WORKSPACE_ROOT}/{org-slug}/`).

Locally, every mirror gets the `outputs/`, `wip/`, `resources/`
subdirectories. The org-plural subfolders (`projects/`, `processes/`,
`areas/`, `principles/`) are scaffolded on the **remote** when an
organization is mirrored; locally they appear only as parent directories
once child nodes are mirrored.

Returns: `{ node_id, local_path, subdirs, remote_scaffold, scope_config }` —
`remote_scaffold` lists the remote folders created and the resolved
`remote_name`; `scope_config` lists the per-mirror config files written.

Mirror registrations are **per device**. Each machine keeps its own copy
of the registry in `{PORTUNI_WORKSPACE_ROOT}/.portuni/sync.db`; the shared
Turso DB does NOT store per-device paths.

## portuni_store

Copy a file into the node's local mirror, upload it via the routed remote,
and persist a `files` row + `file_state` cache.

:::note[Registration is automatic — store is a deliberate push]
New files created inside a mirror's `wip/`, `outputs/`, or `resources/`
(by any tool — Claude Code `Write`/`Edit`, Codex `apply_patch`, shell
`cp`/`mv`, app save dialog) are registered **automatically** by the mirror
watcher: a local-only `files` row is created, no upload happens, and file
status stays current without any agent action. Such a file reads as
`push` until someone deliberately pushes it. Reach for `portuni_store`
when you explicitly want to **push** a file to the remote.

The watcher is default-on only in the desktop sidecar; the standalone
server needs `PORTUNI_WATCH_MIRRORS=1`. In a watcher-less environment the
old advice still applies: call `portuni_store` right after creating a
file in a mirror, since nothing else registers it (`portuni_status`
surfaces such files as `new_local`). For files that already exist on
the remote (created elsewhere), use [`portuni_adopt_files`](/reference/sync/#portuni_adopt_files)
instead.
:::

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node ID |
| `local_path` | string | yes | Absolute path of the source file on this device |
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
  `unchanged | updated | conflict | remote_missing | remote_error | native`
  without modifying anything. Use this before pulling to see what would
  change.

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

`local_path` is the node's **real** mirror for the home node and its
depth-1 neighbours (the seatbelt grants read on those real paths). For an
ad-hoc in-scope node (deeper than depth-1) it is `null` — the files are
not on disk; read their content with `portuni_read_file` (below). See
[disk read scope](/concepts/scope-enforcement/).

Scope gating: with `node_id` the node must be in session scope (out of
scope returns `scope_expansion_required`). Without `node_id` results are
restricted to the current session scope set (empty scope returns an
empty array) — no confirmation needed, it is not a broad query. The same
gating applies to `portuni_list_events`. `portuni_search_files` and
`portuni_list_nodes(scope: "global")` are the exception — see below and
[scope enforcement](/concepts/scope-enforcement/).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | no | Filter by node |
| `status` | enum | no | Filter by status (`wip` or `output`) |
| `limit` | number | no | Max rows, newest first (default 500, max 2000) |

Returns: Array of files, each with: `id`, `node_id`, `node_name`,
`filename`, `status`, `remote_name`, `remote_path`,
`current_remote_hash`, `last_pushed_at`, `is_native_format`, the derived
`local_path`, and `updated_at`.

## portuni_read_file

Read a file's content from an in-scope node the seatbelt does not expose on
its **real** mirror path — an ad-hoc node reached by deeper graph traversal
(beyond the home node and its depth-1 neighbours, whose folders you read
natively via the `local_path` returned by `portuni_get_context` /
`portuni_get_node`). Such a node, if it has a local mirror on this device,
is also readable natively at its hardlink projection directory (same
`local_path` field, created on first touch — see [disk read
scope](/concepts/scope-enforcement/)); `portuni_read_file` is the channel
that works regardless, since it has no dependency on a local mirror at all.
The server reads the live file from the node's local mirror when one
exists — no stale copy — and otherwise, when the serving machine holds
**no mirror** of the node (the central server, or a remote client such as
Claude Desktop against `https://…/mcp` with a device token, with no local
workspace), reads straight from the node's routed remote (Google Drive),
the same path `GET /nodes/:id/file` takes. In agent mode the sidecar reads
its own mirror first and proxies the call to central when it has none.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node the file belongs to |
| `path` | string | yes | File path within the node, e.g. `wip/notes.md` |

Returns the file content as UTF-8 text, or `[binary file, N bytes, base64]`
followed by base64 for non-text files. Scope-gated exactly like
`portuni_get_node`: reading a node not yet in scope returns
`scope_expansion_required` (call `portuni_expand_scope` first). Errors when
the file does not exist, the file exceeds the 1 MB inline limit, the file is
a native Google format (Doc/Sheet/Slides — no byte content), or the node has
neither a mirror on this device nor a routed remote.

## portuni_search_files

Search file **contents** across Portuni-tracked files. The search runs on
the configured remote(s) — Google Drive's `fullText contains` (which indexes
Docs, PDFs and text files; whole words and phrases, not substrings or regex)
or a text grep on an `fs` remote — and each hit is joined back onto the
`files` registry, so a loose Drive object Portuni never registered is never
returned. Search is discovery, not ingestion: it is **permission-only in
every session type** — no scope gate, with or without `node_id`. Results
are limited only to nodes the caller can see (group visibility). Each hit
carries a short, length-capped snippet, not the full file; read a hit in
full with `portuni_read_file`, which follows the normal scope-expansion
rules. See [scope enforcement](/concepts/scope-enforcement/).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Words or a phrase to find in file contents |
| `node_id` | string | no | Restrict to one node |
| `limit` | number | no | Max hits (default 20, max 50) |

Returns: Array of hits, each with `file_id`, `node_id`, `node_name`,
`node_type`, `filename`, `path` (the node-relative path, e.g.
`wip/notes.md`), `mime_type`, and when the remote provides them
`modified_at` and `snippet` (Drive returns no snippet). Open a hit with
`portuni_read_file(node_id, path)`.

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
`conflicts`, `remote_missing`, `remote_error`, `native`, `new_local`,
`new_remote`, `deleted_local`, `deleted_remote`, `moved`).

:::note[Deletions and moves propagate deterministically]
- **`deleted_remote`** — an untracked disk copy whose record was removed
  from the remote (web UI, another device, or noticed by a deliberate sync
  run's remote sweep — see [Deliberate sync run](/reference/sync/#deliberate-sync-run)).
  Discovery matches it against the node's delete tombstones — same path, a
  local `file_state` row for the tombstoned id, and a disk hash equal to the
  last synced state — and the next sync run removes the local copy instead
  of re-uploading it. A file **modified after** the delete fails the hash
  check and stays `new_local`; local data is never destroyed.
- **On-disk `mv`** is paired by inode identity at watcher registration
  time and applied through the real move (remote rename, Drive file ID
  preserved) — one record, no duplicate. A cross-volume move (inode
  changes) falls back to plain registration. The `moved` bucket is kept
  for API compatibility and is always empty.
- **Deleting a never-pushed file on disk unregisters it** from Portuni
  entirely (it was metadata-only). Deleting a pushed file keeps the
  record and the remote copy (`deleted_local`) for an explicit decision —
  see [Resolving conflicts and deletions](/reference/sync/#resolving-conflicts-and-deletions).
- **`remote_missing`** and a new-on-the-remote file are only reconciled by
  a deliberate sync run's remote sweep, not by `portuni_status` itself —
  the sweep deletes+tombstones a record whose remote object is confirmed
  gone, and adopts a file newly present anywhere under `wip/`,
  `outputs/`, or `resources/` at any depth (a dot-prefixed filename or subfolder is
  skipped).
- **A remote is not required for tracking.** In a local-only workspace (no
  remote configured at all), a new file still registers and reads as
  `push_candidates` — registration never depends on routing resolving.
  Once a remote is connected, `portuni_store` (or any other deliberate
  write) resolves it and backfills the record's `remote_name`.
:::

## portuni_list_remotes / portuni_setup_remote / portuni_set_routing_policy

Manage the pluggable remote backends and the priority-ordered routing
rules that pick a remote for each `(node_type, org_slug)` combination.
See `concepts/mirrors` for the per-device mirror model.
