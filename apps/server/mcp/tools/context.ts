import { z } from "zod";
import { getDb } from "../../infra/db.js";
import { listUserMirrors, unregisterMirror, getMirrorPath } from "../../domain/sync/mirror-registry.js";
import { readableMirrorRoot } from "../scope-reconciler.js";
import type { Client, InValue } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guardNodeRead } from "../scope.js";
import { logAudit } from "../../infra/audit.js";
import { filterVisibleNodeIds, type GroupIdentityView } from "../../auth/node-access.js";
import type { SessionCtx } from "../server.js";

// --- Task E3: enriched context payload shape ---
//
// Depth-0 nodes (the root + any node the caller asks about via get-node)
// carry the full set of "who runs this" fields: owner, responsibilities with
// assignees, data_sources, tools, goal, lifecycle_state.
//
// Depth-1+ (connected) nodes carry only lightweight breadcrumbs
// (owner_name, responsibilities_count, lifecycle_state) so the LLM can see
// the shape of the neighborhood without paying for every detail.

export type ContextOwner = { id: string; name: string };

export type ContextAssignee = { id: string; name: string; type: string };

export type ContextResponsibility = {
  id: string;
  title: string;
  description: string | null;
  sort_order: number;
  assignees: ContextAssignee[];
};

export type ContextAttrRow = {
  id: string;
  name: string;
  description: string | null;
  external_link: string | null;
};

export type ContextEdge = {
  id: string;
  relation: string;
  direction: string;
  peer_id: string;
  peer_name: string;
  peer_type: string;
};

export type ContextRootNode = {
  id: string;
  type: string;
  name: string;
  description: string | null;
  goal: string | null;
  lifecycle_state: string | null;
  status: string;
  owner: ContextOwner | null;
  responsibilities: ContextResponsibility[];
  data_sources: ContextAttrRow[];
  tools: ContextAttrRow[];
  edges: ContextEdge[];
  events: Array<Record<string, unknown>>;
  local_path: string | null;
  depth: 0;
};

export type ContextConnectedNode = {
  id: string;
  type: string;
  name: string;
  description: string | null;
  lifecycle_state: string | null;
  status: string;
  owner_name: string | null;
  responsibilities_count: number;
  edges: ContextEdge[];
  events: Array<Record<string, unknown>>;
  local_path: string | null;
  depth: number;
};

export type ContextPayload = {
  root: ContextRootNode;
  connected: ContextConnectedNode[];
};

// --- Helpers (pure, take Client) ---

// Cached per client: tables are only ever created (by migrations at boot),
// never dropped at runtime, and this used to be re-queried for every
// connected node on the hot get-context path -- one Turso round trip each.
const tableExistsCache = new WeakMap<Client, Map<string, boolean>>();

async function tableExists(db: Client, name: string): Promise<boolean> {
  let perDb = tableExistsCache.get(db);
  if (perDb?.has(name)) return perDb.get(name)!;
  const res = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    args: [name],
  });
  const exists = res.rows.length > 0;
  if (!perDb) {
    perDb = new Map();
    tableExistsCache.set(db, perDb);
  }
  // Only cache positive answers: a missing table will appear after the
  // migration that creates it, and we must notice.
  if (exists) perDb.set(name, true);
  return exists;
}

async function fetchOwner(db: Client, ownerId: string | null): Promise<ContextOwner | null> {
  if (!ownerId) return null;
  const hasActors = await tableExists(db, "actors");
  if (!hasActors) return null;
  const res = await db.execute({
    sql: "SELECT id, name FROM actors WHERE id = ?",
    args: [ownerId],
  });
  if (res.rows.length === 0) return null;
  return {
    id: res.rows[0].id as string,
    name: res.rows[0].name as string,
  };
}

