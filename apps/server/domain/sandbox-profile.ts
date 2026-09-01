// Seatbelt sandbox profile generation — the universal disk-scope layer.
//
// The MCP server gates graph reads per session scope; this module mirrors
// the same semantics on the filesystem for ANY agent binary (claude,
// codex, ...) spawned inside a mirror: the kernel allows read+write in
// the home mirror and denies the rest of PORTUNI_ROOT. Everything outside
// the root stays unrestricted (allow default) — this protects the
// knowledge graph, it is not a general-purpose jail.
//
// Real-path model: the depth-1 neighbor set (the stable spawn scope) is
// granted read-only on its REAL mirror paths (readMirrors), so the agent
// reads the live file — no copy to go stale, no cleanup, edits land on the
// real mirror. The set is stable for the session (scope only grows), so a
// spawn-time grant does not drift for it; dynamic ad-hoc expansion is served
// off the kernel grant (server-mediated), not by widening this profile.
//
// Profile shape and the two gotchas (Seatbelt matches realpaths only;
// git discovery needs file-read-metadata on the denied root) were
// validated against live sandbox-exec runs — see
// docs/archive/sandbox-spike-2026-06-10.md.

import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { getMirrorPath, listUserMirrors } from "./sync/mirror-registry.js";
import { nodeNeighbourIds } from "./queries/neighbours.js";
import { getSessionScope } from "./sessions.js";
import { findContainingMirror, normalize, resolvePortuniRoot } from "./write-scope.js";

// Seatbelt string literal: double-quoted, backslash and quote escaped.
function sbQuote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface SandboxScope {
  portuniRoot: string;
  homeMirror: string;
  // Real mirror roots of the home node's in-scope neighbors (the stable
  // spawn set = home + depth-1), granted read-only. Named as REAL paths
  // because Seatbelt matches realpaths (a symlink resolves to the denied
  // root). Empty falls back to the home-only profile.
  readMirrors: string[];
  // Read-only parent directory for this node's session projection
  // directories (domain/session-projection.ts, spec: "Disk contract",
  // #191): <portuniRoot>/.portuni-sessions/<homeNodeId>/. Ad-hoc (non-seed)
  // nodes a session expands into mid-run are hardlinked under
  // <projectionRoot>/<sessionId>/<nodeId>/ once the MCP session exists --
  // keyed by node (not session) here because this profile is built and
  // frozen into Seatbelt BEFORE that session's id is minted, but a subpath
  // allow on the parent already covers whatever subdirectory the session
  // creates later. Optional so hand-built SandboxScope literals (existing
  // tests, callers with no session concept) keep working without it.
  projectionRoot?: string;
}

