// src/tools/actors.ts
// Task B1: MCP tools for the actors registry (person / automation).
//
// Exports pure functions (createActor, listActors, getActor, updateActor,
// archiveActor) that take an explicit libsql Client so tests can drive them
// against an in-memory DB, plus registerActorTools() which wires them up as
// MCP tool handlers using getDb() from the shared connection.

import { z } from "zod";
import { ulid } from "ulid";
import type { Client, InValue } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db.js";
import { SOLO_USER } from "../schema.js";
import { ActorRow } from "../types.js";

// --- Zod input schemas (also used for MCP tool shapes) ---

const ACTOR_TYPES = ["person", "automation"] as const;

const CreateActorInput = z.object({
  type: z.enum(ACTOR_TYPES).describe("Actor type: person (human) or automation (script, bot, integration)."),
  name: z.string().describe("Display name."),
  is_placeholder: z.boolean().optional().describe("Person-only. True means a role sketch without a real human yet (e.g. 'need a lawyer'). Must be false for automations."),
  user_id: z.string().optional().describe("Person-only. Links the actor to a users.id row. Must be null for automations."),
  notes: z.string().optional().describe("Optional internal notes. NOT a role description -- what an actor does is expressed by responsibilities on specific nodes."),
  external_id: z.string().optional().describe("Optional external system id (globally unique when set)."),
});
type CreateActorInput = z.infer<typeof CreateActorInput>;

const UpdateActorInput = z.object({
  actor_id: z.string().describe("Actor ID (ULID) to update."),
  name: z.string().optional().describe("New display name."),
  is_placeholder: z.boolean().optional().describe("Person-only. Flip between real person and placeholder role."),
  user_id: z.union([z.string(), z.null()]).optional().describe("Person-only. Link/unlink a users.id row."),
  notes: z.union([z.string(), z.null()]).optional().describe("New internal notes. Pass null to clear."),
  external_id: z.string().optional().describe("New external id."),
});
type UpdateActorInput = z.infer<typeof UpdateActorInput>;

const ListActorsInput = z.object({
  type: z.enum(ACTOR_TYPES).optional().describe("Filter by actor type."),
  is_placeholder: z.boolean().optional().describe("Filter by placeholder flag."),
});
type ListActorsInput = z.infer<typeof ListActorsInput>;

// --- Internal helpers ---

// Direct audit writer. The shared logAudit() helper hard-codes getDb(), so we
// re-implement the INSERT here to keep the pure functions pure (tests pass a
// fresh in-memory Client).
async function writeAudit(
  db: Client,
  userId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [ulid(), userId, action, targetType, targetId, detail ? JSON.stringify(detail) : null],
  });
}

async function loadActor(db: Client, actorId: string): Promise<ActorRow | null> {
  const res = await db.execute({
    sql: "SELECT * FROM actors WHERE id = ?",
    args: [actorId],
  });
  if (res.rows.length === 0) return null;
  return ActorRow.parse(res.rows[0]);
}

// --- Pure functions (DB-driven, no MCP server coupling) ---

