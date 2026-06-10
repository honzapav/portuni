// Domain: event lifecycle mutations shared by MCP tools (and future REST).
// Events are append-only: supersede marks the old row and inserts the
// replacement; nothing is ever rewritten in place.

import { ulid } from "ulid";
import type { Client } from "@libsql/client";
import { writeAudit } from "../infra/audit.js";

export interface SupersedeEventResult {
  new_id: string;
  superseded_id: string;
  node_id: string;
}

export async function supersedeEventInternal(
  db: Client,
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
    throw new Error(`event ${args.eventId} not found`);
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
        sql: `INSERT INTO events (id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
