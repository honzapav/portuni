// MCP tool registrations for actors. Thin wrappers over src/domain/actors.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../infra/db.js";
import { SOLO_USER } from "../../infra/schema.js";
import {
  ACTOR_TYPES,
  archiveActor,
  createActor,
  getActor,
  getActorAssignments,
  listActors,
  updateActor,
} from "../../domain/actors.js";

export function registerActorTools(server: McpServer): void {
  server.tool(
    "portuni_create_actor",
    "Create an actor (person or automation) in the global actor registry. Actors are cross-organizational -- a single person can be assigned to responsibilities or own nodes across any number of organizations. ONLY create when the user explicitly asks -- do not spawn actors as a side effect of other work. Person: a human collaborator; can be a real person (link via user_id) or a placeholder role (is_placeholder=true) such as 'need a lawyer' before anyone is hired. Automation: a script, bot, or integration; must NOT be a placeholder and must NOT have user_id.",
    {
      type: z.enum(ACTOR_TYPES).describe("person or automation."),
      name: z.string().describe("Display name."),
      is_placeholder: z.boolean().optional().describe("Person-only. True for a role sketch without a real human. Must be false for automations."),
      user_id: z.string().optional().describe("Person-only. Link to users.id."),
      notes: z.string().optional().describe("Optional internal notes. NOT a role description."),
      external_id: z.string().optional().describe("Optional external system id (globally unique when set)."),
    },
    async (args) => {
      try {
        const row = await createActor(getDb(), SOLO_USER, args);
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
    "portuni_update_actor",
    "Update an existing actor. Only provided fields change. The same automation constraints apply (automations cannot be placeholders or have a user_id).",
    {
      actor_id: z.string().describe("Actor ID (ULID)."),
      name: z.string().optional().describe("New display name."),
      is_placeholder: z.boolean().optional().describe("Person-only. Flip between real person and placeholder role."),
      user_id: z.union([z.string(), z.null()]).optional().describe("Person-only. Link or unlink a users.id row."),
      notes: z.union([z.string(), z.null()]).optional().describe("New internal notes. Pass null to clear."),
      external_id: z.string().optional().describe("New external id."),
    },
    async (args) => {
      try {
        const row = await updateActor(getDb(), SOLO_USER, args);
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
    "portuni_list_actors",
    "List all actors in the global registry, optionally filtered by type or placeholder flag. Actors are cross-organizational, so this returns the full registry regardless of which organization you're working in. Use this to find who exists before creating responsibility assignments.",
    {
      type: z.enum(ACTOR_TYPES).optional().describe("Filter by actor type."),
      is_placeholder: z.boolean().optional().describe("Filter by placeholder flag."),
    },
    async (args) => {
      try {
        const rows = await listActors(getDb(), args);
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
    "portuni_get_actor",
    "Get a single actor with all their responsibility assignments. Returns { actor, assignments: [{ id, title, node_id, node_name, node_type }] } so the LLM can see at a glance what this actor is on the hook for.",
    {
      actor_id: z.string().describe("Actor ID (ULID)."),
    },
    async (args) => {
      try {
        const db = getDb();
        const actor = await getActor(db, args.actor_id);
        if (!actor) {
          return {
            content: [{ type: "text" as const, text: `Error: actor ${args.actor_id} not found` }],
            isError: true,
          };
        }
        const assignments = await getActorAssignments(db, args.actor_id);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ actor, assignments }, null, 2) },
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
    "portuni_archive_actor",
    "Hard-delete an actor. This is IRREVERSIBLE: the row is physically removed and all responsibility assignments cascade. Any node.owner_id referencing this actor becomes NULL. Use only when the user explicitly asks to remove an actor.",
    {
      actor_id: z.string().describe("Actor ID (ULID) to delete."),
    },
    async (args) => {
      try {
        await archiveActor(getDb(), SOLO_USER, args.actor_id);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ id: args.actor_id, action: "archived" }) },
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
