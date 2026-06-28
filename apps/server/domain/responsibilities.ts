// Domain: responsibilities and their M:N assignments to actors.
//
// Pure functions over a libsql Client. No MCP / HTTP coupling.

import { z } from "zod";
import { ulid } from "ulid";
import type { Client, InValue } from "@libsql/client";
import { ActorRow, ResponsibilityRow } from "../shared/types.js";
import { writeAudit } from "../infra/audit.js";

export type ResponsibilityWithAssignees = ResponsibilityRow & {
  assignees: ActorRow[];
};

const CreateResponsibilityInput = z.object({
  node_id: z.string().describe("Node ID (ULID) to attach the responsibility to. Must be a project/process/area node."),
  title: z.string().describe("Short title of the responsibility."),
  description: z.string().optional().describe("Optional detail."),
  sort_order: z.number().int().optional().describe("Display order within the node. Defaults to 0."),
  assignees: z.array(z.string()).optional().describe("Optional list of actor IDs to assign immediately."),
});
type CreateResponsibilityInput = z.infer<typeof CreateResponsibilityInput>;

const UpdateResponsibilityInput = z.object({
  responsibility_id: z.string().describe("Responsibility ID (ULID) to update."),
  title: z.string().optional().describe("New title."),
  description: z.union([z.string(), z.null()]).optional().describe("New description. Pass null to clear."),
  sort_order: z.number().int().optional().describe("New sort order."),
});
type UpdateResponsibilityInput = z.infer<typeof UpdateResponsibilityInput>;

const ListResponsibilitiesInput = z.object({
  node_id: z.string().optional().describe("Filter: only responsibilities on this node."),
  actor_id: z.string().optional().describe("Filter: only responsibilities assigned to this actor."),
});
type ListResponsibilitiesInput = z.infer<typeof ListResponsibilitiesInput>;

const AssignInput = z.object({
  responsibility_id: z.string().describe("Responsibility ID (ULID)."),
  actor_id: z.string().describe("Actor ID (ULID) to assign / unassign."),
});
type AssignInput = z.infer<typeof AssignInput>;

async function loadResponsibility(db: Client, id: string): Promise<ResponsibilityRow | null> {
  const res = await db.execute({
    sql: "SELECT * FROM responsibilities WHERE id = ?",
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return ResponsibilityRow.parse(res.rows[0]);
}

async function loadAssignees(db: Client, responsibilityId: string): Promise<ActorRow[]> {
  const res = await db.execute({
    sql: `SELECT a.* FROM actors a
            JOIN responsibility_assignments ra ON ra.actor_id = a.id
           WHERE ra.responsibility_id = ?
           ORDER BY a.name`,
    args: [responsibilityId],
  });
  return res.rows.map((row) => ActorRow.parse(row));
}

export async function createResponsibility(
  db: Client,
  createdBy: string,
  input: CreateResponsibilityInput,
): Promise<ResponsibilityRow> {
  const parsed = CreateResponsibilityInput.parse(input);

  const id = ulid();
  const now = new Date().toISOString();

  await db.execute({
    sql: `INSERT INTO responsibilities (id, node_id, title, description, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      parsed.node_id,
      parsed.title,
      parsed.description ?? null,
      parsed.sort_order ?? 0,
      now,
      now,
    ],
  });

  // Bulk-insert initial assignees (if any). INSERT OR IGNORE keeps it safe
  // against duplicate IDs in the input list.
  if (parsed.assignees && parsed.assignees.length > 0) {
    for (const actorId of parsed.assignees) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO responsibility_assignments (responsibility_id, actor_id, created_at)
              VALUES (?, ?, ?)`,
        args: [id, actorId, now],
      });
    }
  }

  await writeAudit(db, createdBy, "create_responsibility", "responsibility", id, {
    node_id: parsed.node_id,
    title: parsed.title,
    assignees: parsed.assignees ?? [],
  });

  const row = await loadResponsibility(db, id);
  if (!row) throw new Error(`createResponsibility: inserted row ${id} not found`);
  return row;
}

