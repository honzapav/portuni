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
| `created_at` | string | no | ISO datetime for retroactive events (e.g. `2024-01-15` or `2024-01-15T10:30:00Z`). Defaults to now. This is the event date that drives ordering and display — do not put the date in `meta`. The technical `logged_at` timestamp is always the real now |

Returns: `{ id, node_id, type, status: "active" }` — plus a `warning`
field when any ID in `refs` does not exist (missing refs are reported,
not rejected; orphan refs can occur from deleted events).

## portuni_resolve

Mark an event as resolved.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `event_id` | string | yes | Event ID |
| `resolution` | string | no | Resolution description |

The resolution is merged into the event's existing metadata (other meta keys are preserved). Only active events can be resolved.

Returns: `{ id, status: "resolved" }`

## portuni_supersede

Replace an event with an updated version. Sets the old event's status to `superseded` (a distinct status — not `archived`) and creates a new one referencing it, in a single transaction.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `event_id` | string | yes | Event ID to supersede |
| `new_content` | string | yes | Updated content |
| `meta` | object | no | Updated metadata (keeps old if omitted) |

The new event inherits the old event's `node_id`, `type`, and `task_ref`, and preserves the old event's `created_at` (the event date stays put; `logged_at` records the rewrite). The `refs` field is set to `[old_event_id]`.

Returns: `{ new_id, superseded_id, node_id, status: "active" }`

## portuni_list_events

Query events with filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | no | Filter by node |
| `type` | string | no | Filter by event type |
| `status` | string | no | Filter by status (`active`, `resolved`, `superseded`, `archived`) |
| `since` | string | no | ISO datetime -- only events after this time |
| `limit` | number | no | Max rows (default 100, max 500) |

Scope gating: with `node_id` the node must be in session scope (out of
scope returns `scope_expansion_required`). Without `node_id` the call is
a global query — mode-gated, and results are restricted to the session
scope set (empty scope returns an empty array) unless the mode is
`permissive`.

Returns: Array of events ordered by `created_at` DESC. Each row includes
`id`, `node_id`, `node_name`, `type`, `content`, `meta`, `status`,
`refs`, `task_ref`, `created_at`, and `logged_at` (the immutable
technical timestamp — `created_at` is the event date, which can be set
retroactively).
