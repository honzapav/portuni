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
  let current: string | null = nodeId;
  for (let i = 0; i < MAX_CHAIN && current !== null; i += 1) {
    const nodeId_: string = current;
    // eslint-disable-next-line no-await-in-loop
    const r: Awaited<ReturnType<typeof db.execute>> = await db.execute({
      sql: "SELECT visibility, meta FROM nodes WHERE id = ?",
      args: [nodeId_],
    });
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    if (row.visibility === "group") {
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
    // eslint-disable-next-line no-await-in-loop
    const edge: Awaited<ReturnType<typeof db.execute>> = await db.execute({
      sql: `SELECT target_id FROM edges WHERE source_id = ? AND relation = 'belongs_to' LIMIT 1`,
      args: [nodeId_],
    });
    current = edge.rows.length > 0 ? String(edge.rows[0].target_id) : null;
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