export async function updateResponsibility(
  db: Client,
  updatedBy: string,
  input: UpdateResponsibilityInput,
): Promise<ResponsibilityRow> {
  const parsed = UpdateResponsibilityInput.parse(input);

  const existing = await loadResponsibility(db, parsed.responsibility_id);
  if (!existing) throw new Error(`updateResponsibility: ${parsed.responsibility_id} not found`);

  const updates: string[] = [];
  const values: InValue[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (parsed.title !== undefined) {
    updates.push("title = ?");
    values.push(parsed.title);
    changes.title = { from: existing.title, to: parsed.title };
  }
  if (parsed.description !== undefined) {
    updates.push("description = ?");
    values.push(parsed.description);
    changes.description = { from: existing.description, to: parsed.description };
  }
  if (parsed.sort_order !== undefined) {
    updates.push("sort_order = ?");
    values.push(parsed.sort_order);
    changes.sort_order = { from: existing.sort_order, to: parsed.sort_order };
  }

  if (updates.length === 0) {
    return existing;
  }

  updates.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(parsed.responsibility_id);

  await db.execute({
    sql: `UPDATE responsibilities SET ${updates.join(", ")} WHERE id = ?`,
    args: values,
  });

  await writeAudit(db, updatedBy, "update_responsibility", "responsibility", parsed.responsibility_id, {
    changes,
  });

  const row = await loadResponsibility(db, parsed.responsibility_id);
  if (!row) throw new Error(`updateResponsibility: row ${parsed.responsibility_id} disappeared after UPDATE`);
  return row;
}

export async function deleteResponsibility(
  db: Client,
  deletedBy: string,
  responsibilityId: string,
): Promise<void> {
  const existing = await loadResponsibility(db, responsibilityId);
  if (!existing) throw new Error(`deleteResponsibility: ${responsibilityId} not found`);

  await db.execute({
    sql: "DELETE FROM responsibilities WHERE id = ?",
    args: [responsibilityId],
  });

  await writeAudit(db, deletedBy, "delete_responsibility", "responsibility", responsibilityId, {
    node_id: existing.node_id,
    title: existing.title,
  });
}

export async function listResponsibilities(
  db: Client,
  filters: ListResponsibilitiesInput = {},
): Promise<ResponsibilityWithAssignees[]> {
  const parsed = ListResponsibilitiesInput.parse(filters);

  let sql: string;
  const args: InValue[] = [];

  if (parsed.actor_id !== undefined && parsed.node_id !== undefined) {
    sql = `SELECT DISTINCT r.* FROM responsibilities r
             JOIN responsibility_assignments ra ON ra.responsibility_id = r.id
            WHERE r.node_id = ? AND ra.actor_id = ?
            ORDER BY r.sort_order, r.title`;
    args.push(parsed.node_id, parsed.actor_id);
  } else if (parsed.actor_id !== undefined) {
    sql = `SELECT DISTINCT r.* FROM responsibilities r
             JOIN responsibility_assignments ra ON ra.responsibility_id = r.id
            WHERE ra.actor_id = ?
            ORDER BY r.sort_order, r.title`;
    args.push(parsed.actor_id);
  } else if (parsed.node_id !== undefined) {
    sql = `SELECT * FROM responsibilities
            WHERE node_id = ?
            ORDER BY sort_order, title`;
    args.push(parsed.node_id);
  } else {
    sql = `SELECT * FROM responsibilities ORDER BY sort_order, title`;
  }

  const res = await db.execute({ sql, args });
  const rows = res.rows.map((row) => ResponsibilityRow.parse(row));

  const out: ResponsibilityWithAssignees[] = [];
  for (const r of rows) {
    const assignees = await loadAssignees(db, r.id);
    out.push({ ...r, assignees });
  }
  return out;
}

export async function assignResponsibility(
  db: Client,
  assignedBy: string,
  input: AssignInput,
): Promise<void> {
  const parsed = AssignInput.parse(input);
  const now = new Date().toISOString();

  await db.execute({
    sql: `INSERT OR IGNORE INTO responsibility_assignments (responsibility_id, actor_id, created_at)
          VALUES (?, ?, ?)`,
    args: [parsed.responsibility_id, parsed.actor_id, now],
  });

  await writeAudit(
    db,
    assignedBy,
    "assign_responsibility",
    "responsibility_assignment",
    `${parsed.responsibility_id}:${parsed.actor_id}`,
    { responsibility_id: parsed.responsibility_id, actor_id: parsed.actor_id },
  );
}

export async function unassignResponsibility(
  db: Client,
  unassignedBy: string,
  input: AssignInput,
): Promise<void> {
  const parsed = AssignInput.parse(input);

  await db.execute({
    sql: `DELETE FROM responsibility_assignments
           WHERE responsibility_id = ? AND actor_id = ?`,
    args: [parsed.responsibility_id, parsed.actor_id],
  });

  await writeAudit(
    db,
    unassignedBy,
    "unassign_responsibility",
    "responsibility_assignment",
    `${parsed.responsibility_id}:${parsed.actor_id}`,
    { responsibility_id: parsed.responsibility_id, actor_id: parsed.actor_id },
  );
}
