// MCP tool registrations for responsibilities. Logic lives in
// src/domain/responsibilities.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../infra/db.js";
import { SOLO_USER } from "../../infra/schema.js";
import {
  assignResponsibility,
  createResponsibility,
  deleteResponsibility,
  listResponsibilities,
  unassignResponsibility,
  updateResponsibility,
} from "../../domain/responsibilities.js";

export function registerResponsibilityTools(server: McpServer): void {
  server.tool(
    "portuni_create_responsibility",
    "Create a responsibility on a project/process/area node. Responsibilities are concrete duties ('Review kódu', 'Ops on-call') attached to entities; they are not nodes themselves. Optionally pass a list of actor IDs to assign immediately. ONLY create when the user explicitly asks.",
    {
      node_id: z.string().describe("Node ID (ULID). Must be a project/process/area."),
      title: z.string().describe("Short title."),
      description: z.string().optional().describe("Optional detail."),
      sort_order: z.number().int().optional().describe("Display order within the node. Default 0."),
      assignees: z.array(z.string()).optional().describe("Optional actor IDs to assign on creation."),
    },
    async (args) => {
      try {
        const row = await createResponsibility(getDb(), SOLO_USER, args);
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
        const row = await updateResponsibility(getDb(), SOLO_USER, args);
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
    "Hard-delete a responsibility. IRREVERSIBLE: removes the row and cascades to all of its actor assignments. Use only when the user explicitly asks.",
    {
      responsibility_id: z.string().describe("Responsibility ID (ULID) to delete."),
    },
    async (args) => {
      try {
        await deleteResponsibility(getDb(), SOLO_USER, args.responsibility_id);
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
        await assignResponsibility(getDb(), SOLO_USER, args);
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
        await unassignResponsibility(getDb(), SOLO_USER, args);
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
