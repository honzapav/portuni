// REST endpoints for /events. POST/PATCH/DELETE.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ulid } from "ulid";
import { getDb, type DbClient } from "../infra/db.js";
import { logAudit } from "../infra/audit.js";
import { EVENT_TYPES } from "../infra/schema.js";
import {
  EventNotFoundError,
  InvalidEventUpdateError,
  updateEventInternal,
} from "../domain/events.js";
import {
  respondApiError,
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

// Body fields map 1:1 onto updateEventInternal; a field of the wrong JSON
// type is a 400 here, value checks (enums, dates, empty content) are the
// domain's.
const UpdateEventBody = z.object({
  content: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  created_at: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).nullable().optional(),
  refs: z.array(z.string()).nullable().optional(),
  task_ref: z.string().nullable().optional(),
});

export async function handleUpdateEvent(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  eventId: string,
): Promise<void> {
  try {
    const body = await parseJsonBody(req, res, UpdateEventBody);
    if (!body) return;
    const db = getDb();
    if (!(await guardEventWrite(req, res, identity, db, eventId))) return;
    const updated = await updateEventInternal(db, identity.userId, eventId, {
      content: body.content,
      type: body.type,
      status: body.status,
      createdAt: body.created_at,
      meta: body.meta,
      refs: body.refs,
      taskRef: body.task_ref,
    });
    respondJson(res, 200, updated);
  } catch (err) {
    if (err instanceof InvalidEventUpdateError) {
      if (err.field === "created_at") {
        respondApiError(res, 400, "INVALID_EVENT_DATE", err.message);
      } else {
        respondApiError(res, 400, "INVALID_REQUEST", err.message);
      }
      return;
    }
    if (err instanceof EventNotFoundError) {
      respondApiError(res, 404, "EVENT_NOT_FOUND", "event not found", { eventId });
      return;
    }
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
