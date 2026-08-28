// Node-level access via the `node_access` ACL table (spec:
// docs/archive/specs/2026-07-04-node-sharing-design.md §2). A node with
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

// Node-level restriction mode (spec: docs/archive/specs/2026-07-04-node-sharing-design.md
// "Rezim omezeni"). Only meaningful for restricted nodes (entries !== null);
// ignored for unrestricted ones. Inherits with the ACL: a child without its
// own node_access rows takes the authoritative ancestor's mode along with
// its entries.
export type AccessMode = "private" | "request";

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
  access_mode: AccessMode;
  created_by: string;
  kind: "group" | "user" | null;
  principal: string | null;
}

// Upper bound on ids per chain query. Keeps the json_each seed and the CTE
// working set bounded; a whole-graph call (GET /graph) fits in one batch at
// today's sizes and degrades to a handful of round trips, not N.
const CHAIN_BATCH = 500;

// Loads the belongs_to chains of many nodes in ONE round trip, keyed by the
// node each chain was seeded from. One recursive CTE seeded from json_each
// instead of one query per node: the server has no embedded replica, so
// per-node resolution over a ~100-node graph cost ~100 sequential Turso
// round trips (~3 s for GET /graph). The correlated LIMIT 1 subquery
// preserves the single-path semantics -- the org invariant guarantees one
// scoping parent, and if data ever violates it we follow the same
// arbitrary-first edge the old loop did. A missing node yields no rows for
// its root (the JOIN on nodes drops it), which callers treat as unrestricted
// -- same contract as before.
async function loadChains(db: Client, nodeIds: string[]): Promise<Map<string, ChainRow[]>> {
  const byRoot = new Map<string, ChainRow[]>();
  const distinct = [...new Set(nodeIds)];
  for (let i = 0; i < distinct.length; i += CHAIN_BATCH) {
    const batch = distinct.slice(i, i + CHAIN_BATCH);
    const r = await db.execute({
      sql: `WITH RECURSIVE chain(root, id, depth) AS (
              SELECT value, value, 0 FROM json_each(?)
              UNION ALL
              SELECT c.root,
                     (SELECT e.target_id FROM edges e
                      WHERE e.source_id = c.id AND e.relation = 'belongs_to' LIMIT 1),
                     c.depth + 1
              FROM chain c
              WHERE c.depth < ${MAX_CHAIN}
                AND (SELECT e.target_id FROM edges e
                     WHERE e.source_id = c.id AND e.relation = 'belongs_to' LIMIT 1) IS NOT NULL
            )
            SELECT c.root, c.id AS node_id, c.depth, n.visibility, n.access_mode, n.created_by, na.kind, na.principal
            FROM chain c
            JOIN nodes n ON n.id = c.id
            LEFT JOIN node_access na ON na.node_id = c.id
            ORDER BY c.root, c.depth`,
      args: [JSON.stringify(batch)],
    });
    for (const row of r.rows) {
      const root = String(row.root);
      const rows = byRoot.get(root);
      const chainRow: ChainRow = {
        node_id: String(row.node_id),
        depth: Number(row.depth),
        visibility: String(row.visibility),
        access_mode: String(row.access_mode) as AccessMode,
        created_by: String(row.created_by),
        kind: row.kind === null ? null : (String(row.kind) as "group" | "user"),
        principal: row.principal === null ? null : String(row.principal),
      };
      if (rows) rows.push(chainRow);
      else byRoot.set(root, [chainRow]);
    }
  }
  return byRoot;
}

async function loadChain(db: Client, nodeId: string): Promise<ChainRow[]> {
  return (await loadChains(db, [nodeId])).get(nodeId) ?? [];
}

interface ResolvedChain {
  sourceNodeId: string | null;
  entries: AccessEntry[] | null;
  mode: AccessMode | null;
  // True when `entries` is a synthetic "only the creator" list derived from
  // visibility='private' (no real node_access rows). Enforcement treats it
  // like any other ACL; display (buildAccessView) must NOT show it as a
  // group restriction -- a private node has no shared grantees.
  implicitPrivate: boolean;
}

// Resolves many nodes' ACLs with one chain query (see loadChains). Each
// distinct id appears once in the result even if repeated in the input.
async function resolveAccessChains(
  db: Client,
  nodeIds: string[],
): Promise<Map<string, ResolvedChain>> {
  const chains = await loadChains(db, nodeIds);
  const result = new Map<string, ResolvedChain>();
  for (const id of nodeIds) {
    if (!result.has(id)) result.set(id, resolveChainRows(chains.get(id) ?? []));
  }
  return result;
}

