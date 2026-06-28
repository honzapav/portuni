// Seatbelt sandbox profile generation — the universal disk-scope layer.
//
// The MCP server gates graph reads per session scope; this module mirrors
// the same semantics on the filesystem for ANY agent binary (claude,
// codex, ...) spawned inside a mirror: the kernel allows read+write in
// the home mirror and denies the rest of PORTUNI_ROOT. Everything outside
// the root stays unrestricted (allow default) — this protects the
// knowledge graph, it is not a general-purpose jail.
//
// Single-source model: neighbor nodes are NOT granted disk access here.
// Instead, the ScopeReconciler (apps/server/mcp/scope-reconciler.ts)
// copies them into <home>/.portuni-scope/<id>/. Those staged paths live
// inside the home subpath and are therefore already covered by the home
// rw rule — no second kernel grant needed.
//
// Profile shape and the two gotchas (Seatbelt matches realpaths only;
// git discovery needs file-read-metadata on the denied root) were
// validated against live sandbox-exec runs — see
// docs/sandbox-spike-2026-06-10.md.

import { realpath } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { getMirrorPath, listUserMirrors } from "./sync/mirror-registry.js";
import { findContainingMirror, normalize, resolvePortuniRoot } from "./write-scope.js";

// Seatbelt string literal: double-quoted, backslash and quote escaped.
function sbQuote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface SandboxScope {
  portuniRoot: string;
  homeMirror: string;
}

// Render the Seatbelt profile. Paths must already be realpath-resolved.
//
// Single-source model: the home mirror is the only place the kernel grants
// read/write. Every OTHER in-scope node is made readable not here but by
// the ScopeReconciler, which copies it into <home>/.portuni-scope/<id>/
// (inside the home subpath, so already covered by the home rw rule). This
// removes the old depth-1 neighbor read-allow, which was a second,
// spawn-frozen source of truth that drifted from the live session scope.
//
// Rule order is load-bearing: Seatbelt gives later rules precedence, so
// the root deny comes first and the home allow overrides it.
export function buildSeatbeltProfile(scope: SandboxScope): string {
  const home = normalize(scope.homeMirror);
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath ${sbQuote(normalize(scope.portuniRoot))}))`,
    // stat/traverse stays allowed so git repo discovery and path
    // resolution work; directory listings and file contents stay denied.
    `(allow file-read-metadata (subpath ${sbQuote(normalize(scope.portuniRoot))}))`,
    `(allow file-read* file-write* (subpath ${sbQuote(home)}))`,
  ];
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

// Resolve the disk scope for a node: its own mirror and the portuniRoot
// that contains it. Returns null when the node has no local mirror —
// there is nothing to sandbox into.
//
// The old depth-1 neighbor query has been removed. Neighbors are now
// staged under <home>/.portuni-scope/<id>/ by the ScopeReconciler and
// need no separate kernel grant here.
export async function resolveSandboxScopeForNode(
  _db: Client,
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

  return {
    portuniRoot: await resolveReal(portuniRoot),
    homeMirror: await resolveReal(home),
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
