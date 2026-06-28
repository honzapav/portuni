# Scope disk projection (single source of truth)

The per-session `SessionScope` node set (`apps/server/mcp/scope.ts`) is the
ONE authoritative read scope. Disk access is a pure projection of it.

## Why

Previously two layers gated reads and drifted:
- graph scope: grows via auto-seed, session_init, get_node/get_context,
  expand_scope;
- a Seatbelt profile fixed at terminal spawn (home rw + depth-1 neighbors
  ro), widened mid-session only by expand_scope staging.

A node reached via get_context (e.g. a related node created after spawn)
entered graph scope but stayed unreadable on disk — the reported bug
(session e3c79c7c). The agent could see the node in the graph yet got
EPERM on its files, even with the sandbox "disabled" (the desktop wraps the
shell in `sandbox-exec`, an outer boundary the inner toggle cannot lift).

## How

- `SessionScope.add()` fires `onAdd` listeners (Task 1).
- `ScopeReconciler` (`apps/server/mcp/scope-reconciler.ts`) subscribes once
  per session in `createMcpServer`. When a node enters scope it copies the
  node's mirror into `<home>/.portuni-scope/<id>/` (read-only, inside the
  home rw zone). Dot-segment => excluded from sync walkers.
- The Seatbelt profile is home-only. There is no neighbor read-allow; the
  staged copies ARE the neighbor read access. One mechanism, no drift.
- get_node / get_context / list_files surface the staged path as
  `local_path` for non-home in-scope nodes (`readableMirrorRoot`).

## Trade-offs

Staged copies are point-in-time. get_node / list_files await a re-stage
before handing back a path, so a single-node read is fresh; get_context
relies on the eager onAdd staging and may serve a slightly stale snapshot
of a neighbour edited within the same session. Acceptable: neighbours are
read-only references. Future optimisation: incremental (mtime-diff) staging
instead of wholesale re-copy.
