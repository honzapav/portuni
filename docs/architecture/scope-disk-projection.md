# Scope disk projection (real paths, no copies)

The per-session `SessionScope` node set (`apps/server/mcp/scope.ts`) is the ONE
authoritative read scope. Disk access is a projection of it onto REAL mirror
paths — no copies.

## The tension

- **Graph scope is dynamic**: it grows via auto-seed, session_init,
  get_node/get_context auto-allow, and expand_scope.
- **The macOS Seatbelt profile is static**: fixed at terminal spawn
  (`sandbox-exec -f profile`), it cannot be widened for the running process,
  and it matches REAL paths (a symlink resolves to the denied root, so a
  symlink forest grants nothing).

So the disk boundary can be *tight* (deny-by-default within `PORTUNI_ROOT`) or
*dynamic*, but a single static profile cannot be both. We split by tier.

## The two tiers

**Seed set — home + depth-1 neighbours (stable, known at spawn).**
The seed set does not shrink during a session (scope only grows), so a
spawn-time grant never drifts for it. `buildSeatbeltProfile`
(`apps/server/domain/sandbox-profile.ts`) grants rw on the home mirror and
**read-only on each neighbour's REAL mirror** (`readMirrors`). The neighbour
set is the same one `seedScopeFromHome` seeds (shared `nodeNeighbourIds`);
in central mode the local graph replica is empty, so it comes from
`CentralClient.nodeNeighbours` and maps to this device's mirrors
(`resolveNeighbourReadMirrors`). Read tools return these real paths
(`readableMirrorRoot` → real mirror for home/seed nodes; central-mode proxied
reads are enriched in `agent-transport.ts`). The agent uses native
Read/Grep/Edit on the live files — edits land on the real mirror and sync
normally.

**Ad-hoc set — deeper than depth-1, added mid-session by expand_scope.**
The static profile cannot grant these new real paths, and we do not use
Claude-specific hooks or the brittle sandbox-extension SPI. Instead they are
NOT on disk: `readableMirrorRoot` returns `null` for a non-seed in-scope node,
and the agent reads their content through **`portuni_read_file(node_id, path)`**
(`apps/server/domain/read-node-file.ts`) — the unsandboxed server reads the
live file from the node's local mirror and returns it (UTF-8 or base64). Local
mode gates on the session scope (`guardNodeRead`); central mode gates on
mirror-presence (a teammate device only mirrors in-scope nodes). Deep traversal
of the graph *structure* is unaffected; only native grep/glob over ad-hoc file
*content* is traded for the tool — the deliberate tax for tight dynamic scope
without hooks.

## Why not the old copy staging

Earlier, every non-home in-scope node was copied into
`<home>/.portuni-scope/<id>/` (read-only) so a home-only Seatbelt profile could
reach it. That is retired. Copies were a second source of truth: they went
stale (a point-in-time snapshot of a file that changes under them), edits to a
copy were a dead end (never written back), and out-of-scope copies from a prior
session lingered as readable, stale, scope-leaking cruft with no cleanup. Real
paths dissolve all three. The `ScopeReconciler`
(`apps/server/mcp/scope-reconciler.ts`) survives only as a one-time sweeper that
clears any legacy `.portuni-scope/` directory from a pre-real-path session.

## Prior art

The per-tier design follows the sandbox substrate the field already uses:
macOS `sandbox-exec` profiles naming real allowed paths (Codex CLI, Chromium),
not the AI IDEs (none do dynamic within-corpus deny-by-default FS scoping).
Symlink forests are out on macOS (realpath matching); FUSE (sandboxfs) is the
"ideal" dynamic virtual FS but carries the macFUSE kext tax Google walked away
from. See `docs/superpowers/plans/2026-07-06-scope-real-paths.md`.
