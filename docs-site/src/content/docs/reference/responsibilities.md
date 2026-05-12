---
title: Responsibilities
description: Tools for managing units of work attached to nodes, and for attaching data sources and tools.
---

Responsibilities are units of work attached to project, process, or area nodes. Data sources and tools are descriptive metadata listing what a node reads from and what it uses. See [Actors & Responsibilities](/concepts/actors-responsibilities/) for the conceptual model.

## portuni_create_responsibility

Create a responsibility on a node. Optionally assign initial actors in the same call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Project, process, or area to attach to |
| `title` | string | yes | Short title |
| `description` | string | no | Longer explanation |
| `sort_order` | number | no | Display order within the node (lower sorts first). Default `0` |
| `assignees` | string[] | no | Actor IDs to assign on creation |

Returns: the created responsibility row (`{ id, node_id, title, description, sort_order, assignees }`).

## portuni_update_responsibility

Update fields on an existing responsibility. Only provided fields change.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `responsibility_id` | string | yes | Responsibility ID |
| `title` | string | no | New title |
| `description` | string \| null | no | New description. Pass `null` to clear |
| `sort_order` | number | no | New sort order |

Assignments are managed separately via [`portuni_assign_responsibility`](/reference/actors/#portuni_assign_responsibility) and `portuni_unassign_responsibility`.

## portuni_delete_responsibility

Delete a responsibility. Cascades to assignments – the actors stay, the assignment records are removed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `responsibility_id` | string | yes | Responsibility ID |

## portuni_list_responsibilities

List responsibilities, optionally filtered.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | no | Filter to one node |
| `actor_id` | string | no | Filter to responsibilities assigned to one actor |

Returns: array of responsibility records, each with its `assignees` (actor IDs and names).

## Data sources and tools

Two parallel attribute lists hang off project / process / area nodes.

### portuni_add_data_source

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Project, process, or area |
| `name` | string | yes | Short display name (e.g. "CRM Airtable", "Q3 revenue report") |
| `description` | string | no | Optional detail |
| `external_link` | string | no | Optional plain URL (`http://`, `https://`, or `mailto:` only). No credentials in the URL — they would land in audit logs |

### portuni_remove_data_source

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data_source_id` | string | yes | Data source ID |

### portuni_list_data_sources

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node to list for |

### portuni_add_tool

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Project, process, or area |
| `name` | string | yes | Short display name (e.g. "Asana", "Figma", "Slack") — identifies what it is, not live state from the linked system |
| `description` | string | no | Optional detail. Identify what the linked resource is; skip live state (status, stage, counts, assignees, dates) — Portuni does not auto-sync and any such state would go stale |
| `external_link` | string | no | Optional plain URL (`http://`, `https://`, or `mailto:` only). No credentials in the URL — they would land in audit logs |

### portuni_remove_tool

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tool_id` | string | yes | Tool ID |

### portuni_list_tools

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node to list for |

## See also

- [Actors](/reference/actors/) – tools for actor records and assignments
- [Actors & Responsibilities](/concepts/actors-responsibilities/) – conceptual model
