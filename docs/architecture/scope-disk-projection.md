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
never tears the shared bucket down purely because one session's own close
happens to key off it (other concurrent non-relaying sessions on the same
node may still be reading it).

**Bounding the shared bucket (#214).** Unlike a narrow per-session
directory, `_shared` isn't owned by any one session row, so it can't be
aged out by the per-`sessionId` rule below. It is instead governed by
node-level running-session state: `disposeSessionProjection` sweeps it
(removed outright, or reconciled in place) every time a session on that
home node closes, and `sweepStaleSessionProjections`'s boot sweep does the
same as a backstop for a crashed process. "Reconciled in place" means
pruning hardlinks whose source mirror file is gone, the same "source is
gone" condition `relinkProjectedFile` already handles for the live/watched
path — an ad-hoc node deleted or unmirrored while `_shared` was still in
use would otherwise leave stale links there forever. Relaying the spawn id
for Codex/Vibe the way Claude's header does — so they'd land in the narrow
per-session directory and stop needing `_shared` at all — turned out not to
be implementable with either CLI's current config format: Codex has no
per-mirror MCP registration whatsoever (`domain/scope-materialize.ts`'s
per-mirror `.codex/config.toml` is sandbox-only; the MCP connection lives
in the global, static `~/.codex/config.toml`), and Vibe's per-mirror
`url`/`headers` fields are plain static strings materialized once at mirror
creation with no runtime env-var expansion outside the auth-token-specific
fields (`api_key_env` et al., confirmed against Mistral's own docs) — so a
literal session id embedded there would go stale after the very first spawn
on that mirror, since the id changes every spawn but the file is written
once. `_shared` staying bounded rather than actually narrowed is the
accepted outcome for those two CLIs.

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
`test/session-projection.test.ts`,
`test/scope-projection-session-id.test.ts`), but the live macOS
verification itself is not.

## Seed/grant skew and central-mode projection (#252)

Two gaps left ad-hoc-adjacent nodes unreadable in practice, both fixed the
same way: **project unconditionally, and prefer the projection over the
"should already be granted" real path.**

**Seed/grant skew (local mode).** `readableMirrorRoot` used to return the
real mirror path outright for any node `scope.isSeed()` marked seed, trusting
that the Seatbelt profile's `readMirrors` (frozen at the `GET
/nodes/:id/sandbox-profile` call, *before* the CLI process exists) already
granted it. But the in-memory seed set is recomputed at MCP *connect* time
(`seedScopeFromHome`), which happens *after* spawn — a mirror registered or
an edge created in between makes a node "seed" in memory without the kernel
ever having granted its real path. `apps/server/mcp/disk-projection.ts`'s
`DiskProjector.projectNode` now attempts to hardlink EVERY non-home in-scope
node, seed or ad-hoc (only the home node itself is skipped, reason
`seed_granted` — it is the process's own spawn anchor, no race possible), and
`readableMirrorRoot` prefers that projection directory over the real mirror
for a seed node too, falling back to the real path only when no projection
exists yet. The projection parent (`<projectionRoot>/<sessionId>/` or the
shared bucket) is granted unconditionally by the Seatbelt profile regardless
of the neighbour set at spawn time, so this closes the race instead of
depending on it never happening. Cost is a hardlink — nil.

**Central/agent mode never projected at all.** `portuni_expand_scope`,
`portuni_get_node` and `portuni_get_context` are proxied to central from the
local sidecar's agent front door (`apps/server/mcp/agent-transport.ts`), and
central itself has no device filesystem, so its own `projected` map (and any
`readable_path`/`local_path` it could compute) was always empty/null. The
front door now builds its own tiny `ProjectorScope` per local MCP session
(`homeNodeId` from the connection's `?home_node_id=`, `has` always true since
by the time a node id reaches this layer it already passed central's own
`guardNodeRead`, `projectionSessionId` the LOCAL transport's own session id —
there is no durable `session_scope` row on the device to key off instead) and
a real `DiskProjector` over it, then:
- overlays `projected`/`not_projected` onto `portuni_expand_scope`'s response
  in place of central's own (structurally useless) ones;
- overlays `readable_path` (get_node) / `local_path` (get_context) using the
  same projector, for ANY node with a local mirror on this device, not just
  the seatbelt's depth-1 seed set.
The per-session projection directory is torn down in the local transport's
own `onclose` (`cleanupSessionProjection` + `unregisterSessionProjections`)
— simpler than local mode's `disposeSessionProjection`, since this front
door never uses the shared `_shared` bucket (a real transport session id is
always available once initialized, so there is no "other concurrent
non-relaying session" case to account for).

## portuni_get_node's `readable_path` and the read_file 1 MB cap (#252)

`local_mirror` on `portuni_get_node` is registration metadata (may not be
readable under the sandbox); `readable_path` is the actual disk path this
session may read the node's files from — `readableMirrorRoot`'s result,
`null` when there is none (no local mirror on this device, or the node is
out of scope). Tool descriptions point agents at `readable_path`, not
`local_mirror`, for reads.

`portuni_read_file`'s 1 MB inline cap (`MAX_READ_BYTES`,
`domain/read-node-file.ts`) stays — a tool result is model input, and an
uncapped read would just move the failure from a clean refusal to a blown
context window. What changed is what happens past the cap: no chunked reads
(`offset`/`length`) — there is no server-side grep, so the agent would page
blindly through a file looking for one thing. Instead
(`apps/server/mcp/read-file-spill.ts`) a file over the cap, or any call with
`as_path: true`, is **spilled to a path inside the session's projection
directory** and the tool returns `{ path, bytes, mime }` instead of content,
so the agent reads it with its own Read/Grep (offsets, search, whatever it
needs) or hands the path to a PDF/deck-reading skill. Two sources, chosen by
whether the node has a local mirror on this device: a mirror hardlinks the
whole node via the same `DiskProjector.projectNode` ad-hoc expansion uses (no
copy, always current); no mirror downloads the bytes once (`getFileRaw` over
REST in agent mode, since that front door has no graph db to read a remote
adapter through directly) and writes a real copy into the same directory.
Cleanup rides on the existing projection-directory teardown above — the
spilled file is not tracked separately. The refusal text past the cap now
names both real options (`as_path: true`, or `portuni_expand_scope` then
`readable_path`) instead of the old "bring the node into your working set".

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