export async function createActor(
  db: Client,
  createdBy: string,
  input: CreateActorInput,
): Promise<ActorRow> {
  const parsed = CreateActorInput.parse(input);

  // Friendlier pre-DB validation for the automation constraints. The
  // actors table CHECK still enforces these, but raising here gives a clear
  // message rather than a raw SQLite CHECK-failed error.
  if (parsed.type === "automation") {
    if (parsed.is_placeholder === true) {
      throw new Error("automation actors cannot be placeholders (is_placeholder must be false)");
    }
    if (parsed.user_id !== undefined && parsed.user_id !== null) {
      throw new Error("automation actors cannot have a user_id");
    }
  }

  const id = ulid();
  const now = new Date().toISOString();
  const isPlaceholder = parsed.is_placeholder ? 1 : 0;

  await db.execute({
    sql: `INSERT INTO actors (id, type, name, is_placeholder, user_id, notes, external_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      parsed.type,
      parsed.name,
      isPlaceholder,
      parsed.user_id ?? null,
      parsed.notes ?? null,
      parsed.external_id ?? null,
      now,
      now,
    ],
  });

  await writeAudit(db, createdBy, "create_actor", "actor", id, {
    type: parsed.type,
    name: parsed.name,
  });

  const row = await loadActor(db, id);
  if (!row) throw new Error(`createActor: inserted row ${id} not found`);
  return row;
}

export async function updateActor(
  db: Client,
  updatedBy: string,
  input: UpdateActorInput,
): Promise<ActorRow> {
  const parsed = UpdateActorInput.parse(input);

  const existing = await loadActor(db, parsed.actor_id);
  if (!existing) throw new Error(`updateActor: actor ${parsed.actor_id} not found`);

  // Merge requested changes with current state for the automation-constraint
  // check so we catch attempts to toggle a person into an automation while
  // leaving placeholder/user_id set.
  const effectiveType = existing.type;
  const effectivePlaceholder =
    parsed.is_placeholder !== undefined ? parsed.is_placeholder : existing.is_placeholder === 1;
  const effectiveUserId =
    parsed.user_id !== undefined ? parsed.user_id : existing.user_id;

  if (effectiveType === "automation") {
    if (effectivePlaceholder) {
      throw new Error("automation actors cannot be placeholders (is_placeholder must be false)");
    }
    if (effectiveUserId !== null && effectiveUserId !== undefined) {
      throw new Error("automation actors cannot have a user_id");
    }
  }

  const updates: string[] = [];
  const values: InValue[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (parsed.name !== undefined) {
    updates.push("name = ?");
    values.push(parsed.name);
    changes.name = { from: existing.name, to: parsed.name };
  }
  if (parsed.is_placeholder !== undefined) {
    updates.push("is_placeholder = ?");
    values.push(parsed.is_placeholder ? 1 : 0);
    changes.is_placeholder = { from: existing.is_placeholder, to: parsed.is_placeholder ? 1 : 0 };
  }
  if (parsed.user_id !== undefined) {
    updates.push("user_id = ?");
    values.push(parsed.user_id);
    changes.user_id = { from: existing.user_id, to: parsed.user_id };
  }
  if (parsed.notes !== undefined) {
    updates.push("notes = ?");
    values.push(parsed.notes);
    changes.notes = { from: existing.notes, to: parsed.notes };
  }
  if (parsed.external_id !== undefined) {
    updates.push("external_id = ?");
    values.push(parsed.external_id);
    changes.external_id = { from: existing.external_id, to: parsed.external_id };
  }

  if (updates.length === 0) {
    // Nothing to change; return current row.
    return existing;
  }

  updates.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(parsed.actor_id);

  await db.execute({
    sql: `UPDATE actors SET ${updates.join(", ")} WHERE id = ?`,
    args: values,
  });

  await writeAudit(db, updatedBy, "update_actor", "actor", parsed.actor_id, { changes });

  const row = await loadActor(db, parsed.actor_id);
  if (!row) throw new Error(`updateActor: row ${parsed.actor_id} disappeared after UPDATE`);
  return row;
}

export async function listActors(
  db: Client,
  filters: ListActorsInput = {},
): Promise<ActorRow[]> {
  const parsed = ListActorsInput.parse(filters);
  const conditions: string[] = [];
  const values: InValue[] = [];

  if (parsed.type !== undefined) {
    conditions.push("type = ?");
    values.push(parsed.type);
  }
  if (parsed.is_placeholder !== undefined) {
    conditions.push("is_placeholder = ?");
    values.push(parsed.is_placeholder ? 1 : 0);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const res = await db.execute({
    sql: `SELECT * FROM actors ${where} ORDER BY name`,
    args: values,
  });
  return res.rows.map((r) => ActorRow.parse(r));
}

export async function getActor(db: Client, actorId: string): Promise<ActorRow | null> {
  return loadActor(db, actorId);
}

// Loads responsibility assignments for an actor, with the parent
// responsibility and its owning node. Returned shape is deliberately flat so
// the MCP response is easy for the LLM to scan.
export async function getActorAssignments(
  db: Client,
  actorId: string,
): Promise<Array<{ id: string; title: string; node_id: string; node_name: string; node_type: string }>> {
  const res = await db.execute({
    sql: `SELECT r.id AS id, r.title AS title, r.node_id AS node_id,
                 n.name AS node_name, n.type AS node_type
            FROM responsibility_assignments ra
            JOIN responsibilities r ON r.id = ra.responsibility_id
            JOIN nodes n           ON n.id = r.node_id
           WHERE ra.actor_id = ?
           ORDER BY n.name, r.sort_order, r.title`,
    args: [actorId],
  });
  return res.rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    node_id: row.node_id as string,
    node_name: row.node_name as string,
    node_type: row.node_type as string,
  }));
}

export async function archiveActor(
  db: Client,
  archivedBy: string,
  actorId: string,
): Promise<void> {
  const existing = await loadActor(db, actorId);
  if (!existing) throw new Error(`archiveActor: actor ${actorId} not found`);

  // Hard delete. ON DELETE CASCADE on responsibility_assignments handles
  // the join table; nodes.owner_id becomes NULL via ON DELETE SET NULL.
  await db.execute({
    sql: "DELETE FROM actors WHERE id = ?",
    args: [actorId],
  });

  await writeAudit(db, archivedBy, "archive_actor", "actor", actorId, {
    type: existing.type,
    name: existing.name,
  });
}

// --- MCP tool registration ---

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
        const db = getDb();
        const row = await createActor(db, SOLO_USER, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(row) }],
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
        const db = getDb();
        const row = await updateActor(db, SOLO_USER, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(row) }],
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
    "portuni_list_actors",
    "List all actors in the global registry, optionally filtered by type or placeholder flag. Actors are cross-organizational, so this returns the full registry regardless of which organization you're working in. Use this to find who exists before creating responsibility assignments.",
    {
      type: z.enum(ACTOR_TYPES).optional().describe("Filter by actor type."),
      is_placeholder: z.boolean().optional().describe("Filter by placeholder flag."),
    },
    async (args) => {
      try {
        const db = getDb();
        const rows = await listActors(db, args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
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
            {
              type: "text" as const,
              text: JSON.stringify({ actor, assignments }, null, 2),
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
    "portuni_archive_actor",
    "Hard-delete an actor. This is IRREVERSIBLE: the row is physically removed and all responsibility assignments cascade. Any node.owner_id referencing this actor becomes NULL. Use only when the user explicitly asks to remove an actor.",
    {
      actor_id: z.string().describe("Actor ID (ULID) to delete."),
    },
    async (args) => {
      try {
        const db = getDb();
        await archiveActor(db, SOLO_USER, args.actor_id);
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
