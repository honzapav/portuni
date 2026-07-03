// Node-level access via project Google Groups (spec §3). A node with
// visibility='group' carries meta.access_group; descendants inherit the
// nearest restricted ancestor along the belongs_to chain (org invariant
// guarantees a single scoping parent, so the walk is unambiguous).
// Semantics: non-members do not see the node AT ALL (decided in the
// 2026-06-09 design session, superseding the read-only fallback in
// specs.md:203).

import type { Client } from "@libsql/client";
import type { GlobalScope } from "./roles.js";

export interface GroupIdentityView {
  globalScope: GlobalScope;
  groups: string[];
}

const MAX_CHAIN = 50; // cycle guard; belongs_to chains are short in practice

export async function effectiveAccessGroup(
  db: Client,
  nodeId: string,
): Promise<string | null> {
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
          SELECT n.visibility, n.meta, c.depth
          FROM chain c JOIN nodes n ON n.id = c.id
          ORDER BY c.depth`,
    args: [nodeId],
  });
  // Row 0 is the node itself; a missing node keeps the old contract (null).
  if (r.rows.length === 0 || Number(r.rows[0].depth) !== 0) return null;
  for (const row of r.rows) {
    if (row.visibility !== "group") continue;
    try {
      const meta = JSON.parse(String(row.meta ?? "{}")) as {
        access_group?: unknown;
      };
      if (typeof meta.access_group === "string" && meta.access_group) {
        return meta.access_group.toLowerCase();
      }
    } catch {
      /* malformed meta -> restricted-without-group: deny-safe */
    }
    // visibility='group' without a parseable access_group: fail closed.
    return "__unresolvable__";
  }
  return null;
}

export function canSeeNode(
  identity: GroupIdentityView,
  accessGroup: string | null,
): boolean {
  if (accessGroup === null) return true;
  if (identity.globalScope === "admin") return true;
  return identity.groups.some((g) => g.toLowerCase() === accessGroup);
}

// Convenience one-shot used by guards and list filters.
export async function nodeVisibleTo(
  db: Client,
  identity: GroupIdentityView,
  nodeId: string,
): Promise<boolean> {
  return canSeeNode(identity, await effectiveAccessGroup(db, nodeId));
}

// Request-scoped memoized batch filter for list paths: resolves each
// distinct chain once.
export async function filterVisibleNodeIds(
  db: Client,
  identity: GroupIdentityView,
  nodeIds: string[],
): Promise<Set<string>> {
  if (identity.globalScope === "admin") return new Set(nodeIds);
  const memo = new Map<string, string | null>();
  const visible = new Set<string>();
  for (const id of nodeIds) {
    let group = memo.get(id);
    if (group === undefined) {
      group = await effectiveAccessGroup(db, id);
      memo.set(id, group);
    }
    if (canSeeNode(identity, group)) visible.add(id);
  }
  return visible;
}
