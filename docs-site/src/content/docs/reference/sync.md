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

Replace the entire `remote_routing` table with a new list of rules. Every existing rule that is not in the new list is deleted. Use only when the user explicitly asks to overwrite the routing policy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rules` | array | yes | Full ordered list of routing rules — see shape below |

Each rule object:

| Field | Type | Description |
|-------|------|-------------|
| `priority` | number | Lower wins. Use `100` for typical defaults, `10` for high-priority overrides |
| `node_type` | string \| null | Specific node type (`project`, `process`, `area`, `principle`, `organization`), or `null` for any |
| `org_slug` | string \| null | Specific org `sync_key`, or `null` for any |
| `remote_name` | string | Target remote (must already exist) |

Example — route every project across every org to the shared `projects-hub` drive, but route Workflow's processes to the workflow-specific drive:

```
portuni_set_routing_policy {
  rules: [
    { priority: 10,  node_type: "process", org_slug: "workflow", remote_name: "drive-workflow" },
    { priority: 100, node_type: "process", org_slug: null,       remote_name: "shared-processes" },
    { priority: 100, node_type: "project", org_slug: null,       remote_name: "projects-hub" }
  ]
}
```

`resolveRemote(nodeType, orgSlug)` picks the first rule whose `node_type` either matches or is `null`, and whose `org_slug` either matches or is `null`, ordered by ascending `priority` then insertion order.

Returns: `{ count: number }` — the number of rules now in the table.

## Snapshot

### portuni_snapshot

Export a Google Docs/Sheets/Slides URL to PDF / Markdown / DOCX and store it as a tracked file on the node. Use when the user wants a point-in-time copy of a native Google doc tracked on a node — e.g. archiving a spec snapshot before continuing edits.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node to attach the exported file to |
| `doc_url` | string | yes | URL of a Google Doc / Sheet / Slide. Must contain `/d/<id>/` — the Drive file ID is extracted from this segment |
| `format` | enum | no | `pdf` (default), `markdown`, or `docx` |
| `filename` | string | no | Override the default filename (`snapshot-<timestamp>.<ext>`) |
| `subpath` | string \| null | no | Optional subfolder within the node's section |

Returns: `{ file_id, filename, remote_path }` — the exported buffer is stored via the same flow as `portuni_store`.

## Destructive operations

All three operations below are confirm-first. The first call returns a preview without acting; show the preview to the user, then call again with `confirmed: true` to execute. Best-effort ordered (remote, then local, then DB) — partial failures return `repair_needed` with a hint for manual recovery.

### portuni_move_file

Move a tracked file within its node (new subpath or section) or to a different node.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_id` | string | yes | File to move |
| `new_node_id` | string | no | Move to a different node (cross-node move) |
| `new_section` | enum | no | `wip`, `outputs`, or `resources` — re-section within the same node |
| `new_subpath` | string \| null | no | New subpath within the section. Pass `null` to clear |
| `confirmed` | boolean | no | First call returns a preview; pass `true` on the second call to execute |

Returns either a preview (when `confirmed` is omitted or `false`) or the executed result. Partial failures return `repair_needed: true` with a hint.

### portuni_rename_folder

Rename a subpath within a node's sync layout. Updates `remote_path` for every file under the prefix atomically.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node whose folder to rename |
| `old_prefix` | string | yes | Existing subpath prefix (relative to the node's section root) |
| `new_prefix` | string | yes | New subpath prefix |
| `dry_run` | boolean | no | Defaults to `true` — returns a preview of affected files. Call again with `dry_run: false` to apply |

`sync_key` itself is immutable — this tool only changes the visible subpath. The underlying identifier the system uses for routing does not change.

### portuni_delete_file

Delete a tracked file. Two modes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_id` | string | yes | File to delete |
| `mode` | enum | no | `complete` (default — removes remote + local + DB row) or `unregister_only` (DB row only; use when the file is already gone from disk and remote) |
| `confirmed` | boolean | no | First call returns a preview; pass `true` on the second call to execute |

Returns the preview or the executed result. For Drive remotes, "delete" means moving to Drive's trash (30-day recovery window) – Portuni does not hard-delete via the remote API.

## Adoption

### portuni_adopt_files

Register existing remote files (not currently tracked) as `files` rows for the given node. Non-destructive. Use after `portuni_status` surfaces `new_remote` entries to bring them under tracking.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node to adopt files into |
| `paths` | string[] | yes | Paths on the remote (relative to the node's remote root) |
| `status` | enum | no | `wip` (default) or `output` |

Returns: array of adopted `files` rows, including computed hashes. Existing tracked files at the same paths are skipped (idempotent).

## See also

- [Files & Mirrors](/reference/files/) – the core file flow (mirror, store, pull, list, status)
- [Local Mirrors](/concepts/mirrors/) – how mirrors and remotes fit together
- [Setting up remotes](/guides/setting-up-remotes/) – step-by-step Google Drive Service Account setup
