// REST endpoints for /events. POST/PATCH/DELETE.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ulid } from "ulid";
import { getDb } from "../infra/db.js";
import { logAudit } from "../infra/audit.js";
import { EVENT_TYPES } from "../infra/schema.js";
import { parseBody, parseJsonBody, respondError, respondJson, type RequestIdentity } from "../http/middleware.js";
import { nodeVisibleTo } from "../auth/node-access.js";

const CreateEventBody = z.object({
  node_id: z.string().min(1),
  type: z.enum(EVENT_TYPES),
  content: z.string().min(1),
});

export async function handleCreateEvent(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  const body = await parseJsonBody(req, res, CreateEventBody);
  if (!body) return;
  try {
    const db = getDb();
    const nodeCheck = await db.execute({
      sql: "SELECT id FROM nodes WHERE id = ?",
      args: [body.node_id],
    });
    if (nodeCheck.rows.length === 0 || !(await nodeVisibleTo(db, identity, body.node_id))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    const id = ulid();
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, body.node_id, body.type, body.content, null, "active", null, null, identity.userId, now],
    });
    await logAudit(identity.userId, "log_event", "event", id, {
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
  identity: RequestIdentity,
  eventId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as
      | { content?: string; type?: string; status?: string; created_at?: string }
      | undefined;
    if (!body) {
      respondJson(res, 400, { error: "body required" });
      return;
    }
    const db = getDb();
    const existing = await db.execute({
      sql: "SELECT id, status, node_id FROM events WHERE id = ?",
      args: [eventId],
    });
    if (existing.rows.length === 0) {
      respondJson(res, 404, { error: "event not found" });
      return;
    }
    const eventNodeId = existing.rows[0].node_id as string;
    if (!(await nodeVisibleTo(db, identity, eventNodeId))) {
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
    if (typeof body.created_at === "string") {
      const parsed = new Date(body.created_at);
      if (Number.isNaN(parsed.getTime())) {
        respondJson(res, 400, { error: "invalid created_at; expected ISO datetime" });
        return;
      }
      updates.push("created_at = ?");
      values.push(body.created_at);
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
    await logAudit(identity.userId, "update_event", "event", eventId, {
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
  identity: RequestIdentity,
  eventId: string,
): Promise<void> {
  try {
    const db = getDb();
    const eventRow = await db.execute({
      sql: "SELECT node_id FROM events WHERE id = ?",
      args: [eventId],
    });
    if (eventRow.rows.length === 0) {
      respondJson(res, 404, { error: "event not found or already archived" });
      return;
    }
    const eventNodeId = eventRow.rows[0].node_id as string;
    if (!(await nodeVisibleTo(db, identity, eventNodeId))) {
      respondJson(res, 404, { error: "event not found or already archived" });
      return;
    }
    const result = await db.execute({
      sql: "UPDATE events SET status = 'archived' WHERE id = ? AND status != 'archived'",
      args: [eventId],
    });
    if (result.rowsAffected === 0) {
      respondJson(res, 404, { error: "event not found or already archived" });
      return;
    }
    await logAudit(identity.userId, "archive_event", "event", eventId, {});
    respondJson(res, 200, { archived: eventId });
  } catch (err) {
    respondError(res, `${req.method} /events/${eventId}`, err);
  }
}
