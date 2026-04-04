import { z } from "zod";
import { ulid } from "ulid";
import { getDb } from "../db.js";
import { logAudit } from "../audit.js";
import { SOLO_USER } from "../schema.js";
import { NodeRow, NodeSummaryRow } from "../types.js";
import type { InValue } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerNodeTools(server: McpServer): void {
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
          SOLO_USER,
          now,
          now,
        ],
      });

      await logAudit(SOLO_USER, "create_node", "node", id, {
        type: args.type,
        name: args.name,
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
    "portuni_update_node",
    "Update an existing node in the Portuni knowledge graph. Only provided fields are changed.",
    {
      node_id: z.string().describe("Node ID (ULID)"),
      name: z.string().optional().describe("New human-readable name"),
      description: z.string().optional().describe("New description"),
      status: z.enum(["active", "completed", "archived"]).optional().describe("New status"),
      meta: z.record(z.string(), z.unknown()).optional().describe("New type-specific JSON data"),
    },
    async (args) => {
      const db = getDb();

      // Fetch current state
      const current = await db.execute({
        sql: "SELECT * FROM nodes WHERE id = ?",
        args: [args.node_id],
      });

      if (current.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: node not found" }],
          isError: true,
        };
      }

      const row = NodeRow.parse(current.rows[0]);

      // Build dynamic SET clause for provided fields only
      const updates: string[] = [];
      const values: InValue[] = [];
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      if (args.name !== undefined) {
        updates.push("name = ?");
        values.push(args.name);
        changes.name = { from: row.name, to: args.name };
      }
      if (args.description !== undefined) {
        updates.push("description = ?");
        values.push(args.description);
        changes.description = { from: row.description, to: args.description };
      }
      if (args.status !== undefined) {
        updates.push("status = ?");
        values.push(args.status);
        changes.status = { from: row.status, to: args.status };
      }
      if (args.meta !== undefined) {
        updates.push("meta = ?");
        values.push(JSON.stringify(args.meta));
        changes.meta = {
          from: row.meta ? JSON.parse(row.meta) : null,
          to: args.meta,
        };
      }

      if (updates.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: no fields to update" }],
          isError: true,
        };
      }

      updates.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(args.node_id);

      await db.execute({
        sql: `UPDATE nodes SET ${updates.join(", ")} WHERE id = ?`,
        args: values,
      });

      await logAudit(SOLO_USER, "update_node", "node", args.node_id, { changes });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id: args.node_id, updated: Object.keys(changes) }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_list_nodes",
    "List nodes from the Portuni knowledge graph, optionally filtered by type and/or status.",
    {
      type: z.string().optional().describe("Filter by node type"),
      status: z.enum(["active", "completed", "archived"]).optional().describe("Filter by status"),
    },
    async (args) => {
      const db = getDb();

      const conditions: string[] = [];
      const values: InValue[] = [];

      if (args.type !== undefined) {
        conditions.push("type = ?");
        values.push(args.type);
      }
      if (args.status !== undefined) {
        conditions.push("status = ?");
        values.push(args.status);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const result = await db.execute({
        sql: `SELECT id, type, name, status, description FROM nodes ${where} ORDER BY created_at DESC`,
        args: values,
      });

      const nodes = result.rows.map((row) => NodeSummaryRow.parse(row));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(nodes, null, 2),
          },
        ],
      };
    },
  );
}
