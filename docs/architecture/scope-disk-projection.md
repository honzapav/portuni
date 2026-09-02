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

## The three tiers

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

**Ad-hoc set — deeper than depth-1, added mid-session by expand_scope
(#191).** The static profile cannot grant these new real paths at spawn time,
and we do not use Claude-specific hooks or the brittle sandbox-extension SPI.
Instead the profile grants one more thing at spawn: read-only access to a
per-node *projection* parent, `<portuniRoot>/.portuni-sessions/<homeNodeId>/`
(`SandboxScope.projectionRoot`, `resolveProjectionRootForNode` in
`apps/server/domain/sandbox-profile.ts`). Keyed by node, not by the
not-yet-existing session id, because the profile is built and frozen before
the MCP session for the spawned CLI connects — but a Seatbelt `subpath` allow
on the parent already covers whatever `<sessionId>/` subdirectory that session
creates later. The first time a read tool (`get_context`, `get_node`,
`list_files`) or `portuni_expand_scope` touches an ad-hoc node, the disk
projector (`apps/server/mcp/disk-projection.ts`) hardlinks that node's local
mirror — if this device has one — into
`<projectionRoot>/<sessionId>/<nodeId>/` (`apps/server/domain/
session-projection.ts`), and the tool response's `local_path` points there.
Hardlinks mean no data duplication and always-current content: an edit lands
on the real mirror file, visible through the link immediately. The
mirror-watcher (already watching every mirror for file-state reconciliation)
re-links or removes the corresponding hardlink on every create/delete inside
a projected node's mirror, so the projection never goes stale mid-session.
The projection directory is cleaned up when the MCP session closes
(`disposeSessionProjection`, wired into `transport.onclose`) — the agent
never manages it. A node with no local mirror on this device has no
projection either way; `portuni_read_file(node_id, path)`
(`apps/server/domain/read-node-file.ts`) remains the one channel that always
works (local mirror, or a Drive-direct read when this device has none). Local
mode gates all of this on the session scope (`guardNodeRead`); central mode
gates on mirror-presence (a teammate device only mirrors in-scope nodes).
Hardlinking falls back to a real copy on `EXDEV` (a mirror on another
filesystem than the projection root) instead of silently producing an empty
directory (`session-projection.ts`'s `linkOrCopy`).

**Per-session narrowing (#208 follow-up).** The Seatbelt allow for the
projection parent is scoped to `<projectionRoot>/<sessionId>/`, not the whole
`<projectionRoot>/` — two sessions spawned against the same home node no
longer share a kernel-level read grant into each other's ad-hoc projections.
This needs the session id to exist *before* the sandbox profile is built,
which is normally impossible (the profile is frozen at spawn, before the MCP
connection — and its session row — exist). `resolveSandboxScopeForNode`
(`apps/server/domain/sandbox-profile.ts`) resolves this by mint-then-relay: a
fresh spawn mints a `ulid()` there and returns it as `session_id` on the `GET
/nodes/:id/sandbox-profile` response; a resumed spawn reuses its
already-validated `resumeSessionId` instead (no new id needed — it is already
known and already governs the widened `readMirrors`). The minted id is
threaded out to `pty_spawn` as `spawn_session_id` (`apps/desktop/src/pty.rs`),
which exports it as `PORTUNI_SPAWN_SESSION_ID`; the per-mirror `.mcp.json`
expands it into a `X-Portuni-Spawn-Id` header the same way
`X-Portuni-Profile` carries the spawn profile id (`buildClaudeMcpJson`,
`write-scope.ts` — Claude-only for now, same rationale as the profile
header). `mcp/transport.ts` reads that header and passes it through
`createMcpServer` to `bindSessionPersistence`, which hands it to
`domain/sessions.ts`'s `createSession` as a pre-assigned id instead of
minting a second, unrelated one — so the MCP session's own id matches what
the kernel already granted. Central mode (`db` absent in
`resolveSandboxScopeForNode`) always mints fresh rather than trusting a
caller-supplied `resumeSessionId`, which is unvalidated there.

**Non-relaying CLIs (#211 fix).** At the point `GET /nodes/:id/sandbox-profile`
runs (before `pty_spawn`/exec), the server does not yet know which CLI is
about to connect, so it cannot decide up front whether to narrow or not.
The first cut at this (the #208 follow-up) fell back to granting the WHOLE
`<projectionRoot>/` when no `sessionId` was known — but `sessionId` is
minted unconditionally for every real spawn, so that fallback branch was
dead in production; every non-Claude CLI's MCP session instead minted its
OWN, unrelated fresh id for its `sessions` row (no relay channel), and the
disk projector hardlinked into `<projectionRoot>/<thatUnrelatedId>/` — a
directory the kernel had never granted, so ad-hoc expansions silently
stopped being readable on disk for Codex/Vibe (regressing to
`portuni_read_file`-only). The fix: `buildSeatbeltProfile` grants BOTH the
narrow `<projectionRoot>/<sessionId>/` subdirectory (works only when the
connecting CLI relays it back) AND a second, fixed subdirectory,
`<projectionRoot>/_shared/` (`session-projection.ts`'s
`UNNARROWED_PROJECTION_ID`), unconditionally — neither is an ancestor of
the other, so granting both does not defeat the narrow one's isolation.
`mcp/scope.ts`'s `SessionScope.projectionSessionId` (set synchronously by
`createMcpServer`, so no persistence-race window) resolves to, in order:
the resumed session's own id; the relayed `X-Portuni-Spawn-Id` (Claude); or
the shared bucket (every other CLI). `mcp/disk-projection.ts` projects into
whichever one `projectionSessionId` names, and `disposeSessionProjection`
never tears the shared bucket down at any single session's close (other
concurrent non-relaying sessions on the same node may still be reading it) —
`sweepStaleSessionProjections` also leaves it alone permanently, the same
way it was never cleaned up per-session before #208 existed at all.

**Remaining gap.** `onclose` cleanup only runs on a graceful session end, so
a crashed process (or the whole desktop app) leaves its hardlinks behind.
`sweepStaleSessionProjections` (`session-projection.ts`), run once at boot
from both entry points (`boot/session-projection-sweep.ts`), removes any
`<projectionRoot>/<sessionId>/` directory whose session is not `running` in
the durable `sessions` table (closed/suspended/archived, or an id that no
longer exists) between restarts. The actual kernel enforcement of the
narrowed grant (that `sandbox-exec` really refuses a second session's read
into the first session's `<sessionId>/` subdirectory) is macOS-only,
verifiable only with a live `sandbox-exec` run — the plumbing above is
covered by tests (`test/sandbox-profile.test.ts`,
`test/session-persistence.test.ts`, `test/sessions.test.ts`,
`test/rest-sandbox-profile.test.ts`, `test/agent-router.test.ts`,
`test/write-scope.test.ts`, `test/disk-projection.test.ts`,
`test/scope-projection-session-id.test.ts`), but the live macOS
verification itself is not.

## Restart consolidation

A resumed session (spec: "Lifecycle" — suspend/resume, #190) can pass its
suspended session's id as `?resume_session_id=<id>` on either sandbox-profile
REST endpoint (`GET /nodes/:id/sandbox-profile`, `GET /sandbox-profile?cwd=`).
`resolveSandboxScopeForNode`/`resolveSandboxScopeForCwd` then widen
`readMirrors` with every node from that session's accumulated read set
(`domain/sessions.ts` `getSessionScope`) that still has a local mirror on
this device — not just the depth-1 seed set. A node the agent expanded into
once does not need re-projecting after a restart; the projection directory
only has to cover whatever this widened `readMirrors` cannot (nodes with no
local mirror on this device, which were never projectable either way).
Central mode does not participate yet (`agent-router.ts` resolves with
`NO_DB`, so the widening is inert there) — its own session/scope persistence
is a separate concern.

## Why not the old copy staging

Earlier, every non-home in-scope node was copied into
`<home>/.portuni-scope/<id>/` (read-only) so a home-only Seatbelt profile could
reach it. That is retired, and unlike the current hardlink projection it had
no real fix for going stale: it was a point-in-time snapshot of a file that
changes under it, edits to it were a dead end (never written back), and
out-of-scope copies from a prior session lingered as readable, stale,
scope-leaking cruft with no cleanup. The one-time sweeper that used to clear
legacy `.portuni-scope/` directories (`ScopeReconciler`,
`apps/server/mcp/scope-reconciler.ts`) has itself been retired along with the
directories it swept — the hardlink projection replaced it outright rather
than reusing its shell, since "stage a copy" and "hardlink into a session
directory" are different enough operations that keeping one name for both
would have been more confusing than a clean rename
(`apps/server/mcp/disk-projection.ts`).

## Prior art

The per-tier design follows the sandbox substrate the field already uses:
macOS `sandbox-exec` profiles naming real allowed paths (Codex CLI, Chromium),
not the AI IDEs (none do dynamic within-corpus deny-by-default FS scoping).
Symlink forests are out on macOS (realpath matching); FUSE (sandboxfs) is the
"ideal" dynamic virtual FS but carries the macFUSE kext tax Google walked away
from. See `docs/superpowers/plans/2026-07-06-scope-real-paths.md`.