async function fetchResponsibilities(db: Client, nodeId: string): Promise<ContextResponsibility[]> {
  const hasResp = await tableExists(db, "responsibilities");
  if (!hasResp) return [];
  const rRes = await db.execute({
    sql: `SELECT id, title, description, sort_order
            FROM responsibilities
           WHERE node_id = ?
           ORDER BY sort_order, title`,
    args: [nodeId],
  });
  if (rRes.rows.length === 0) return [];

  const respIds = rRes.rows.map((r) => r.id as string);
  const placeholders = respIds.map(() => "?").join(",");
  const aRes = await db.execute({
    sql: `SELECT ra.responsibility_id AS responsibility_id,
                 a.id   AS actor_id,
                 a.name AS actor_name,
                 a.type AS actor_type
            FROM responsibility_assignments ra
            JOIN actors a ON a.id = ra.actor_id
           WHERE ra.responsibility_id IN (${placeholders})
           ORDER BY a.name`,
    args: respIds as InValue[],
  });

  const assigneesByResp = new Map<string, ContextAssignee[]>();
  for (const id of respIds) assigneesByResp.set(id, []);
  for (const row of aRes.rows) {
    const bucket = assigneesByResp.get(row.responsibility_id as string);
    if (bucket) {
      bucket.push({
        id: row.actor_id as string,
        name: row.actor_name as string,
        type: row.actor_type as string,
      });
    }
  }

  return rRes.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    sort_order: r.sort_order as number,
    assignees: assigneesByResp.get(r.id as string) ?? [],
  }));
}

async function fetchAttrRows(db: Client, table: "data_sources" | "tools", nodeId: string): Promise<ContextAttrRow[]> {
  const has = await tableExists(db, table);
  if (!has) return [];
  const res = await db.execute({
    sql: `SELECT id, name, description, external_link
            FROM ${table}
           WHERE node_id = ?
           ORDER BY name`,
    args: [nodeId],
  });
  return res.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    external_link: (r.external_link as string | null) ?? null,
  }));
}


// --- Main entry point ---

