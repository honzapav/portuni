---
title: Nodes
description: Tools for creating and managing nodes in the knowledge graph.
---

## portuni_create_node

Create a new node in the knowledge graph.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | yes | Node type (e.g. organization, process, project) |
| `name` | string | yes | Human-readable name |
| `description` | string | no | What this node represents |
| `meta` | object | no | Type-specific JSON data |
| `status` | enum | no | `active` (default), `completed`, `archived` |
| `visibility` | enum | no | `team` (default), `private` |

Returns: `{ id, type, name, status }`

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
| `type` | string | no | Filter by node type |
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
