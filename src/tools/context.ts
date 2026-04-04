import { z } from "zod";
import { getDb } from "../db.js";
import { SOLO_USER } from "../schema.js";
import { NodeIdRow } from "../types.js";
import type { InValue } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerContextTools(server: McpServer): void {
  server.tool(
    "portuni_get_context",
    "Traverse the graph from a node. Returns the starting node and connected nodes with decreasing detail by depth. Depth 0 = full detail, depth 1+ = description + edges. No summaries yet.",
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

      // 1. Verify starting node exists
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

      // 2. Recursive CTE to walk edges in both directions up to depth levels
      const walkResult = await db.execute({
        sql: `WITH RECURSIVE graph_walk(node_id, depth) AS (
                SELECT ?, 0
                UNION
                SELECT
                  CASE WHEN e.source_id = gw.node_id THEN e.target_id ELSE e.source_id END,
                  gw.depth + 1
                FROM graph_walk gw
                JOIN edges e ON e.source_id = gw.node_id OR e.target_id = gw.node_id
                WHERE gw.depth < ?
              )
              SELECT gw.node_id, MIN(gw.depth) as depth, n.type, n.name, n.description, n.status
              FROM graph_walk gw
              JOIN nodes n ON n.id = gw.node_id
              GROUP BY gw.node_id
              ORDER BY depth, n.name`,
        args: [args.node_id, args.depth],
      });

      if (walkResult.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No nodes found in traversal" }],
          isError: true,
        };
      }

      // 3. Collect all traversed node IDs
      const nodeIds = walkResult.rows.map((row) => row.node_id as string);

      // 4. Fetch all edges between traversed nodes with JOIN on nodes for names/types
      const placeholders = nodeIds.map(() => "?").join(",");
      const edgeResult = await db.execute({
        sql: `SELECT e.id, e.source_id, e.target_id, e.relation,
                     ns.name as source_name, ns.type as source_type,
                     nt.name as target_name, nt.type as target_type
              FROM edges e
              JOIN nodes ns ON ns.id = e.source_id
              JOIN nodes nt ON nt.id = e.target_id
              WHERE e.source_id IN (${placeholders}) OR e.target_id IN (${placeholders})`,
        args: [...nodeIds, ...nodeIds] as InValue[],
      });

      // 5. Fetch local_mirrors for traversed nodes (for SOLO_USER)
      const mirrorResult = await db.execute({
        sql: `SELECT node_id, local_path FROM local_mirrors
              WHERE user_id = ? AND node_id IN (${placeholders})`,
        args: [SOLO_USER, ...nodeIds] as InValue[],
      });

      // Build mirror lookup
      const mirrorMap = new Map<string, string>();
      for (const row of mirrorResult.rows) {
        mirrorMap.set(row.node_id as string, row.local_path as string);
      }

      // Build edge lookup grouped by node
      const edgesByNode = new Map<string, Array<{
        id: string;
        relation: string;
        direction: string;
        peer_id: string;
        peer_name: string;
        peer_type: string;
      }>>();

      // Initialize empty arrays for all traversed nodes
      for (const nodeId of nodeIds) {
        edgesByNode.set(nodeId, []);
      }

      // 6. Build per-node edge list with direction info
      for (const edge of edgeResult.rows) {
        const sourceId = edge.source_id as string;
        const targetId = edge.target_id as string;

        // For the source node, this edge is outgoing
        const sourceEdges = edgesByNode.get(sourceId);
        if (sourceEdges) {
          sourceEdges.push({
            id: edge.id as string,
            relation: edge.relation as string,
            direction: "outgoing",
            peer_id: targetId,
            peer_name: edge.target_name as string,
            peer_type: edge.target_type as string,
          });
        }

        // For the target node, this edge is incoming
        const targetEdges = edgesByNode.get(targetId);
        if (targetEdges) {
          targetEdges.push({
            id: edge.id as string,
            relation: edge.relation as string,
            direction: "incoming",
            peer_id: sourceId,
            peer_name: edge.source_name as string,
            peer_type: edge.source_type as string,
          });
        }
      }

      // 7. Build context nodes array
      const contextNodes = walkResult.rows.map((row) => {
        const nodeId = row.node_id as string;
        return {
          id: nodeId,
          type: row.type as string,
          name: row.name as string,
          description: row.description as string | null,
          status: row.status as string,
          depth: row.depth as number,
          edges: edgesByNode.get(nodeId) ?? [],
          local_path: mirrorMap.get(nodeId) ?? null,
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(contextNodes, null, 2),
          },
        ],
      };
    },
  );
}
