// MCP tool registrations for responsibilities. Logic lives in
// src/domain/responsibilities.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@libsql/client";
import { getDb } from "../../infra/db.js";
import {
  assignResponsibility,
  createResponsibility,
  deleteResponsibility,
  listResponsibilities,
  unassignResponsibility,
  updateResponsibility,
} from "../../domain/responsibilities.js";
import { nodeVisibleTo } from "../../auth/node-access.js";
import type { SessionCtx } from "../server.js";

async function guardNodeAccess(
  db: Client,
  nodeId: string,
  identity: SessionCtx["identity"],
): Promise<{ allowed: true } | { allowed: false; error: string }> {
  if (!(await nodeVisibleTo(db, identity, nodeId))) {
    return { allowed: false, error: `Error: node ${nodeId} not found` };
  }
  return { allowed: true };
}

async function loadResponsibilityNodeId(
  db: Client,
  responsibilityId: string,
): Promise<string | null> {
  const res = await db.execute({
    sql: "SELECT node_id FROM responsibilities WHERE id = ?",
    args: [responsibilityId],
  });
  if (res.rows.length === 0) return null;
  return String(res.rows[0].node_id);
}

export function registerResponsibilityTools(server: McpServer, ctx: SessionCtx): void {
  server.tool(
    "portuni_create_responsibility",
    "Create a responsibility on a project/process/area node. Responsibilities are concrete duties ('Review kódu', 'Ops on-call') attached to entities; they are not nodes themselves. Optionally pass a list of actor IDs to assign immediately. Create only when the user explicitly asks.",
    {
      node_id: z.string().describe("Node ID (ULID). Must be a project/process/area."),
      title: z.string().describe("Short title."),
      description: z.string().optional().describe("Optional detail."),
      sort_order: z.number().int().optional().describe("Display order within the node. Default 0."),
      assignees: z.array(z.string()).optional().describe("Optional actor IDs to assign on creation."),
    },
    async (args) => {
      try {
        const db = getDb();
        const guard = await guardNodeAccess(db, args.node_id, ctx.identity);
        if (!guard.allowed) {
          return {
            content: [{ type: "text" as const, text: guard.error }],
            isError: true,
          };
        }
        const row = await createResponsibility(db, ctx.identity.userId, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(row) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "portuni_update_responsibility",
    "Update fields on an existing responsibility. Only provided fields change. Does not touch assignments — use portuni_assign_responsibility / portuni_unassign_responsibility for that.",
    {
      responsibility_id: z.string().describe("Responsibility ID (ULID)."),
      title: z.string().optional().describe("New title."),
      description: z.union([z.string(), z.null()]).optional().describe("New description. Pass null to clear."),
      sort_order: z.number().int().optional().describe("New sort order."),
    },
    async (args) => {
      try {
        const db = getDb();
        const nodeId = await loadResponsibilityNodeId(db, args.responsibility_id);
        if (!nodeId) {
          return {
            content: [{ type: "text" as const, text: `Error: ${args.responsibility_id} not found` }],
            isError: true,
          };
        }
        const guard = await guardNodeAccess(db, nodeId, ctx.identity);
        if (!guard.allowed) {
          return {
            content: [{ type: "text" as const, text: guard.error }],
            isError: true,
          };
        }
        const row = await updateResponsibility(db, ctx.identity.userId, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(row) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "portuni_delete_responsibility",
    "Hard-delete a responsibility — removes the row and cascade-deletes its actor assignments. Use only when the user explicitly asks.",
    {
      responsibility_id: z.string().describe("Responsibility ID (ULID) to delete."),
    },
    async (args) => {
      try {
        const db = getDb();
        const nodeId = await loadResponsibilityNodeId(db, args.responsibility_id);
        if (!nodeId) {
          return {
            content: [{ type: "text" as const, text: `Error: ${args.responsibility_id} not found` }],
            isError: true,
          };
        }
        const guard = await guardNodeAccess(db, nodeId, ctx.identity);
        if (!guard.allowed) {
          return {
            content: [{ type: "text" as const, text: guard.error }],
            isError: true,
          };
        }
        await deleteResponsibility(db, ctx.identity.userId, args.responsibility_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ id: args.responsibility_id, action: "deleted" }) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "portuni_list_responsibilities",
    "List responsibilities, optionally filtered by node (all responsibilities on that entity) or actor (all responsibilities assigned to that actor) or both. Each row includes its assignees (array of actor rows).",
    {
      node_id: z.string().optional().describe("Filter: only responsibilities on this node."),
      actor_id: z.string().optional().describe("Filter: only responsibilities assigned to this actor."),
    },
    async (args) => {
      try {
        const rows = await listResponsibilities(getDb(), args);
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "portuni_assign_responsibility",
    "Assign an actor to a responsibility. Idempotent: assigning the same pair twice is a no-op, not an error.",
    {
      responsibility_id: z.string().describe("Responsibility ID (ULID)."),
      actor_id: z.string().describe("Actor ID (ULID) to assign."),
    },
    async (args) => {
      try {
        const db = getDb();
        const nodeId = await loadResponsibilityNodeId(db, args.responsibility_id);
        if (!nodeId) {
          return {
            content: [{ type: "text" as const, text: `Error: ${args.responsibility_id} not found` }],
            isError: true,
          };
        }
        const guard = await guardNodeAccess(db, nodeId, ctx.identity);
        if (!guard.allowed) {
          return {
            content: [{ type: "text" as const, text: guard.error }],
            isError: true,
          };
        }
        await assignResponsibility(db, ctx.identity.userId, args);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                responsibility_id: args.responsibility_id,
                actor_id: args.actor_id,
                action: "assigned",
              }),
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

  server.tool(
    "portuni_unassign_responsibility",
    "Remove an actor's assignment to a responsibility. No-op if the pair is not currently assigned.",
    {
      responsibility_id: z.string().describe("Responsibility ID (ULID)."),
      actor_id: z.string().describe("Actor ID (ULID) to unassign."),
    },
    async (args) => {
      try {
        const db = getDb();
        const nodeId = await loadResponsibilityNodeId(db, args.responsibility_id);
        if (!nodeId) {
          return {
            content: [{ type: "text" as const, text: `Error: ${args.responsibility_id} not found` }],
            isError: true,
          };
        }
        const guard = await guardNodeAccess(db, nodeId, ctx.identity);
        if (!guard.allowed) {
          return {
            content: [{ type: "text" as const, text: guard.error }],
            isError: true,
          };
        }
        await unassignResponsibility(db, ctx.identity.userId, args);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                responsibility_id: args.responsibility_id,
                actor_id: args.actor_id,
                action: "unassigned",
              }),
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
