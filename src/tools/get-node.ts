import { z } from "zod";
import { getDb } from "../db.js";
import { SOLO_USER } from "../schema.js";
import { NodeRow } from "../types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerGetNodeTool(server: McpServer): void {
  server.tool(
    "portuni_get_node",
    "Get a single node from the Portuni knowledge graph by ID or name. Returns node fields, direct edges (both directions), files, and local mirror path.",
    {
      node_id: z.string().optional().describe("Node ID (ULID)"),
      name: z.string().optional().describe("Node name (case-insensitive match)"),
    },
    async (args) => {
      const db = getDb();

      // 1. Look up the node
      let result;
      if (args.node_id) {
        result = await db.execute({
          sql: "SELECT * FROM nodes WHERE id = ?",
          args: [args.node_id],
        });
      } else if (args.name) {
        result = await db.execute({
          sql: "SELECT * FROM nodes WHERE name = ? COLLATE NOCASE",
          args: [args.name],
        });
      } else {
        return {
          content: [{ type: "text" as const, text: "Error: provide either node_id or name" }],
          isError: true,
        };
      }

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Node not found" }],
          isError: true,
        };
      }

      const row = NodeRow.parse(result.rows[0]);

      // 2. Fetch direct edges (both directions) with peer names/types
      const edgeResult = await db.execute({
        sql: `SELECT e.id, e.source_id, e.target_id, e.relation,
                     ns.name as source_name, ns.type as source_type,
                     nt.name as target_name, nt.type as target_type
              FROM edges e
              JOIN nodes ns ON ns.id = e.source_id
              JOIN nodes nt ON nt.id = e.target_id
              WHERE e.source_id = ? OR e.target_id = ?`,
        args: [row.id, row.id],
      });

      const edges = edgeResult.rows.map((edge) => {
        const sourceId = edge.source_id as string;
        const targetId = edge.target_id as string;
        const isOutgoing = sourceId === row.id;
        return {
          id: edge.id as string,
          relation: edge.relation as string,
          direction: isOutgoing ? "outgoing" : "incoming",
          peer_id: isOutgoing ? targetId : sourceId,
          peer_name: isOutgoing ? (edge.target_name as string) : (edge.source_name as string),
          peer_type: isOutgoing ? (edge.target_type as string) : (edge.source_type as string),
        };
      });

      // 3. Fetch files for this node
      const fileResult = await db.execute({
        sql: `SELECT id, filename, status, description, local_path, mime_type
              FROM files WHERE node_id = ? ORDER BY created_at DESC`,
        args: [row.id],
      });

      const files = fileResult.rows.map((f) => ({
        id: f.id as string,
        filename: f.filename as string,
        status: f.status as string,
        description: f.description as string | null,
        local_path: f.local_path as string | null,
        mime_type: f.mime_type as string | null,
      }));

      // 4. Fetch local mirror for SOLO_USER
      const mirrorResult = await db.execute({
        sql: `SELECT local_path, registered_at
              FROM local_mirrors WHERE user_id = ? AND node_id = ?`,
        args: [SOLO_USER, row.id],
      });

      const localMirror =
        mirrorResult.rows.length > 0
          ? {
              local_path: mirrorResult.rows[0].local_path as string,
              registered_at: mirrorResult.rows[0].registered_at as string,
            }
          : null;

      // 5. Assemble response
      const node = {
        id: row.id,
        type: row.type,
        name: row.name,
        description: row.description,
        meta: row.meta ? JSON.parse(row.meta) : null,
        status: row.status,
        visibility: row.visibility,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        edges,
        files,
        local_mirror: localMirror,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(node, null, 2) }],
      };
    },
  );
}
