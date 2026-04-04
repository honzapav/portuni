import { z } from "zod";
import { getDb } from "../db.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerGetNodeTool(server: McpServer): void {
  server.tool(
    "portuni_get_node",
    "Get a single node from the Portuni knowledge graph by ID or name.",
    {
      node_id: z.string().optional().describe("Node ID (ULID)"),
      name: z.string().optional().describe("Node name (exact match)"),
    },
    async (args) => {
      const db = getDb();

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

      const row = result.rows[0];
      const node = {
        id: row.id,
        type: row.type,
        name: row.name,
        description: row.description,
        summary: row.summary,
        meta: row.meta ? JSON.parse(row.meta as string) : null,
        status: row.status,
        visibility: row.visibility,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(node, null, 2) }],
      };
    },
  );
}
