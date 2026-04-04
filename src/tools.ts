import { z } from "zod";
import { ulid } from "ulid";
import { getDb } from "./db.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const HARDCODED_USER = "solo";

export function registerTools(server: McpServer): void {
  server.tool(
    "portuni_create_node",
    "Create a new node in the Portuni knowledge graph. Node types: organization, process, process_instance, area, project, principle, methodology (not enforced).",
    {
      type: z.string().describe("Node type (e.g. organization, process, project)"),
      name: z.string().describe("Human-readable name"),
      description: z.string().optional().describe("What this node represents"),
      meta: z.record(z.string(), z.unknown()).optional().describe("Type-specific JSON data"),
      status: z.enum(["active", "completed", "archived"]).optional().describe("Node status (default: active)"),
      visibility: z.enum(["team", "private"]).optional().describe("Visibility (default: team)"),
    },
    async (args) => {
      const db = getDb();
      const id = ulid();
      const now = new Date().toISOString();

      await db.execute({
        sql: `INSERT INTO nodes (id, type, name, description, meta, status, visibility, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          args.type,
          args.name,
          args.description ?? null,
          args.meta ? JSON.stringify(args.meta) : null,
          args.status ?? "active",
          args.visibility ?? "team",
          HARDCODED_USER,
          now,
          now,
        ],
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id, type: args.type, name: args.name, status: args.status ?? "active" }),
          },
        ],
      };
    },
  );

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