export async function buildContextPayload(
  db: Client,
  nodeId: string,
  depth: number,
  userId: string,
  identity?: GroupIdentityView,
): Promise<ContextPayload> {
  // 1. Load the root node row. owner_id / goal / lifecycle_state columns are
  //    added by migration 006; fall back to nulls if not present (shouldn't
  //    happen in production, but keeps us robust against older test schemas).
  const rootRes = await db.execute({
    sql: `SELECT id, type, name, description, status, owner_id, goal, lifecycle_state
            FROM nodes WHERE id = ?`,
    args: [nodeId],
  });
  if (rootRes.rows.length === 0) {
    throw new Error(`node ${nodeId} not found`);
  }
  const rootRow = rootRes.rows[0];

  // 2. Walk the graph up to `depth` levels (bidirectional edge traversal).
  const walkResult = await db.execute({
    sql: `WITH RECURSIVE graph_walk(node_id, d) AS (
            SELECT ?, 0
            UNION
            SELECT
              CASE WHEN e.source_id = gw.node_id THEN e.target_id ELSE e.source_id END,
              gw.d + 1
            FROM graph_walk gw
            JOIN edges e ON e.source_id = gw.node_id OR e.target_id = gw.node_id
            WHERE gw.d < ?
          )
          SELECT gw.node_id, MIN(gw.d) AS d,
                 n.type, n.name, n.description, n.status,
                 n.owner_id, n.lifecycle_state
          FROM graph_walk gw
          JOIN nodes n ON n.id = gw.node_id
          GROUP BY gw.node_id
          ORDER BY d, n.name`,
    args: [nodeId, depth],
  });

  const nodeIds = walkResult.rows.map((row) => row.node_id as string);

  // 3. Fetch all edges between traversed nodes (with peer names/types) so
  //    each node's per-direction edge list can be built.
  const edgesByNode = new Map<string, ContextEdge[]>();
  for (const id of nodeIds) edgesByNode.set(id, []);

  if (nodeIds.length > 0) {
    const placeholders = nodeIds.map(() => "?").join(",");
    const edgeResult = await db.execute({
      sql: `SELECT e.id, e.source_id, e.target_id, e.relation,
                   ns.name AS source_name, ns.type AS source_type,
                   nt.name AS target_name, nt.type AS target_type
              FROM edges e
              JOIN nodes ns ON ns.id = e.source_id
              JOIN nodes nt ON nt.id = e.target_id
             WHERE e.source_id IN (${placeholders}) OR e.target_id IN (${placeholders})`,
      args: [...nodeIds, ...nodeIds] as InValue[],
    });

    for (const edge of edgeResult.rows) {
      const sourceId = edge.source_id as string;
      const targetId = edge.target_id as string;
      const srcBucket = edgesByNode.get(sourceId);
      if (srcBucket) {
        srcBucket.push({
          id: edge.id as string,
          relation: edge.relation as string,
          direction: "outgoing",
          peer_id: targetId,
          peer_name: edge.target_name as string,
          peer_type: edge.target_type as string,
        });
      }
      const tgtBucket = edgesByNode.get(targetId);
      if (tgtBucket) {
        tgtBucket.push({
          id: edge.id as string,
          relation: edge.relation as string,
          direction: "incoming",
          peer_id: sourceId,
          peer_name: edge.source_name as string,
          peer_type: edge.source_type as string,
        });
      }
    }
  }

  // 4. Fetch local mirrors from the per-device sync.db. Tolerate stale rows
  //    (mirror exists for a node that was purged from the shared DB) by
  //    skipping them and firing fire-and-forget cleanup.
  const mirrorMap = new Map<string, string>();
  if (nodeIds.length > 0) {
    const wanted = new Set(nodeIds);
    const allMirrors = await listUserMirrors(userId);
    for (const m of allMirrors) {
      if (!wanted.has(m.node_id)) continue;
      const e = await db.execute({
        sql: "SELECT 1 FROM nodes WHERE id = ? LIMIT 1",
        args: [m.node_id],
      });
      if (e.rows.length > 0) {
        mirrorMap.set(m.node_id, m.local_path);
      } else {
        void unregisterMirror(userId, m.node_id).catch(() => undefined);
      }
    }
  }

  // 5. Build the root (depth 0) entry with full enrichment.
  const [owner, responsibilities, dataSources, tools] = await Promise.all([
    fetchOwner(db, (rootRow.owner_id as string | null) ?? null),
    fetchResponsibilities(db, nodeId),
    fetchAttrRows(db, "data_sources", nodeId),
    fetchAttrRows(db, "tools", nodeId),
  ]);

  // Root events (full detail, like the old depth=0 branch).
  let rootEvents: Array<Record<string, unknown>> = [];
  const rootEvRes = await db.execute({
    sql: `SELECT id, type, content, meta, status, refs, task_ref, created_at
            FROM events WHERE node_id = ? AND status = 'active'
            ORDER BY created_at DESC LIMIT 50`,
    args: [nodeId],
  });
  rootEvents = rootEvRes.rows.map((e) => ({
    id: e.id as string,
    type: e.type as string,
    content: e.content as string,
    meta: e.meta ? JSON.parse(e.meta as string) : null,
    status: e.status as string,
    task_ref: e.task_ref as string | null,
    created_at: e.created_at as string,
  }));

  const root: ContextRootNode = {
    id: rootRow.id as string,
    type: rootRow.type as string,
    name: rootRow.name as string,
    description: (rootRow.description as string | null) ?? null,
    goal: (rootRow.goal as string | null) ?? null,
    lifecycle_state: (rootRow.lifecycle_state as string | null) ?? null,
    status: rootRow.status as string,
    owner,
    responsibilities,
    data_sources: dataSources,
    tools,
    edges: edgesByNode.get(nodeId) ?? [],
    events: rootEvents,
    local_path: mirrorMap.get(nodeId) ?? null,
    depth: 0,
  };

  // 6. Build connected nodes (depth >= 1) with lightweight enrichment.
  // Batched: the previous per-node loop ran up to 4 sequential queries per
  // connected node -- 100+ Turso round trips for a well-connected node on
  // the hot "start work" path. Three IN() queries replace all of them.
  const connectedRows = walkResult.rows.filter((row) => (row.node_id as string) !== nodeId);
  const depth1Ids = connectedRows
    .filter((row) => (row.d as number) === 1)
    .map((row) => row.node_id as string);
  const ownerIds = [
    ...new Set(
      connectedRows
        .map((row) => (row.owner_id as string | null) ?? null)
        .filter((v): v is string => v !== null),
    ),
  ];

  const eventsByNode = new Map<string, Array<Record<string, unknown>>>();
  if (depth1Ids.length > 0) {
    const ph = depth1Ids.map(() => "?").join(",");
    const evRes = await db.execute({
      sql: `SELECT node_id, id, type, content, created_at FROM (
              SELECT node_id, id, type, content, created_at,
                     ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY created_at DESC) AS rn
                FROM events WHERE node_id IN (${ph}) AND status = 'active'
            ) WHERE rn <= 5 ORDER BY created_at DESC`,
      args: depth1Ids,
    });
    for (const e of evRes.rows) {
      const nid = e.node_id as string;
      if (!eventsByNode.has(nid)) eventsByNode.set(nid, []);
      eventsByNode.get(nid)!.push({
        id: e.id as string,
        type: e.type as string,
        content: e.content as string,
        created_at: e.created_at as string,
      });
    }
  }

  const ownerNameById = new Map<string, string>();
  if (ownerIds.length > 0 && (await tableExists(db, "actors"))) {
    const ph = ownerIds.map(() => "?").join(",");
    const oRes = await db.execute({
      sql: `SELECT id, name FROM actors WHERE id IN (${ph})`,
      args: ownerIds,
    });
    for (const o of oRes.rows) ownerNameById.set(o.id as string, o.name as string);
  }

  const respCountByNode = new Map<string, number>();
  if (connectedRows.length > 0 && (await tableExists(db, "responsibilities"))) {
    const ids = connectedRows.map((row) => row.node_id as string);
    const ph = ids.map(() => "?").join(",");
    const rRes = await db.execute({
      sql: `SELECT node_id, COUNT(*) AS c FROM responsibilities WHERE node_id IN (${ph}) GROUP BY node_id`,
      args: ids,
    });
    for (const r of rRes.rows) respCountByNode.set(r.node_id as string, Number(r.c));
  }

  const connected: ContextConnectedNode[] = connectedRows.map((row) => {
    const id = row.node_id as string;
    const ownerId = (row.owner_id as string | null) ?? null;
    return {
      id,
      type: row.type as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      lifecycle_state: (row.lifecycle_state as string | null) ?? null,
      status: row.status as string,
      owner_name: ownerId ? (ownerNameById.get(ownerId) ?? null) : null,
      responsibilities_count: respCountByNode.get(id) ?? 0,
      edges: edgesByNode.get(id) ?? [],
      events: (row.d as number) === 1 ? (eventsByNode.get(id) ?? []) : [],
      local_path: mirrorMap.get(id) ?? null,
      depth: row.d as number,
    };
  });

  // 7. Filter connected nodes and root edges for group visibility.
  //    Hidden nodes are silently dropped; edges touching hidden nodes are
  //    pruned so the caller cannot infer their existence from the edge list.
  if (identity !== undefined) {
    const allConnectedIds = connected.map((n) => n.id);
    // Collect all unique peer IDs that appear in any edge (including those
    // not present in the walk, which can occur at depth=0). We need to check
    // their visibility so edges are pruned correctly regardless of depth.
    const allEdgePeerIds = new Set<string>();
    for (const e of root.edges) allEdgePeerIds.add(e.peer_id);
    for (const n of connected) {
      for (const e of n.edges) allEdgePeerIds.add(e.peer_id);
    }
    allEdgePeerIds.delete(nodeId); // root is always visible to itself

    // Union of walked connected IDs + edge peers; filter all at once.
    const candidateIds = [...new Set([...allConnectedIds, ...allEdgePeerIds])];
    const visibleSet = await filterVisibleNodeIds(db, identity, candidateIds);
    const visibleConnected = connected.filter((n) => visibleSet.has(n.id));
    const visibleIds = new Set([nodeId, ...visibleSet]);
    const prunedRootEdges = root.edges.filter(
      (e) => visibleIds.has(e.peer_id),
    );
    return {
      root: { ...root, edges: prunedRootEdges },
      connected: visibleConnected.map((n) => ({
        ...n,
        edges: n.edges.filter((e) => visibleIds.has(e.peer_id)),
      })),
    };
  }

  return { root, connected };
}

