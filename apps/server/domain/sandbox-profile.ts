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
import type { Client } from "@libsql/client";
import { getMirrorPath, listUserMirrors } from "./sync/mirror-registry.js";
import { nodeNeighbourIds } from "./queries/neighbours.js";
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
export async function resolveSandboxScopeForNode(
  db: Client,
  userId: string,
  nodeId: string,
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
  let readMirrors: string[] = [];
  if (db) {
    const neighborIds = await nodeNeighbourIds(db, nodeId);
    const paths = await Promise.all(
      neighborIds.map(async (id) => {
        const p = await getMirrorPath(userId, id);
        return p ? await resolveReal(p) : null;
      }),
    );
    // Drop neighbors with no local mirror, and any that resolve to the home
    // mirror itself (already granted rw). Dedupe.
    readMirrors = [...new Set(paths.filter((p): p is string => p !== null && p !== homeReal))];
  }

  return {
    portuniRoot: await resolveReal(portuniRoot),
    homeMirror: homeReal,
    readMirrors,
  };
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
  const scope = await resolveSandboxScopeForNode(db, userId, row.node_id);
  if (!scope) return null;
  return { nodeId: row.node_id, scope };
}
