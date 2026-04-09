---
title: Edges
description: Tools for connecting and disconnecting nodes.
---

## portuni_connect

Create a directed edge between two nodes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source_id` | string | yes | Source node ID |
| `target_id` | string | yes | Target node ID |
| `relation` | string | yes | Relation type |
| `meta` | object | no | Edge metadata |

Relation types (strictly enforced): `related_to`, `belongs_to`, `applies`, `informed_by`.

Duplicate edges (same source, target, and relation) are prevented.

Returns: `{ id, source_id, target_id, relation }`

## portuni_disconnect

Remove edge(s) between two nodes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source_id` | string | yes | Source node ID |
| `target_id` | string | yes | Target node ID |
| `relation` | string | no | Relation to remove (omit to remove all) |

Returns: `{ disconnected: count }`