// Serializer that preserves the previous wire format (a single flat array
// with the root at index 0 followed by connected nodes). Existing MCP
// consumers depend on this shape; the new fields are simply additive.
function serializeForMcp(payload: ContextPayload): unknown[] {
  return [payload.root, ...payload.connected];
}

export function registerContextTools(server: McpServer, ctx: SessionCtx): void {
  const { scope } = ctx;
  server.tool(
    "portuni_get_context",
    "Traverse the graph from a node. Call this before starting work on a node to load it plus its neighbourhood. Returns the starting node (depth 0) with full detail (owner, responsibilities with assignees, data_sources, tools, goal, lifecycle_state, events, files, edges) and connected nodes (depth 1+) with lighter detail (lifecycle_state, owner_name, responsibilities_count, edges, recent events at depth 1). The starting node must be in session scope; nodes revealed by traversal are added to scope automatically and recorded in the expansion log. For single-node detail without traversal use portuni_get_node.",
    {
      node_id: z.string().describe("Starting node ID (ULID)"),
      depth: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .default(1)
        .describe("Traversal depth (0-5, default 1)"),
    },
    async (args) => {
      const db = getDb();

      // Scope gate on the start node. Passing identity enables group-
      // visibility check: non-members get not_found, never an elicit.
      const guard = await guardNodeRead(db, scope, args.node_id, ctx.identity.userId, async (action, targetId, detail) => {
        await logAudit(ctx.identity.userId, action, "scope", targetId, detail);
      }, ctx.identity);
      if (guard.kind === "not_found") {
        return {
          content: [{ type: "text" as const, text: `Error: node ${args.node_id} not found` }],
          isError: true,
        };
      }
      if (guard.kind === "elicit") {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(guard.error) },
          ],
          isError: true,
        };
      }

      // Depth gate. depth=0/1 is the natural "this node + its immediate
      // neighbors" read; depth>=2 walks out beyond what session_init seeded
      // and is treated as breadth expansion. strict/balanced refuse without
      // explicit confirmation; permissive auto-allows + audits.
      if (args.depth >= 2 && scope.mode !== "permissive") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "scope_expansion_required",
                node_id: args.node_id,
                hint:
                  `Traversal depth ${args.depth} from ${args.node_id} reaches beyond the session scope's depth-1 horizon. ` +
                  "Ask the user to confirm the breadth, then either call portuni_get_context with depth=1 (and walk further with explicit portuni_expand_scope), or run under PORTUNI_SCOPE_MODE=permissive.",
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const payload = await buildContextPayload(db, args.node_id, args.depth, ctx.identity.userId, ctx.identity);
        // depth=0/1 reads everything within one hop of an in-scope start
        // node, which is consistent with the "home + depth-1" seed rule.
        // permissive mode also auto-adds depth>=2 results. We never auto-add
        // beyond what the gate above lets through.
        const added: string[] = [];
        for (const n of [payload.root, ...payload.connected]) {
          if (scope.add(n.id)) added.push(n.id);
        }
        if (added.length > 0) {
          scope.recordExpansion({
            at: new Date().toISOString(),
            node_ids: added,
            reason: `traversal from ${args.node_id} depth ${args.depth}`,
            triggered_by: "traversal",
          });
          await logAudit(ctx.identity.userId, "expand_scope", "scope", added.join(","), {
            node_ids: added,
            reason: "traversal",
            triggered_by: "traversal",
            start: args.node_id,
            depth: args.depth,
            mode: scope.mode,
          });
        }

        // Rewrite local_path for non-home in-scope nodes to the staged copy
        // that the Seatbelt sandbox actually allows reading. Await staging
        // first so the copy is complete before the agent acts on the path:
        // a node discovered for the FIRST time in this call has its onAdd
        // staging still in flight, so a follow-up Read could hit a mid-copy
        // dir. The reconciler's in-flight dedup means this joins the copy
        // onAdd already started (no double work). Scoped to the nodes this
        // get_context call surfaces — not the whole session scope.
        const allPayloadNodes: Array<{ id: string; local_path: string | null }> = [
          payload.root,
          ...payload.connected,
        ];
        await Promise.all(
          allPayloadNodes
            .filter((n) => n.id !== scope.homeNodeId && scope.has(n.id))
            .map((n) => ctx.reconciler.reconcileNode(n.id)),
        );
        const homeMirror = scope.homeNodeId
          ? await getMirrorPath(ctx.identity.userId, scope.homeNodeId)
          : null;
        for (const n of allPayloadNodes) {
          n.local_path = readableMirrorRoot({
            scope,
            nodeId: n.id,
            homeMirror,
            realMirror: n.local_path,
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(serializeForMcp(payload), null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
