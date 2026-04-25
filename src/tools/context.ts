import { z } from "zod";
import { getDb } from "../db.js";
import { SOLO_USER } from "../schema.js";
import { listUserMirrors, unregisterMirror } from "../sync/mirror-registry.js";
import type { Client, InValue } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

async function tableExists(db: Client, name: string): Promise<boolean> {
  const res = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    args: [name],
  });
  return res.rows.length > 0;
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

async function fetchResponsibilitiesCount(db: Client, nodeId: string): Promise<number> {
  const has = await tableExists(db, "responsibilities");
  if (!has) return 0;
  const res = await db.execute({
    sql: "SELECT COUNT(*) AS c FROM responsibilities WHERE node_id = ?",
    args: [nodeId],
  });
  return Number(res.rows[0].c ?? 0);
}

// --- Main entry point ---

export async function buildContextPayload(
  db: Client,
  nodeId: string,
  depth: number,
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
    const allMirrors = await listUserMirrors(SOLO_USER);
    for (const m of allMirrors) {
      if (!wanted.has(m.node_id)) continue;
      const e = await db.execute({
        sql: "SELECT 1 FROM nodes WHERE id = ? LIMIT 1",
        args: [m.node_id],
      });
      if (e.rows.length > 0) {
        mirrorMap.set(m.node_id, m.local_path);
      } else {
        void unregisterMirror(SOLO_USER, m.node_id).catch(() => undefined);
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
  const connected: ContextConnectedNode[] = [];
  for (const row of walkResult.rows) {
    const id = row.node_id as string;
    if (id === nodeId) continue; // root handled above
    const nodeDepth = row.d as number;

    let events: Array<Record<string, unknown>> = [];
    if (nodeDepth === 1) {
      const evRes = await db.execute({
        sql: `SELECT id, type, content, status, created_at
                FROM events WHERE node_id = ? AND status = 'active'
                ORDER BY created_at DESC LIMIT 5`,
        args: [id],
      });
      events = evRes.rows.map((e) => ({
        id: e.id as string,
        type: e.type as string,
        content: e.content as string,
        created_at: e.created_at as string,
      }));
    }
    // depth >= 2: no events

    const ownerName = await (async () => {
      const oid = (row.owner_id as string | null) ?? null;
      if (!oid) return null;
      const o = await fetchOwner(db, oid);
      return o ? o.name : null;
    })();

    const respCount = await fetchResponsibilitiesCount(db, id);

    connected.push({
      id,
      type: row.type as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      lifecycle_state: (row.lifecycle_state as string | null) ?? null,
      status: row.status as string,
      owner_name: ownerName,
      responsibilities_count: respCount,
      edges: edgesByNode.get(id) ?? [],
      events,
      local_path: mirrorMap.get(id) ?? null,
      depth: nodeDepth,
    });
  }

  return { root, connected };
}

// Serializer that preserves the previous wire format (a single flat array
// with the root at index 0 followed by connected nodes). Existing MCP
// consumers depend on this shape; the new fields are simply additive.
function serializeForMcp(payload: ContextPayload): unknown[] {
  return [payload.root, ...payload.connected];
}

export function registerContextTools(server: McpServer): void {
  server.tool(
    "portuni_get_context",
    "Traverse the graph from a node. Returns the starting node (depth 0) with full detail (owner, responsibilities with assignees, data_sources, tools, goal, lifecycle_state, events, files, edges) and connected nodes (depth 1+) with lighter detail (lifecycle_state, owner_name, responsibilities_count, edges, recent events at depth 1).",
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

      // Verify starting node exists before running the traversal.
      const startCheck = await db.execute({
        sql: "SELECT id FROM nodes WHERE id = ?",
        args: [args.node_id],
      });
      if (startCheck.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: node ${args.node_id} not found` }],
          isError: true,
        };
      }

      try {
        const payload = await buildContextPayload(db, args.node_id, args.depth);
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
