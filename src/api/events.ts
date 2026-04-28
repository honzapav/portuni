// REST endpoints for /events. POST/PATCH/DELETE.

import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { getDb } from "../infra/db.js";
import { logAudit } from "../infra/audit.js";
import { EVENT_TYPES, SOLO_USER } from "../infra/schema.js";
import { parseBody, respondError } from "../http/middleware.js";

export async function handleCreateEvent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as
      | { node_id?: string; type?: string; content?: string }
      | undefined;
    if (!body?.node_id || !body.type || !body.content) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "node_id, type, content required" }));
      return;
    }
    if (!(EVENT_TYPES as readonly string[]).includes(body.type)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `invalid type; must be one of ${EVENT_TYPES.join(", ")}`,
        }),
      );
      return;
    }
    const db = getDb();
    const nodeCheck = await db.execute({
      sql: "SELECT id FROM nodes WHERE id = ?",
      args: [body.node_id],
    });
    if (nodeCheck.rows.length === 0) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "node not found" }));
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
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        node_id: body.node_id,
        type: body.type,
        content: body.content,
        status: "active",
        created_at: now,
      }),
    );
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
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "body required" }));
      return;
    }
    const db = getDb();
    const existing = await db.execute({
      sql: "SELECT id, status FROM events WHERE id = ?",
      args: [eventId],
    });
    if (existing.rows.length === 0) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "event not found" }));
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
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `invalid type; must be one of ${EVENT_TYPES.join(", ")}`,
          }),
        );
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
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no fields to update" }));
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(updated.rows[0]));
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
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "event not found or already archived" }));
      return;
    }
    await logAudit(SOLO_USER, "archive_event", "event", eventId, {});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ archived: eventId }));
  } catch (err) {
    respondError(res, `${req.method} /events/${eventId}`, err);
  }
}
