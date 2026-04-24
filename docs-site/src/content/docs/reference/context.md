---
title: Graph Traversal
description: Walking the knowledge graph with depth-aware detail.
---

## portuni_get_context

Traverse the graph from a starting node. Returns connected nodes with decreasing detail by depth.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Starting node ID |
| `depth` | number | no | Traversal depth 0-5 (default: 1) |

### Depth levels

| Depth | Events | Detail |
|-------|--------|--------|
| 0 | Full (up to 50 active) | All fields including meta, refs, task_ref |
| 1 | Recent (up to 5 active) | Type, content, created_at only |
| 2+ | None | Node info + edges only |

### Response

Array of nodes, each containing:
- `id`, `type`, `name`, `description`, `status`
- `depth` -- distance from starting node
- `edges` -- direct edges with direction and peer info
- `events` -- depth-aware (see table above)
- `local_path` -- local mirror path on the current device, read from
  `~/.portuni/sync.db` (per-device registry). Null when the node is not
  mirrored on this machine. Stale rows -- a registration for a node that
  was purged from the shared graph -- are skipped and cleaned up lazily.

Uses a recursive CTE for efficient single-query traversal.

## REST: GET /context

Resolves a filesystem path to a graph node. Used by the SessionStart hook.

```
GET /context?path=/Users/you/Workspaces/portuni/workflow/projects/goldea-presale
```

Returns the matching node, its edges (depth 1), and recent events (last 5 active).

Path matching: finds the longest registered mirror path on the current
device that is a prefix of the given path. Mirrors are read from
`~/.portuni/sync.db`, so each machine can have a different layout without
trampling teammates' setups.
