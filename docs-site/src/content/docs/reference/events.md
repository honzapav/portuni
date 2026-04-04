---
title: Events
description: Tools for logging and managing knowledge events.
---

## portuni_log

Log knowledge worth remembering on a node.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node ID |
| `type` | string | yes | Event type: decision, discovery, blocker, reference, milestone, note, change |
| `content` | string | yes | What happened, in plain language |
| `meta` | object | no | Type-specific data |
| `refs` | string[] | no | Related event IDs |
| `task_ref` | string | no | External reference (task URL, CRM record) |

Returns: `{ id, node_id, type, status: "active" }`

## portuni_resolve

Mark an event as resolved.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `event_id` | string | yes | Event ID |
| `resolution` | string | no | Resolution description |

The resolution is merged into the event's existing metadata (other meta keys are preserved). Only active events can be resolved.

Returns: `{ id, status: "resolved" }`

## portuni_supersede

Replace an event with an updated version. Archives the old event and creates a new one referencing it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `event_id` | string | yes | Event ID to supersede |
| `new_content` | string | yes | Updated content |
| `meta` | object | no | Updated metadata (keeps old if omitted) |

The new event inherits the old event's `node_id`, `type`, and `task_ref`. The `refs` field is set to `[old_event_id]`.

Returns: `{ new_id, superseded_id, node_id, status: "active" }`

## portuni_list_events

Query events with filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | no | Filter by node |
| `type` | string | no | Filter by event type |
| `status` | string | no | Filter by status |
| `since` | string | no | ISO datetime -- only events after this time |

Returns: Array of events with `node_name` included, ordered by `created_at` DESC.
