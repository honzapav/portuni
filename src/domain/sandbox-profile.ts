// Seatbelt sandbox profile generation — the universal disk-scope layer.
//
// The MCP server gates graph reads per session scope; this module mirrors
// the same semantics on the filesystem for ANY agent binary (claude,
// codex, ...) spawned inside a mirror: the kernel allows read+write in
// the home mirror, read-only in depth-1 neighbor mirrors, and denies the
// rest of PORTUNI_ROOT. Everything outside the root stays unrestricted
// (allow default) — this protects the knowledge graph, it is not a
// general-purpose jail.
//
// Profile shape and the two gotchas (Seatbelt matches realpaths only;
// git discovery needs file-read-metadata on the denied root) were
// validated against live sandbox-exec runs — see
// docs/sandbox-spike-2026-06-10.md.

import { realpath } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { getMirrorPath, listUserMirrors } from "./sync/mirror-registry.js";
import { normalize, resolvePortuniRoot } from "./write-scope.js";

// Seatbelt string literal: double-quoted, backslash and quote escaped.
function sbQuote(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface SandboxScope {
  portuniRoot: string;
  homeMirror: string;
  neighborMirrors: string[];
}

// Render the Seatbelt profile. Paths must already be realpath-resolved —
// Seatbelt matches resolved paths only, so a symlinked path (e.g. /tmp on
// macOS) would silently never match. resolveSandboxScopeForNode takes
// care of that; callers composing scopes by hand must do the same.
//
// Rule order is load-bearing: Seatbelt gives later rules precedence, so
// the root deny comes first and the scope allows override it.
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
  const seen = new Set<string>([home]);
  for (const raw of scope.neighborMirrors) {
    const m = normalize(raw);
    if (seen.has(m)) continue;
    seen.add(m);
    lines.push(`(allow file-read* (subpath ${sbQuote(m)}))`);
  }
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

// Resolve the disk scope for a node: its own mirror plus the mirrors of
// its depth-1 graph neighbors (same neighborhood seedScopeFromHome uses
// for the MCP session scope). Returns null when the node has no local
// mirror — there is nothing to sandbox into.
export async function resolveSandboxScopeForNode(
  db: Client,
  userId: string,
  nodeId: string,
): Promise<SandboxScope | null> {
  const home = await getMirrorPath(userId, nodeId);
  if (!home) return null;

  const peers = await db.execute({
    sql: `SELECT DISTINCT
            CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END AS peer_id
          FROM edges e
          WHERE e.source_id = ? OR e.target_id = ?`,
    args: [nodeId, nodeId, nodeId],
  });

  const neighborMirrors: string[] = [];
  for (const row of peers.rows) {
    const peerId = row.peer_id as string | null;
    if (!peerId) continue;
    const mirror = await getMirrorPath(userId, peerId);
    if (mirror) neighborMirrors.push(await resolveReal(mirror));
  }

  const allMirrors = await listUserMirrors(userId);
  const portuniRoot = resolvePortuniRoot({
    envValue: process.env.PORTUNI_ROOT ?? null,
    knownMirrors: allMirrors.map((m) => m.local_path),
  });
  if (!portuniRoot) return null;

  return {
    portuniRoot: await resolveReal(portuniRoot),
    homeMirror: await resolveReal(home),
    neighborMirrors,
  };
}
