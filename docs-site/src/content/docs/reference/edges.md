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

**Organization invariant on `belongs_to`:** a non-organization node can have **exactly one** `belongs_to -> organization` edge. Attempting to create a second one is rejected with an actionable error. This is enforced both at the MCP tool layer and by a database trigger (`prevent_multi_parent_org`). To move a non-organization node to a different organization, disconnect the current `belongs_to` and connect to the new one in the same agent turn.

Returns: `{ id, source_id, target_id, relation }`

## portuni_disconnect

Remove edge(s) between two nodes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source_id` | string | yes | Source node ID |
| `target_id` | string | yes | Target node ID |
| `relation` | enum | no | Relation to remove (omit to remove all) |

**Cannot orphan a node.** The only `belongs_to -> organization` edge of a non-organization node cannot be removed -- the call is rejected with a clear error. Enforced at the tool layer and by the `prevent_orphan_on_edge_delete` database trigger. To move a node to a new organization, perform the disconnect + reconnect as a single operation.

Returns: `{ disconnected: count }`
