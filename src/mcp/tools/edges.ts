// MCP tool registrations for edges. Thin wrappers; mutation logic lives
// in src/domain/edges.ts.

import { z } from "zod";
import { ulid } from "ulid";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../infra/db.js";
import { logAudit } from "../../infra/audit.js";
import { EDGE_RELATIONS, SOLO_USER } from "../../infra/schema.js";
import { moveNodeToOrganization } from "../../domain/edges.js";

export function registerEdgeTools(server: McpServer): void {
  server.tool(
    "portuni_connect",
    "Create a directed edge between two nodes. ONLY create edges when the user explicitly asks or when creating a node that requires a belongs_to edge. Never speculatively connect nodes because they seem related. Relations (strictly enforced): related_to (near-default lateral connection), belongs_to (scope; EXACTLY ONE per non-organization node), applies (concrete work uses a pattern, e.g. project applies process), informed_by (knowledge transfer). To move a node between organizations, prefer portuni_move_node -- it rebinds the existing belongs_to atomically. Do NOT disconnect-then-connect across organizations: the disconnect of the only belongs_to is rejected to preserve the invariant. See portuni://architecture.",
    {
      source_id: z.string().describe("Source node ID (ULID)"),
      target_id: z.string().describe("Target node ID (ULID)"),
      relation: z.enum(EDGE_RELATIONS).describe("Relation type: related_to, belongs_to, applies, or informed_by"),
      meta: z.record(z.string(), z.unknown()).optional().describe("Optional metadata for the edge"),
    },
    async (args) => {
      const db = getDb();

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
    "Remove an edge between two nodes. If relation is omitted, removes all edges between the two nodes. Cannot remove the last belongs_to -> organization edge of a non-organization node -- that would orphan the node. To move a node to a different organization, call portuni_move_node({ node_id, new_org_id }) instead: it rebinds the existing belongs_to atomically (single agent turn, single audit row, no transient invariant break). See portuni://architecture.",
    {
      source_id: z.string().describe("Source node ID (ULID)"),
      target_id: z.string().describe("Target node ID (ULID)"),
      relation: z.enum(EDGE_RELATIONS).optional().describe("Relation type to remove (omit to remove all edges between the nodes)"),
    },
    async (args) => {
      const db = getDb();

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
                  text: `Error: cannot remove the only belongs_to -> organization edge of node ${args.source_id}. Every non-organization node must belong to exactly one organization. To move this node to a different organization, call portuni_move_node({ node_id, new_org_id }) -- it rebinds the existing edge atomically and keeps audit history continuous.`,
                },
              ],
              isError: true,
            };
          }
        }
      }

      let result: Awaited<ReturnType<typeof db.execute>>;
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

  server.tool(
    "portuni_move_node",
    "Move a non-organization node from its current organization to another. Rebinds the existing belongs_to edge atomically -- the org-invariant triggers fire on INSERT/DELETE only, so an UPDATE preserves the 'exactly one belongs_to -> organization' invariant by construction. The edge id stays stable so audit history attached to the membership is continuous. Use this instead of disconnect+connect when relocating a node between organizations.",
    {
      node_id: z.string().describe("Node ID (ULID) to move. Must be non-organization."),
      new_org_id: z.string().describe("Target organization ID (ULID). Must be type 'organization'."),
    },
    async (args) => {
      try {
        const result = await moveNodeToOrganization(
          getDb(),
          SOLO_USER,
          args.node_id,
          args.new_org_id,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
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
