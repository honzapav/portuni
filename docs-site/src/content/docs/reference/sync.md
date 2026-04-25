---
title: Sync Tools
description: Remote configuration, routing, status, and the destructive operations (move / rename / delete / adopt).
---

The basic file flow – mirror, store, pull, list, status – is documented in [Files & Mirrors](/reference/files/). This page covers the rest of the sync surface: configuring remotes, setting routing policy, and the destructive operations.

For the conceptual model see [Local Mirrors](/concepts/mirrors/).

## Remote configuration

A **remote** is a backend storage configuration. One row per remote in the `remotes` table. The same Portuni instance can have many remotes – e.g. one Google Shared Drive per organization.

### portuni_setup_remote

Register a new remote and store its credentials.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Unique remote name (e.g. `drive-workflow`, `drive-tempo`) |
| `type` | enum | yes | `gdrive`, `dropbox`, `s3`, `fs`, `webdav`, or `sftp` |
| `config` | object | yes | Backend-specific configuration. For `gdrive`: `{ shared_drive_id, root_folder_id? }` |
| `service_account_json` | string | conditional | Required for `gdrive`. Stored via TokenStore (file / keychain / varlock), never in Turso |

For Google Drive the `shared_drive_id` is mandatory – Phase 1 supports Shared Drives only, not personal "My Drive."

### portuni_list_remotes

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

Returns: array of remotes with their public config (no credentials) plus the routing rules attached to each.

## Routing policy

Routing tells Portuni *which* remote to use for a given `(node_type, org_slug)` combination. Rules are priority-ordered – the first match wins.

### portuni_set_routing_policy

Add or replace a routing rule.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_type` | enum | yes | `project`, `process`, `area`, `principle`, `organization`, or `*` for any |
| `org_slug` | string | yes | Specific org sync_key, or `*` for any |
| `remote_name` | string | yes | The target remote |
| `priority` | number | yes | Lower wins. Use `100` for typical "default" rules, `10` for high-priority overrides |

Example: route every project across every org to the shared `projects-hub` drive, but route Workflow's processes to the workflow-specific drive.

```
portuni_set_routing_policy { node_type: "project",  org_slug: "*",        remote_name: "projects-hub", priority: 100 }
portuni_set_routing_policy { node_type: "process",  org_slug: "workflow", remote_name: "drive-workflow", priority: 10 }
portuni_set_routing_policy { node_type: "process",  org_slug: "*",        remote_name: "shared-processes", priority: 100 }
```

A node looking for its remote checks rules in priority order and uses the first match.

## Snapshot

### portuni_snapshot

Capture a point-in-time view of remote state for a node. Used for diagnostics and for round-tripping native Drive formats (Docs / Sheets / Slides) into a tracked file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node to snapshot |
| `format` | enum | no | For native Drive files: `pdf`, `markdown`, `docx`. Default `pdf` |

Returns a list of remote files with their hashes, modification times, and (where applicable) the exported snapshot as a tracked file.

## Destructive operations

All three operations below are confirm-first. The first call returns a preview with `confirm_token`; the operation only executes when called again with that token.

### portuni_move_file

Move a tracked file to a different node, a different path within the same node, or both.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_id` | string | yes | File to move |
| `target_node_id` | string | no | New owning node (same node if omitted) |
| `target_subpath` | string | no | New subpath within the node's section |
| `confirm_token` | string | no | Required on the second call |

Returns either a preview (no `confirm_token` supplied) or the executed result. Partial failures (file moved on remote but DB row not updated, or vice versa) return `repair_needed: true` with details so an operator can finish the move manually.

### portuni_rename_folder

Rename a node's remote folder. Updates `sync_key`-anchored paths atomically across the file table and the remote.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node whose folder to rename |
| `new_name` | string | yes | New folder name (the underlying `sync_key` does not change – this is a display rename) |
| `confirm_token` | string | no | Required on the second call |

`sync_key` itself is immutable. This tool changes the visible folder name on the remote (and updates `remote_path` for every file in the folder) without changing the identifier the system uses for routing.

### portuni_delete_file

Delete a tracked file locally and on the remote.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_id` | string | yes | File to delete |
| `confirm_token` | string | no | Required on the second call |

Returns the preview or the executed result. For Drive remotes, "delete" means moving to Drive's trash (30-day recovery window) – Portuni does not hard-delete.

## Adoption

### portuni_adopt_files

Adopt files that already exist on the remote into the graph as tracked `files` rows. Useful when migrating an existing folder of work into Portuni, or when files were uploaded to the remote outside of Portuni and now need to be tracked.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node to adopt files into |
| `remote_paths` | string[] | yes | Paths on the remote (relative to the node's remote root) |
| `status` | enum | no | `wip` (default) or `output` |

Returns: array of adopted `files` rows, including computed hashes. Existing tracked files at the same paths are skipped (idempotent).

## See also

- [Files & Mirrors](/reference/files/) – the core file flow (mirror, store, pull, list, status)
- [Local Mirrors](/concepts/mirrors/) – how mirrors and remotes fit together
- [Setting up remotes](/guides/setting-up-remotes/) – step-by-step Google Drive Service Account setup
