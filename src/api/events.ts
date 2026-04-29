// REST endpoints for /events. POST/PATCH/DELETE.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ulid } from "ulid";
import { getDb } from "../infra/db.js";
import { logAudit } from "../infra/audit.js";
import { EVENT_TYPES, SOLO_USER } from "../infra/schema.js";
import { parseBody, parseJsonBody, respondError , respondJson} from "../http/middleware.js";

const CreateEventBody = z.object({
  node_id: z.string().min(1),
  type: z.enum(EVENT_TYPES),
  content: z.string().min(1),
});

export async function handleCreateEvent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(req, res, CreateEventBody);
  if (!body) return;
  try {
    const db = getDb();
    const nodeCheck = await db.execute({
      sql: "SELECT id FROM nodes WHERE id = ?",
      args: [body.node_id],
    });
    if (nodeCheck.rows.length === 0) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    const id = ulid();
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, body.node_id, body.type, body.content, null, "active", null, null, SOLO_USER, now],
    });
    await logAudit(SOLO_USER, "log_event", "event", id, {
      node_id: body.node_id,
      type: body.type,
    });
    respondJson(res, 201, {
      id,
      node_id: body.node_id,
      type: body.type,
      content: body.content,
      status: "active",
      created_at: now,
    });
  } catch (err) {
    respondError(res, `${req.method} /events`, err);
  }
}

export async function handleUpdateEvent(
  req: IncomingMessage,
  res: ServerResponse,
  eventId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as
      | { content?: string; type?: string; status?: string }
      | undefined;
    if (!body) {
      respondJson(res, 400, { error: "body required" });
      return;
    }
    const db = getDb();
    const existing = await db.execute({
      sql: "SELECT id, status FROM events WHERE id = ?",
      args: [eventId],
    });
    if (existing.rows.length === 0) {
      respondJson(res, 404, { error: "event not found" });
      return;
    }
    const updates: string[] = [];
    const values: (string | null)[] = [];
    if (typeof body.content === "string" && body.content.trim().length > 0) {
      updates.push("content = ?");
      values.push(body.content.trim());
    }
    if (typeof body.type === "string") {
      if (!(EVENT_TYPES as readonly string[]).includes(body.type)) {
        respondJson(res, 400, {
          error: `invalid type; must be one of ${EVENT_TYPES.join(", ")}`,
        });
        return;
      }
      updates.push("type = ?");
      values.push(body.type);
    }
    if (typeof body.status === "string") {
      updates.push("status = ?");
      values.push(body.status);
    }
    if (updates.length === 0) {
      respondJson(res, 400, { error: "no fields to update" });
      return;
    }
    values.push(eventId);
    await db.execute({
      sql: `UPDATE events SET ${updates.join(", ")} WHERE id = ?`,
      args: values,
    });
    await logAudit(SOLO_USER, "update_event", "event", eventId, {
      fields: Object.keys(body),
    });
    const updated = await db.execute({
      sql: "SELECT id, type, content, status, created_at FROM events WHERE id = ?",
      args: [eventId],
    });
    respondJson(res, 200, updated.rows[0]);
  } catch (err) {
    respondError(res, `${req.method} /events/${eventId}`, err);
  }
}

export async function handleArchiveEvent(
  req: IncomingMessage,
  res: ServerResponse,
  eventId: string,
): Promise<void> {
  try {
    const result = await getDb().execute({
      sql: "UPDATE events SET status = 'archived' WHERE id = ? AND status != 'archived'",
      args: [eventId],
    });
    if (result.rowsAffected === 0) {
      respondJson(res, 404, { error: "event not found or already archived" });
      return;
    }
    await logAudit(SOLO_USER, "archive_event", "event", eventId, {});
    respondJson(res, 200, { archived: eventId });
  } catch (err) {
    respondError(res, `${req.method} /events/${eventId}`, err);
  }
}
