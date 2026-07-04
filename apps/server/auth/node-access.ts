// Node-level access via the `node_access` ACL table (spec:
// docs/superpowers/specs/2026-07-04-node-sharing-design.md §2). A node with
// at least one node_access row is restricted to that row set; descendants
// inherit the nearest restricted ancestor along the belongs_to chain (org
// invariant guarantees a single scoping parent, so the walk is
// unambiguous). A node's own ACL is an override, not a merge -- it replaces
// whatever the parent chain would have resolved to.
// Semantics: non-members do not see the node AT ALL (decided in the
// 2026-06-09 design session, superseding the read-only fallback in
// specs.md:203).

import type { Client } from "@libsql/client";
import type { GlobalScope } from "./roles.js";

export interface AccessEntry {
  kind: "group" | "user";
  principal: string;
}

export interface GroupIdentityView {
  globalScope: GlobalScope;
  groups: string[];
  groupIds: string[];
  userId: string;
}

const MAX_CHAIN = 50; // cycle guard; belongs_to chains are short in practice

interface ChainRow {
  node_id: string;
  depth: number;
  visibility: string;
  kind: "group" | "user" | null;
  principal: string | null;
}

async function loadChain(db: Client, nodeId: string): Promise<ChainRow[]> {
  // One recursive-CTE round-trip instead of two queries per belongs_to hop
  // (the old walk cost 2xdepth Turso round-trips on EVERY enforced request;
  // the server has no embedded replica). The correlated LIMIT 1 subquery
  // preserves the original single-path semantics -- the org invariant
  // guarantees one scoping parent, and if data ever violates it we follow
  // the same arbitrary-first edge the loop did.
  const r = await db.execute({
    sql: `WITH RECURSIVE chain(id, depth) AS (
            SELECT ?, 0
            UNION ALL
            SELECT (SELECT e.target_id FROM edges e
                    WHERE e.source_id = c.id AND e.relation = 'belongs_to' LIMIT 1),
                   c.depth + 1
            FROM chain c
            WHERE c.depth < ${MAX_CHAIN}
              AND (SELECT e.target_id FROM edges e
                   WHERE e.source_id = c.id AND e.relation = 'belongs_to' LIMIT 1) IS NOT NULL
          )
          SELECT c.id AS node_id, c.depth, n.visibility, na.kind, na.principal
          FROM chain c
          JOIN nodes n ON n.id = c.id
          LEFT JOIN node_access na ON na.node_id = c.id
          ORDER BY c.depth`,
    args: [nodeId],
  });
  return r.rows.map((row) => ({
    node_id: String(row.node_id),
    depth: Number(row.depth),
    visibility: String(row.visibility),
    kind: row.kind === null ? null : (String(row.kind) as "group" | "user"),
    principal: row.principal === null ? null : String(row.principal),
  }));
}

// Groups the flat chain rows by depth (a depth can carry multiple
// node_access rows, or none via the LEFT JOIN) and walks outward from the
// node itself (depth 0) to the root, stopping at the first depth that is
// authoritative for visibility.
export async function resolveAccessChain(
  db: Client,
  nodeId: string,
): Promise<{ sourceNodeId: string | null; entries: AccessEntry[] | null }> {
  const rows = await loadChain(db, nodeId);
  if (rows.length === 0 || rows[0].depth !== 0) {
    // Missing node -- old contract keeps this null/null (guards handle
    // existence separately).
    return { sourceNodeId: null, entries: null };
  }

  const byDepth = new Map<number, ChainRow[]>();
  for (const row of rows) {
    const bucket = byDepth.get(row.depth);
    if (bucket) bucket.push(row);
    else byDepth.set(row.depth, [row]);
  }

  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (const depth of depths) {
    const bucket = byDepth.get(depth)!;
    const accessRows = bucket.filter((row) => row.kind !== null);
    if (accessRows.length > 0) {
      return {
        sourceNodeId: bucket[0].node_id,
        entries: accessRows.map((row) => ({
          kind: row.kind as "group" | "user",
          principal: row.principal as string,
        })),
      };
    }
    if (bucket[0].visibility === "group") {
      // Restricted-without-rows: fail closed, only admins may see it.
      return { sourceNodeId: bucket[0].node_id, entries: [] };
    }
  }

  return { sourceNodeId: null, entries: null };
}

export async function effectiveAccessEntries(
  db: Client,
  nodeId: string,
): Promise<AccessEntry[] | null> {
  return (await resolveAccessChain(db, nodeId)).entries;
}

export function canSeeNode(
  identity: GroupIdentityView,
  entries: AccessEntry[] | null,
): boolean {
  if (entries === null) return true;
  if (identity.globalScope === "admin") return true;
  return entries.some((e) =>
    e.kind === "user"
      ? e.principal === identity.userId
      : identity.groupIds.includes(e.principal) ||
        identity.groups.some((g) => g.toLowerCase() === e.principal.toLowerCase()),
  );
}

// Convenience one-shot used by guards and list filters.
export async function nodeVisibleTo(
  db: Client,
  identity: GroupIdentityView,
  nodeId: string,
): Promise<boolean> {
  return canSeeNode(identity, await effectiveAccessEntries(db, nodeId));
}

// Request-scoped memoized batch filter for list paths: resolves each
// distinct chain once.
export async function filterVisibleNodeIds(
  db: Client,
  identity: GroupIdentityView,
  nodeIds: string[],
): Promise<Set<string>> {
  if (identity.globalScope === "admin") return new Set(nodeIds);
  const memo = new Map<string, AccessEntry[] | null>();
  const visible = new Set<string>();
  for (const id of nodeIds) {
    let entries = memo.get(id);
    if (entries === undefined) {
      entries = await effectiveAccessEntries(db, id);
      memo.set(id, entries);
    }
    if (canSeeNode(identity, entries)) visible.add(id);
  }
  return visible;
}
