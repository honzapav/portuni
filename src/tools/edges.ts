import { z } from "zod";
import { ulid } from "ulid";
import { getDb } from "../db.js";
import { logAudit } from "../audit.js";
import { SOLO_USER } from "../schema.js";
import { NodeIdRow } from "../types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerEdgeTools(server: McpServer): void {
  server.tool(
    "portuni_connect",
    "Create a directed edge between two nodes. Relation types: instance_of, applies, belongs_to, guided_by, depends_on, related_to, informed_by (not enforced).",
    {
      source_id: z.string().describe("Source node ID (ULID)"),
      target_id: z.string().describe("Target node ID (ULID)"),
      relation: z.string().describe("Relation type (e.g. instance_of, applies, belongs_to, guided_by, depends_on, related_to, informed_by)"),
      meta: z.record(z.string(), z.unknown()).optional().describe("Optional metadata for the edge"),
    },
    async (args) => {
      const db = getDb();

      // Verify both nodes exist
      const sourceCheck = await db.execute({
        sql: "SELECT id FROM nodes WHERE id = ?",
        args: [args.source_id],
      });
      if (sourceCheck.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: source node ${args.source_id} not found` }],
          isError: true,
        };
      }

      const targetCheck = await db.execute({
        sql: "SELECT id FROM nodes WHERE id = ?",
        args: [args.target_id],
      });
      if (targetCheck.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: target node ${args.target_id} not found` }],
          isError: true,
        };
      }

      // Check for duplicate edge
      const dupeCheck = await db.execute({
        sql: "SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?",
        args: [args.source_id, args.target_id, args.relation],
      });
      if (dupeCheck.rows.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ id: dupeCheck.rows[0].id, message: "Edge already exists" }),
            },
          ],
        };
      }

      // Insert new edge
      const id = ulid();
      const now = new Date().toISOString();

      await db.execute({
        sql: `INSERT INTO edges (id, source_id, target_id, relation, meta, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          args.source_id,
          args.target_id,
          args.relation,
          args.meta ? JSON.stringify(args.meta) : null,
          SOLO_USER,
          now,
        ],
      });

      await logAudit(SOLO_USER, "connect", "edge", id, {
        source_id: args.source_id,
        target_id: args.target_id,
        relation: args.relation,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id,
              source_id: args.source_id,
              target_id: args.target_id,
              relation: args.relation,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_disconnect",
    "Remove an edge between two nodes. If relation is omitted, removes all edges between the two nodes.",
    {
      source_id: z.string().describe("Source node ID (ULID)"),
      target_id: z.string().describe("Target node ID (ULID)"),
      relation: z.string().optional().describe("Relation type to remove (omit to remove all edges between the nodes)"),
    },
    async (args) => {
      const db = getDb();

      let result;
      if (args.relation !== undefined) {
        result = await db.execute({
          sql: "DELETE FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?",
          args: [args.source_id, args.target_id, args.relation],
        });
      } else {
        result = await db.execute({
          sql: "DELETE FROM edges WHERE source_id = ? AND target_id = ?",
          args: [args.source_id, args.target_id],
        });
      }

      await logAudit(SOLO_USER, "disconnect", "edge", `${args.source_id}->${args.target_id}`, {
        source_id: args.source_id,
        target_id: args.target_id,
        relation: args.relation ?? "all",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ disconnected: result.rowsAffected }),
          },
        ],
      };
    },
  );
}