// Render the Seatbelt profile. Paths must already be realpath-resolved.
//
// Real-path model: the kernel grants read+write in the home mirror and
// read-only on each spawn-set neighbor's REAL mirror (readMirrors). This
// replaces the old copy-into-<home>/.portuni-scope/ staging for the spawn
// set: reads are the live file (no stale snapshot, no cleanup), edits land
// on the real mirror. The spawn set (home + depth-1) is stable for the
// session -- scope only grows -- so a spawn-frozen grant does not drift for
// it; dynamic ad-hoc expansion is handled off the kernel grant (server-
// mediated), not by widening this profile.
//
// Rule order is load-bearing: Seatbelt gives later rules precedence, so the
// root deny comes first and the allows (which re-open specific subpaths
// inside the denied root) come after it.
export function buildSeatbeltProfile(scope: SandboxScope): string {
  const home = normalize(scope.homeMirror);
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath ${sbQuote(normalize(scope.portuniRoot))}))`,
    // stat/traverse stays allowed so git repo discovery and path
    // resolution work; directory listings and file contents stay denied.
    `(allow file-read-metadata (subpath ${sbQuote(normalize(scope.portuniRoot))}))`,
  ];
  // Read-only re-allow for each in-scope neighbor mirror. After the deny so
  // it wins; before the home rw allow (order among allows is immaterial).
  for (const m of scope.readMirrors) {
    lines.push(`(allow file-read* (subpath ${sbQuote(normalize(m))}))`);
  }
  if (scope.projectionRoot) {
    lines.push(`(allow file-read* (subpath ${sbQuote(normalize(scope.projectionRoot))}))`);
  }
  lines.push(`(allow file-read* file-write* (subpath ${sbQuote(home)}))`);
  return lines.join("\n") + "\n";
}

// Realpath with a fallback to plain normalization for paths that do not
// exist (yet) — better to emit a non-matching rule than to fail the spawn.
async function resolveReal(path: string): Promise<string> {
  try {
    return await realpath(normalize(path));
  } catch {
    return normalize(path);
  }
}

// Resolve the disk scope for a node: its own mirror, the portuniRoot that
// contains it, and the read-only real mirrors of its depth-1 neighbors (the
// stable spawn set). Returns null when the node has no local mirror --
// nothing to sandbox into.
//
// readMirrors mirrors seedScopeFromHome's depth-1 set (shared nodeNeighbourIds)
// so the kernel grant matches the seeded session scope. A neighbor with no
// local mirror is simply omitted (no grant). When db is absent (central-mode
// agent-router passes NO_DB) neighbors can't be resolved here -- readMirrors
// stays empty and central mode fills it in Phase 3.
//
// resumeSessionId is restart consolidation (spec: "Disk contract" -- "on
// resume the sandbox profile is computed from the session's accumulated
// read set"): when set, every node that suspended session ever read
// (domain/sessions.ts session_scope) and that still has a local mirror on
// this device is ALSO granted its real mirror here, on top of the depth-1
// seed set -- not just what the session originally spawned with. A
// re-expansion the agent already did once does not need re-projecting
// after a restart; the projection directory (domain/session-projection.ts)
// only has to cover whatever this widened readMirrors set cannot (nodes
// with no local mirror on this device).
export async function resolveSandboxScopeForNode(
  db: Client,
  userId: string,
  nodeId: string,
  resumeSessionId?: string,
): Promise<SandboxScope | null> {
  const home = await getMirrorPath(userId, nodeId);
  if (!home) return null;

  const allMirrors = await listUserMirrors(userId);
  const portuniRoot = resolvePortuniRoot({
    envValue: process.env.PORTUNI_ROOT ?? null,
    knownMirrors: allMirrors.map((m) => m.local_path),
  });
  if (!portuniRoot) return null;

  const homeReal = await resolveReal(home);
  const portuniRootReal = await resolveReal(portuniRoot);
  let readMirrors = db
    ? await resolveNeighbourReadMirrors(userId, await nodeNeighbourIds(db, nodeId), homeReal)
    : [];

  if (db && resumeSessionId) {
    const accumulated = await getSessionScope(db, resumeSessionId);
    const resumedMirrors = await resolveNeighbourReadMirrors(
      userId,
      accumulated.map((r) => r.node_id),
      homeReal,
    );
    readMirrors = [...new Set([...readMirrors, ...resumedMirrors])];
  }

  return {
    portuniRoot: portuniRootReal,
    homeMirror: homeReal,
    readMirrors,
    projectionRoot: join(portuniRootReal, ".portuni-sessions", nodeId),
  };
}

// Lightweight variant of resolveSandboxScopeForNode's projectionRoot
// computation, for callers that only need the projection paths (the MCP
// disk-projector) and neither a db nor the node's own mirror/neighbours.
// Returns null under the same condition resolveSandboxScopeForNode would
// (no PORTUNI_ROOT resolvable from env + known mirrors).
export async function resolveProjectionRootForNode(
  userId: string,
  homeNodeId: string,
): Promise<{ portuniRoot: string; projectionRoot: string } | null> {
  const allMirrors = await listUserMirrors(userId);
  const portuniRoot = resolvePortuniRoot({
    envValue: process.env.PORTUNI_ROOT ?? null,
    knownMirrors: allMirrors.map((m) => m.local_path),
  });
  if (!portuniRoot) return null;
  const portuniRootReal = await resolveReal(portuniRoot);
  return {
    portuniRoot: portuniRootReal,
    projectionRoot: join(portuniRootReal, ".portuni-sessions", homeNodeId),
  };
}

// Map a set of neighbour node ids to the real mirror paths granted read-only
// in the seatbelt: their local mirror, realpath-resolved, dropping neighbours
// with no local mirror and the home mirror itself (already granted rw), deduped.
// Shared by the local resolver and the central-mode agent-router (which supplies
// neighbour ids from central instead of a local graph query).
export async function resolveNeighbourReadMirrors(
  userId: string,
  neighbourIds: string[],
  homeReal: string,
): Promise<string[]> {
  const paths = await Promise.all(
    neighbourIds.map(async (id) => {
      const p = await getMirrorPath(userId, id);
      return p ? await resolveReal(p) : null;
    }),
  );
  return [...new Set(paths.filter((p): p is string => p !== null && p !== homeReal))];
}

// Resolve the disk scope from a working directory instead of a node id —
// the entry point for `portuni run`, which is invoked from a shell inside
// a mirror and only knows where it stands. The deepest registered mirror
// containing cwd wins (same longest-prefix rule findContainingMirror
// implements for write classification). Returns null when cwd is outside
// every mirror.
export async function resolveSandboxScopeForCwd(
  db: Client,
  userId: string,
  cwd: string,
  resumeSessionId?: string,
): Promise<{ nodeId: string; scope: SandboxScope } | null> {
  const mirrors = await listUserMirrors(userId);
  // Match against the paths as registered (normalized, NOT realpath'd):
  // the registry stores whatever path the mirror was created with, and
  // realpathing only one side of the comparison would break the prefix
  // match whenever that path crosses a symlink (/tmp, /var, ...).
  const containing = findContainingMirror(
    mirrors.map((m) => m.local_path),
    normalize(cwd),
  );
  if (!containing) return null;
  const row = mirrors.find((m) => normalize(m.local_path) === containing);
  if (!row) return null;
  const scope = await resolveSandboxScopeForNode(db, userId, row.node_id, resumeSessionId);
  if (!scope) return null;
  return { nodeId: row.node_id, scope };
}
