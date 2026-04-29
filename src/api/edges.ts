// REST endpoints for /edges. POST = connect; DELETE /edges/:id =
// disconnect (routes through domain to honour the org-invariant precheck).

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ulid } from "ulid";
import { getDb } from "../infra/db.js";
import { logAudit } from "../infra/audit.js";
import { EDGE_RELATIONS, SOLO_USER } from "../infra/schema.js";
import { disconnectEdgeById } from "../domain/edges.js";
import { parseJsonBody, respondError , respondJson} from "../http/middleware.js";

const CreateEdgeBody = z
  .object({
    source_id: z.string().min(1),
    target_id: z.string().min(1),
    relation: z.enum(EDGE_RELATIONS),
  })
  .refine((b) => b.source_id !== b.target_id, {
    message: "source and target must differ",
    path: ["target_id"],
  });

export async function handleCreateEdge(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(req, res, CreateEdgeBody);
  if (!body) return;
  try {
    const db = getDb();
    const check = await db.execute({
      sql: "SELECT id FROM nodes WHERE id IN (?, ?)",
      args: [body.source_id, body.target_id],
    });
    if (check.rows.length < 2) {
      respondJson(res, 404, { error: "one or both nodes not found" });
      return;
    }
    const dup = await db.execute({
      sql: "SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?",
      args: [body.source_id, body.target_id, body.relation],
    });
    if (dup.rows.length > 0) {
      respondJson(res, 200, { id: dup.rows[0].id, duplicate: true });
      return;
    }
    const id = ulid();
    await db.execute({
      sql: `INSERT INTO edges (id, source_id, target_id, relation, meta, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, body.source_id, body.target_id, body.relation, null, SOLO_USER, new Date().toISOString()],
    });
    await logAudit(SOLO_USER, "connect", "edge", id, {
      source_id: body.source_id,
      target_id: body.target_id,
      relation: body.relation,
    });
    respondJson(res, 201, {
      id,
      source_id: body.source_id,
      target_id: body.target_id,
      relation: body.relation,
    });
  } catch (err) {
    respondError(res, `${req.method} /edges`, err);
  }
}

export async function handleDeleteEdge(
  req: IncomingMessage,
  res: ServerResponse,
  edgeId: string,
): Promise<void> {
  try {
    const result = await disconnectEdgeById(getDb(), SOLO_USER, edgeId);
    respondJson(res, 200, result);
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === "EDGE_NOT_FOUND") {
      respondJson(res, 404, { error: (err as Error).message });
      return;
    }
    if (code === "ORG_INVARIANT") {
      respondJson(res, 409, { error: (err as Error).message });
      return;
    }
    respondError(res, `${req.method} /edges/${edgeId}`, err);
  }
}
