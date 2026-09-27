// REST endpoints for /events. POST/PATCH/DELETE.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ulid } from "ulid";
import { getDb, type DbClient } from "../infra/db.js";
import { logAudit } from "../infra/audit.js";
import { EVENT_TYPES, EVENT_STATUSES } from "../infra/schema.js";
import {
  respondApiError,
  parseBody,
  parseJsonBody,
  respondError,
  respondJson,
  type RequestIdentity,
} from "../http/middleware.js";
import { nodeVisibleTo } from "../auth/node-access.js";
import { guardRestNodeWrite } from "./write-gate.js";

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
      respondApiError(res, 404, "NODE_NOT_FOUND", "node not found", { nodeId: body.node_id });
      return;
    }
    if (!(await guardRestNodeWrite(req, res, identity, body.node_id))) return;
    const id = ulid();
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at, logged_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, body.node_id, body.type, body.content, null, "active", null, null, identity.userId, now, now],
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

// An event is written through its node: a missing event and one on a node
// the caller cannot see answer the same 404, a visible one must pass the
// write gate. False once a response is sent.
async function guardEventWrite(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  db: DbClient,
  eventId: string,
): Promise<boolean> {
  const eventRow = await db.execute({
    sql: "SELECT node_id FROM events WHERE id = ?",
    args: [eventId],
  });
  const eventNodeId = eventRow.rows.length === 0 ? null : (eventRow.rows[0].node_id as string);
  if (eventNodeId === null || !(await nodeVisibleTo(db, identity, eventNodeId))) {
    respondApiError(res, 404, "EVENT_NOT_FOUND", "event not found", { eventId });
    return false;
  }
  return guardRestNodeWrite(req, res, identity, eventNodeId);
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
      respondApiError(res, 400, "INVALID_REQUEST", "body required");
      return;
    }
    const db = getDb();
    if (!(await guardEventWrite(req, res, identity, db, eventId))) return;
    const updates: string[] = [];
    const values: (string | null)[] = [];
    if (typeof body.content === "string" && body.content.trim().length > 0) {
      updates.push("content = ?");
      values.push(body.content.trim());
    }
    if (typeof body.type === "string") {
      if (!(EVENT_TYPES as readonly string[]).includes(body.type)) {
        respondApiError(res, 400, "INVALID_REQUEST", `invalid type; must be one of ${EVENT_TYPES.join(", ")}`);
        return;
      }
      updates.push("type = ?");
      values.push(body.type);
    }
    if (typeof body.status === "string") {
      // Validate up front like `type` -- relying on the DB CHECK produced
      // an opaque 409 instead of an actionable 400.
      if (!(EVENT_STATUSES as readonly string[]).includes(body.status)) {
        respondApiError(
          res,
          400,
          "INVALID_REQUEST",
          `invalid status; must be one of ${EVENT_STATUSES.join(", ")}`,
        );
        return;
      }
      updates.push("status = ?");
      values.push(body.status);
    }
    if (typeof body.created_at === "string") {
      const parsed = new Date(body.created_at);
      if (Number.isNaN(parsed.getTime())) {
        respondApiError(res, 400, "INVALID_EVENT_DATE", "invalid created_at; expected ISO datetime", {
          value: body.created_at,
        });
        return;
      }
      updates.push("created_at = ?");
      values.push(body.created_at);
    }
    if (updates.length === 0) {
      respondApiError(res, 400, "INVALID_REQUEST", "no fields to update");
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
    if (!(await guardEventWrite(req, res, identity, db, eventId))) return;
    const result = await db.execute({
      sql: "UPDATE events SET status = 'archived' WHERE id = ? AND status != 'archived'",
      args: [eventId],
    });
    if (result.rowsAffected === 0) {
      respondApiError(res, 404, "EVENT_ALREADY_ARCHIVED", "event already archived", { eventId });
      return;
    }
    await logAudit(identity.userId, "archive_event", "event", eventId, {});
    respondJson(res, 200, { archived: eventId });
  } catch (err) {
    respondError(res, `${req.method} /events/${eventId}`, err);
  }
}
