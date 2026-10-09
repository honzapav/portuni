// Domain: event lifecycle mutations shared by MCP tools and REST.
// Supersede marks the old row and inserts the replacement, so history keeps
// both versions; update rewrites fields in place for corrections of form.

import { ulid } from "ulid";
import type { DbClient } from "../infra/db.js";
import { writeAudit } from "../infra/audit.js";
import { EVENT_TYPES, EVENT_STATUSES } from "../infra/schema.js";

export interface SupersedeEventResult {
  new_id: string;
  superseded_id: string;
  node_id: string;
}

// #530: an event id that matches no row; callers test the type, never the
// message text.
export class EventNotFoundError extends Error {
  constructor(readonly eventId: string) {
    super(`event ${eventId} not found`);
    this.name = "EventNotFoundError";
  }
}

export async function supersedeEventInternal(
  db: DbClient,
  userId: string,
  args: {
    eventId: string;
    newContent: string;
    meta?: Record<string, unknown>;
  },
): Promise<SupersedeEventResult> {
  const existing = await db.execute({
    sql: "SELECT * FROM events WHERE id = ?",
    args: [args.eventId],
  });
  if (existing.rows.length === 0) {
    throw new EventNotFoundError(args.eventId);
  }
  const oldRow = existing.rows[0];
  const nodeId = oldRow.node_id as string;

  const newId = ulid();
  const now = new Date().toISOString();
  const newMeta = args.meta ? JSON.stringify(args.meta) : ((oldRow.meta as string | null) ?? null);

  // One transaction: marking the old event superseded and inserting its
  // replacement succeed or fail together. Sequential statements could leave
  // the old event superseded with no successor when the INSERT failed.
  await db.batch(
    [
      {
        sql: "UPDATE events SET status = 'superseded' WHERE id = ?",
        args: [args.eventId],
      },
      {
        sql: `INSERT INTO events (id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at, logged_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId,
          nodeId,
          oldRow.type as string,
          args.newContent,
          newMeta,
          "active",
          JSON.stringify([args.eventId]),
          (oldRow.task_ref as string | null) ?? null,
          userId,
          // Preserve the original event date; logged_at records the rewrite.
          (oldRow.created_at as string | null) ?? now,
          now,
        ],
      },
    ],
    "write",
  );

  await writeAudit(db, userId, "supersede_event", "event", newId, {
    superseded_id: args.eventId,
    node_id: nodeId,
  });

  return { new_id: newId, superseded_id: args.eventId, node_id: nodeId };
}

// In-place edit of an event's fields. The counterpart of supersede for
// changes of form (a typo, a shorter wording, a wrong date or type) that
// history does not need to record: the id, node and logged_at stay put.
// Every field is optional; at least one must be given. meta, refs and
// task_ref take null to clear. Shared by portuni_update_event and
// PATCH /events/:id.
export interface UpdateEventFields {
  content?: string;
  type?: string;
  status?: string;
  createdAt?: string;
  meta?: Record<string, unknown> | null;
  refs?: string[] | null;
  taskRef?: string | null;
}

export interface UpdateEventResult {
  id: string;
  node_id: string;
  type: string;
  content: string;
  meta: Record<string, unknown> | null;
  status: string;
  refs: string[] | null;
  task_ref: string | null;
  created_at: string;
  logged_at: string;
  updated_fields: string[];
}

// A field the caller sent but that cannot be stored; `field` names it so
// the REST and MCP callers can answer with their own error shape.
export class InvalidEventUpdateError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidEventUpdateError";
  }
}

export async function updateEventInternal(
  db: DbClient,
  userId: string,
  eventId: string,
  fields: UpdateEventFields,
): Promise<UpdateEventResult> {
  const updates: string[] = [];
  const values: (string | null)[] = [];
  const updated: string[] = [];
  const set = (column: string, value: string | null) => {
    updates.push(`${column} = ?`);
    values.push(value);
    updated.push(column);
  };

  if (fields.content !== undefined) {
    const content = fields.content.trim();
    if (content.length === 0) {
      throw new InvalidEventUpdateError("content", "content must not be empty");
    }
    set("content", content);
  }
  if (fields.type !== undefined) {
    if (!(EVENT_TYPES as readonly string[]).includes(fields.type)) {
      throw new InvalidEventUpdateError("type", `invalid type; must be one of ${EVENT_TYPES.join(", ")}`);
    }
    set("type", fields.type);
  }
  if (fields.status !== undefined) {
    if (!(EVENT_STATUSES as readonly string[]).includes(fields.status)) {
      throw new InvalidEventUpdateError(
        "status",
        `invalid status; must be one of ${EVENT_STATUSES.join(", ")}`,
      );
    }
    set("status", fields.status);
  }
  if (fields.createdAt !== undefined) {
    const parsed = new Date(fields.createdAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidEventUpdateError(
        "created_at",
        "invalid created_at; expected ISO datetime (e.g. 2024-01-15 or 2024-01-15T10:30:00Z)",
      );
    }
    // Same normalization as portuni_log: the web slices this string
    // positionally, so it is always stored as a full ISO timestamp.
    set("created_at", parsed.toISOString());
  }
  if (fields.meta !== undefined) {
    set("meta", fields.meta === null ? null : JSON.stringify(fields.meta));
  }
  if (fields.refs !== undefined) {
    set("refs", fields.refs === null ? null : JSON.stringify(fields.refs));
  }
  if (fields.taskRef !== undefined) {
    set("task_ref", fields.taskRef);
  }
  if (updates.length === 0) {
    throw new InvalidEventUpdateError("*", "no fields to update");
  }

  values.push(eventId);
  const result = await db.execute({
    sql: `UPDATE events SET ${updates.join(", ")} WHERE id = ?`,
    args: values,
  });
  if (result.rowsAffected === 0) {
    throw new EventNotFoundError(eventId);
  }

  await writeAudit(db, userId, "update_event", "event", eventId, { fields: updated });

  const row = (
    await db.execute({
      sql: `SELECT id, node_id, type, content, meta, status, refs, task_ref, created_at, logged_at
            FROM events WHERE id = ?`,
      args: [eventId],
    })
  ).rows[0];
  return {
    id: row.id as string,
    node_id: row.node_id as string,
    type: row.type as string,
    content: row.content as string,
    meta: row.meta ? (JSON.parse(row.meta as string) as Record<string, unknown>) : null,
    status: row.status as string,
    refs: row.refs ? (JSON.parse(row.refs as string) as string[]) : null,
    task_ref: (row.task_ref as string | null) ?? null,
    created_at: String(row.created_at),
    logged_at: String(row.logged_at),
    updated_fields: updated,
  };
}
