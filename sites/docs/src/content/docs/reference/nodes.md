---
title: Nodes
description: Tools for creating and managing nodes in the knowledge graph.
---

## portuni_create_node

Create a new node in the knowledge graph. For every non-organization type, the call atomically creates both the node and its `belongs_to -> organization` edge in a single transaction.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | enum | yes | One of: `organization`, `project`, `process`, `area`, `principle`. Strictly enforced |
| `name` | string | yes | Human-readable name |
| `organization_id` | string | **yes for non-org types** | ULID of an existing organization node. The new node is atomically linked to it via `belongs_to`. Ignored when `type='organization'` |
| `description` | string | no | What this node represents |
| `meta` | object | no | Type-specific JSON data |
| `status` | enum | no | `active` (default), `completed`, `archived`. Prefer setting `lifecycle_state` — status is derived from it |
| `visibility` | enum | no | `team` (default), `private` |
| `goal` | string | no | Optional textual goal / purpose of the node |
| `lifecycle_state` | string | no | Optional primary lifecycle state — type-specific. See [Lifecycle States](/concepts/lifecycle-states/) for the per-type closed set |

Enforcement:

- Node types: strictly enforced at the MCP tool layer (Zod enum) and at the database layer (SQL CHECK constraint on `nodes.type`). There is no way to create a node with a type outside the canonical five POPP entities.
- Organization invariant: every non-organization node belongs to exactly one organization. `organization_id` is validated before the write (must exist and have `type='organization'`). The node and its `belongs_to` edge are inserted in one atomic batch, so the invariant holds from the moment the node exists.

Returns: `{ id, type, name, status, belongs_to?, warning? }` -- `belongs_to` is included for non-organization nodes; `warning` appears when a node with the same name+type already exists (non-blocking, surfaces the duplicate IDs).

## portuni_update_node

Update an existing node. Only provided fields are changed. Pass `null` for nullable fields to clear them.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node ID (ULID) |
| `name` | string | no | New name |
| `description` | string \| null | no | New description |
| `status` | enum | no | New status. Prefer setting `lifecycle_state` — status is derived from it |
| `visibility` | enum | no | New visibility (`team` or `private`) |
| `meta` | object | no | New type-specific JSON data |
| `goal` | string \| null | no | New goal text. Pass `null` to clear |
| `lifecycle_state` | string \| null | no | New lifecycle state — type-specific. See [Lifecycle States](/concepts/lifecycle-states/). Pass `null` to clear |
| `owner_id` | string \| null | no | New owner (`actors.id`). Must reference an actor of `type=person` with `user_id` set (non-placeholder) in the same organization. Pass `null` to clear |

Returns: `{ id, updated: [field names] }`

## portuni_list_nodes

List nodes with optional filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | enum | no | Filter by node type (one of the canonical five) |
| `status` | enum | no | Filter by status |

Returns: Array of `{ id, type, name, status, description }`

## portuni_get_node

Get a single node with rich detail. Use when the user names a specific node or you need fields that `portuni_get_context` (depth 0) omits — `files`, `visibility`, timestamps, `local_mirror` metadata. For traversal (depth >= 1) use `portuni_get_context` instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | no | Node ID (ULID) |
| `name` | string | no | Node name (case-insensitive) |

At least one of `node_id` or `name` must be provided. Name-based lookups are filtered to in-scope candidates so unscoped name probing cannot surface neighbouring node metadata.

Returns: Full node object including:
- Core fields: `id`, `type`, `name`, `description`, `meta`, `status`, `visibility`, `created_by`, `created_at`, `updated_at`
- `goal`, `lifecycle_state` — primary lifecycle fields
- `owner` — `{ id, name }` of the owning actor, or `null`
- `responsibilities` — array, each with `id`, `title`, `description`, `sort_order`, and an `assignees` array
- `data_sources`, `tools` — array of `{ id, name, description, external_link }` rows
- `edges` — direct edges in both directions with peer details
- `files` — attached files with derived `local_path` and metadata
- `events` — recent active events (up to 50, newest first)
- `local_mirror` — `{ local_path, registered_at }` if mirrored on this device, else `null`

## portuni_delete_node

Delete a node. Two modes — `archive` (default, soft delete: sets `status='archived'`, preserves edges and history) and `purge` (hard delete: cascade-deletes all edges, files, events, and mirror registrations). Organizations with children cannot be purged — re-parent or delete children first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node ID (ULID) to delete |
| `mode` | enum | no | `archive` (default) or `purge` |

Returns (archive): `{ id, name, action: "archived" }`.
Returns (purge): `{ id, name, action: "purged", local_mirror_path?, note? }` — `local_mirror_path` and `note` appear when a mirror folder existed; the folder on disk is NOT auto-deleted, only unregistered.

Use only when the user explicitly asks. Purge is permanent — prefer `archive` unless the user has explicitly requested data destruction.
