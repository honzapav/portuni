---
title: Graph Traversal
description: Walking the knowledge graph with depth-aware detail.
---

## portuni_get_context

Traverse the graph from a starting node. Call this before starting work on a node to load it plus its neighbourhood. The starting node (depth 0) comes back with full detail; connected nodes (depth 1+) come back with lighter breadcrumbs.

For single-node detail without traversal — including `files` and `local_mirror` metadata that `portuni_get_context` omits — use [`portuni_get_node`](/reference/nodes/#portuni_get_node) instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Starting node ID |
| `depth` | number | no | Traversal depth 0-5 (default: 1) |

### Depth levels

| Depth | Events | Node detail |
|-------|--------|-------------|
| 0 (root) | Full (up to 50 active) | Full enrichment — `owner`, `responsibilities`, `data_sources`, `tools`, `goal`, `lifecycle_state`, `health`, plus core fields |
| 1 | Recent (up to 5 active, type+content+created_at only) | Lightweight — `lifecycle_state`, `health`, `owner_name`, `responsibilities_count`, core fields |
| 2+ | None | Lightweight (same shape as depth 1, no events) |

### Response

Array — `[root, ...connected]`. The root (depth 0) and connected nodes share the core fields below, with the enrichment differences spelled out in the depth table above.

**Root node (depth 0):**
- `id`, `type`, `name`, `description`, `status`, `depth: 0`
- `goal`, `lifecycle_state`, `health` (project health, meaningful for `type='project'` only — see [Lifecycle States](/concepts/lifecycle-states/#project-health))
- `owner` — `{ id, name }` of the owning actor, or `null`
- `responsibilities` — array, each with `id`, `title`, `description`, `sort_order`, `assignees`
- `data_sources`, `tools` — array of `{ id, name, description, external_link }` rows
- `edges` — direct edges with direction and peer info
- `events` — up to 50 active events with `meta` and `task_ref` (`refs` is not included in the context payload — use [`portuni_list_events`](/reference/events/#portuni_list_events) when you need it)
- `local_path` — local mirror path on the current device, or `null`

**Connected nodes (depth >= 1):**
- `id`, `type`, `name`, `description`, `status`, `depth`
- `lifecycle_state`, `health`, `owner_name`, `responsibilities_count`
- `edges` — same shape as root
- `events` — depth 1 only: up to 5 recent events with `type`, `content`, `created_at`. Depth >= 2: empty
- `local_path` — local mirror path on the current device, or `null`

Local mirror paths are read from `{PORTUNI_WORKSPACE_ROOT}/.portuni/sync.db` (per-device registry). Stale rows (mirror registered for a node that has been purged from the shared graph) are skipped and cleaned up lazily.

`local_path` is the node's **real** mirror for the home node and its depth-1 neighbours (the seatbelt grants read on those real paths). For an ad-hoc in-scope node (deeper than depth-1) that has a local mirror on this device, `local_path` is that node's hardlink projection directory (created on first touch, cleaned up at session end) — still readable natively, just not the real mirror path. A node with no local mirror on this device has `local_path: null` either way; read its files with [`portuni_read_file`](/reference/files/). See [disk read scope](/concepts/scope-enforcement/).

Edges to a peer the caller can only reach via a request-mode ACL come back with `peer_restricted: true` and blanked `id` / `peer_id` — name and type only, so the edge is visible but cannot be used to probe or act on the peer. Edges to fully hidden peers are dropped.

### Scope

The starting node must already be in session scope. Nodes revealed by traversal are added to the scope set automatically and recorded in the expansion log (visible via [`portuni_session_log`](/reference/scope/#portuni_session_log)). Depth >= 2 traversal is always treated as breadth expansion and refused (`scope_expansion_required`) regardless of session type — call with depth <= 1, then expand explicitly with [`portuni_expand_scope`](/reference/scope/#portuni_expand_scope). See [Scope Enforcement](/concepts/scope-enforcement/).

Uses a recursive CTE for efficient single-query traversal.

