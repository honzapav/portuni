// Domain: actor registry (person / automation).
//
// Pure functions over a libsql Client. No MCP / HTTP coupling. Both the
// MCP tool layer (src/mcp/tools/actors.ts) and the REST layer
// (src/api/actors.ts) call into these.

import { z } from "zod";
import { ulid } from "ulid";
import type { Client, InValue } from "@libsql/client";
import { ActorRow } from "../shared/types.js";
import { writeAudit } from "../infra/audit.js";

export const ACTOR_TYPES = ["person", "automation"] as const;

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

async function loadActor(db: Client, actorId: string): Promise<ActorRow | null> {
  const res = await db.execute({
    sql: "SELECT * FROM actors WHERE id = ?",
    args: [actorId],
  });
  if (res.rows.length === 0) return null;
  return ActorRow.parse(res.rows[0]);
}

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
