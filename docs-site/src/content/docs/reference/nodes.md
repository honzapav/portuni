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
| `status` | enum | no | `active` (default), `completed`, `archived` |
| `visibility` | enum | no | `team` (default), `private` |

Enforcement:

- Node types: strictly enforced at the MCP tool layer (Zod enum) and at the database layer (SQL CHECK constraint on `nodes.type`). There is no way to create a node with a type outside the canonical five POPP entities.
- Organization invariant: every non-organization node belongs to exactly one organization. `organization_id` is validated before the write (must exist and have `type='organization'`). The node and its `belongs_to` edge are inserted in one atomic batch, so the invariant holds from the moment the node exists.

Returns: `{ id, type, name, status, belongs_to?, edge_id? }` -- `belongs_to` and `edge_id` are included for non-organization nodes.

## portuni_update_node

Update an existing node. Only provided fields are changed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node ID (ULID) |
| `name` | string | no | New name |
| `description` | string | no | New description |
| `status` | enum | no | New status |
| `meta` | object | no | New metadata |

Returns: `{ id, updated: [field names] }`

## portuni_list_nodes

List nodes with optional filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | enum | no | Filter by node type (one of the canonical five) |
| `status` | enum | no | Filter by status |

Returns: Array of `{ id, type, name, status, description }`

## portuni_get_node

Get a single node with full details: edges, files, events, and local mirror path.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | no | Node ID (ULID) |
| `name` | string | no | Node name (case-insensitive) |

At least one of `node_id` or `name` must be provided.

Returns: Full node object including:
- Core fields (id, type, name, description, meta, status, visibility, timestamps)
- `edges` -- direct edges in both directions with peer details
- `files` -- attached files with paths and metadata
- `events` -- recent events (up to 50, newest first)
- `local_mirror` -- local workspace path if registered
