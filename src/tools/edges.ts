import { z } from "zod";
import { ulid } from "ulid";
import { getDb } from "../db.js";
import { logAudit } from "../audit.js";
import { EDGE_RELATIONS, SOLO_USER } from "../schema.js";
import { NodeIdRow } from "../types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerEdgeTools(server: McpServer): void {
  server.tool(
    "portuni_connect",
    "Create a directed edge between two nodes. Relation types (strictly enforced): related_to (near-default, lateral connection), belongs_to (scope, EXACTLY ONE per non-organization node), applies (concrete work uses a pattern, e.g. project applies process), informed_by (knowledge transfer). Every non-organization node must belong to exactly one organization -- belongs_to is single-parent and strictly enforced.",
    {
      source_id: z.string().describe("Source node ID (ULID)"),
      target_id: z.string().describe("Target node ID (ULID)"),
      relation: z.enum(EDGE_RELATIONS).describe("Relation type: related_to, belongs_to, applies, or informed_by"),
      meta: z.record(z.string(), z.unknown()).optional().describe("Optional metadata for the edge"),
    },
    async (args) => {
      const db = getDb();

      // Verify both nodes exist -- fetch type at the same time so we can
      // enforce the belongs_to -> organization invariant with clear error
      // messages instead of raw trigger abort.
      const sourceCheck = await db.execute({
        sql: "SELECT id, type FROM nodes WHERE id = ?",
        args: [args.source_id],
      });
      if (sourceCheck.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: source node ${args.source_id} not found` }],
          isError: true,
        };
      }
      const sourceType = sourceCheck.rows[0].type as string;

      const targetCheck = await db.execute({
        sql: "SELECT id, type FROM nodes WHERE id = ?",
        args: [args.target_id],
      });
      if (targetCheck.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: target node ${args.target_id} not found` }],
          isError: true,
        };
      }
      const targetType = targetCheck.rows[0].type as string;

      // Organization invariant: a non-org source can only have a single
      // belongs_to -> organization edge. Reject a second one at the tool
      // layer with a clear error (the DB trigger would catch this anyway,
      // but the trigger's message is less actionable).
      if (args.relation === "belongs_to" && targetType === "organization" && sourceType !== "organization") {
        const existing = await db.execute({
          sql: `SELECT e.id, e.target_id, n.name as target_name
                  FROM edges e
                  JOIN nodes n ON n.id = e.target_id
                 WHERE e.source_id = ?
                   AND e.relation = 'belongs_to'
                   AND n.type = 'organization'`,
          args: [args.source_id],
        });
        if (existing.rows.length > 0) {
          const existingOrgName = existing.rows[0].target_name as string;
          const existingOrgId = existing.rows[0].target_id as string;
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: node ${args.source_id} already belongs to organization "${existingOrgName}" (${existingOrgId}). Every non-organization node belongs to exactly one organization -- disconnect the existing belongs_to edge first, or move the node by calling portuni_disconnect followed by a new portuni_connect in a single agent turn.`,
              },
            ],
            isError: true,
          };
        }
      }

      // Self-loop prevention
      if (args.source_id === args.target_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: cannot create edge from a node to itself (${args.source_id}). Self-loops are not allowed.`,
            },
          ],
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
    "Remove an edge between two nodes. If relation is omitted, removes all edges between the two nodes. Cannot remove the last belongs_to -> organization edge of a non-organization node -- that would orphan the node. To move a node to a different organization, disconnect and reconnect to the new organization in a single agent turn.",
    {
      source_id: z.string().describe("Source node ID (ULID)"),
      target_id: z.string().describe("Target node ID (ULID)"),
      relation: z.enum(EDGE_RELATIONS).optional().describe("Relation type to remove (omit to remove all edges between the nodes)"),
    },
    async (args) => {
      const db = getDb();

      // Organization invariant: refuse to remove the last belongs_to ->
      // organization edge of a non-organization node. The DB trigger
      // catches this as a safety net, but returning a clean tool error is
      // more actionable than an "ABORT" bubbled up from SQLite.
      const removingBelongsToOrg =
        args.relation === undefined || args.relation === "belongs_to";
      if (removingBelongsToOrg) {
        const sourceType = await db.execute({
          sql: "SELECT type FROM nodes WHERE id = ?",
          args: [args.source_id],
        });
        const targetType = await db.execute({
          sql: "SELECT type FROM nodes WHERE id = ?",
          args: [args.target_id],
        });
        const srcIsNonOrg =
          sourceType.rows.length > 0 && sourceType.rows[0].type !== "organization";
        const tgtIsOrg =
          targetType.rows.length > 0 && targetType.rows[0].type === "organization";
        if (srcIsNonOrg && tgtIsOrg) {
          const orgCount = await db.execute({
            sql: `SELECT COUNT(*) as n FROM edges e
                    JOIN nodes t ON t.id = e.target_id
                   WHERE e.source_id = ?
                     AND e.relation = 'belongs_to'
                     AND t.type = 'organization'`,
            args: [args.source_id],
          });
          const n = Number(orgCount.rows[0].n);
          if (n <= 1) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: cannot remove the only belongs_to -> organization edge of node ${args.source_id}. Every non-organization node must belong to exactly one organization. To move this node to a different organization, use portuni_move_node (when available) or disconnect and immediately reconnect to the new organization in the same agent turn so the invariant is not observably violated.`,
                },
              ],
              isError: true,
            };
          }
        }
      }

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
