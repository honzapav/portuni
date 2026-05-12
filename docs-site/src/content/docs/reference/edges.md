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

**Cannot orphan a node.** The only `belongs_to -> organization` edge of a non-organization node cannot be removed -- the call is rejected with a clear error. Enforced at the tool layer and by the `prevent_orphan_on_edge_delete` database trigger. To move a node to a new organization, use `portuni_move_node` (below) instead of a disconnect + reconnect.

Returns: `{ disconnected: count }`

## portuni_move_node

Move a non-organization node from its current organization to another. Rebinds the existing `belongs_to` edge atomically — the org-invariant triggers fire on `INSERT` and `DELETE` only, so an `UPDATE` preserves "exactly one `belongs_to -> organization`" by construction. The edge id stays stable so audit history attached to the membership is continuous.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node ID (ULID) to move. Must be a non-organization node |
| `new_org_id` | string | yes | Target organization ID (ULID). Must have `type='organization'` |

Use this instead of `portuni_disconnect` + `portuni_connect` when relocating a node between organizations — single agent turn, single audit row, no transient invariant break.

Returns: `{ moved: boolean, edge_id, from_org_id, to_org_id }` — `moved: false` when the node was already in `new_org_id` (no-op).
