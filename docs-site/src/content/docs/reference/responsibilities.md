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
| `sort_order` | number | no | Position in the list (lower = higher priority). Defaults to end-of-list |
| `assignee_actor_ids` | string[] | no | Actors to assign on creation |

Returns: `{ responsibility_id, node_id, title, sort_order, assignees }`

## portuni_update_responsibility

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `responsibility_id` | string | yes | Responsibility ID |
| `title` | string | no | New title |
| `description` | string | no | New description |
| `sort_order` | number | no | New position |

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
| `name` | string | yes | Display name (e.g. "Workflow CRM segment: VIP partners") |
| `kind` | string | no | Free-form classification (e.g. `crm`, `bigquery`, `report`, `airtable`) |
| `external_link` | string | no | URL to the source. **Plain URL only – never include credentials** |

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
| `name` | string | yes | Display name (e.g. "Asana", "Figma") |
| `external_link` | string | no | URL or identifier |

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