// Groups the flat chain rows by depth (a depth can carry multiple
// node_access rows, or none via the LEFT JOIN) and walks outward from the
// node itself (depth 0) to the root, stopping at the first depth that is
// authoritative for visibility.
export async function resolveAccessChain(
  db: Client,
  nodeId: string,
): Promise<ResolvedChain> {
  return resolveChainRows(await loadChain(db, nodeId));
}

function resolveChainRows(rows: ChainRow[]): ResolvedChain {
  if (rows.length === 0 || rows[0].depth !== 0) {
    // Missing node -- old contract keeps this null/null (guards handle
    // existence separately).
    return { sourceNodeId: null, entries: null, mode: null, implicitPrivate: false };
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
        mode: bucket[0].access_mode,
        implicitPrivate: false,
      };
    }
    if (bucket[0].visibility === "group") {
      // Restricted-without-rows: fail closed, only admins may see it. Mode
      // still comes from this same node -- it is the authoritative one.
      return {
        sourceNodeId: bucket[0].node_id,
        entries: [],
        mode: bucket[0].access_mode,
        implicitPrivate: false,
      };
    }
    if (bucket[0].visibility === "private") {
      // Private: visible only to the creator (implicit self-grant) and
      // admins (canSeeNode's admin bypass). Everyone else is hidden -- same
      // as a group node whose sole grant is the creator. mode is null: a
      // private node offers no "request" affordance, so classifyNodeVisibility
      // resolves it to "hidden" (it disappears), not "request".
      return {
        sourceNodeId: bucket[0].node_id,
        entries: [{ kind: "user", principal: bucket[0].created_by }],
        mode: null,
        implicitPrivate: true,
      };
    }
  }

  return { sourceNodeId: null, entries: null, mode: null, implicitPrivate: false };
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

// Batch filter for list paths: one chain query for the whole id set
// (loadChains), each distinct id resolved once.
export async function filterVisibleNodeIds(
  db: Client,
  identity: GroupIdentityView,
  nodeIds: string[],
): Promise<Set<string>> {
  if (identity.globalScope === "admin") return new Set(nodeIds);
  const resolved = await resolveAccessChains(db, nodeIds);
  const visible = new Set<string>();
  for (const [id, chain] of resolved) {
    if (canSeeNode(identity, chain.entries)) visible.add(id);
  }
  return visible;
}

// Combined single-pass helper for GET /graph: for every node id, resolves
// the ACL chain ONCE and derives BOTH the visibility decision and the
// `restricted` flag from that single resolution. Replaces the former
// filterVisibleNodeIds + restrictedNodeIds two-pass combo, which cost
// members up to 2x the chain resolutions (once to filter, once again for the
// flag on the visible subset) and cost admins a full N resolutions purely
// for the flag despite their visibility being trivially true. Like
// filterVisibleNodeIds/classifyNodeVisibility it loads every chain in ONE
// query (loadChains) -- the flag needs the chains even for admins, and
// resolving them one node at a time made GET /graph cost N Turso round
// trips (~3 s at ~100 nodes).
export async function visibilityWithRestriction(
  db: Client,
  identity: GroupIdentityView,
  nodeIds: string[],
): Promise<Map<string, { visible: boolean; restricted: boolean }>> {
  const isAdmin = identity.globalScope === "admin";
  const resolved = await resolveAccessChains(db, nodeIds);
  const result = new Map<string, { visible: boolean; restricted: boolean }>();
  for (const [id, chain] of resolved) {
    const visible = isAdmin ? true : canSeeNode(identity, chain.entries);
    result.set(id, { visible, restricted: chain.entries !== null });
  }
  return result;
}

// Three-way classification for edge/related-node filters (spec: "Rezim
// omezeni"): a `mode='request'` node that a non-member cannot see still
// surfaces as a locked chip (name + type only) instead of disappearing
// entirely like a `private` one does. One chain query for the whole id set
// (loadChains), each distinct id resolved once.
export async function classifyNodeVisibility(
  db: Client,
  identity: GroupIdentityView,
  nodeIds: string[],
): Promise<Map<string, "visible" | "request" | "hidden">> {
  const result = new Map<string, "visible" | "request" | "hidden">();
  if (identity.globalScope === "admin") {
    for (const id of nodeIds) result.set(id, "visible");
    return result;
  }

  const resolved = await resolveAccessChains(db, nodeIds);
  for (const [id, chain] of resolved) {
    if (canSeeNode(identity, chain.entries)) {
      result.set(id, "visible");
    } else if (chain.mode === "request") {
      result.set(id, "request");
    } else {
      result.set(id, "hidden");
    }
  }
  return result;
}
