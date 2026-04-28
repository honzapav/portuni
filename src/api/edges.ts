// REST endpoints for /edges. POST = connect; DELETE /edges/:id =
// disconnect (routes through domain to honour the org-invariant precheck).

import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { getDb } from "../infra/db.js";
import { logAudit } from "../infra/audit.js";
import { EDGE_RELATIONS, SOLO_USER } from "../infra/schema.js";
import { disconnectEdgeById } from "../domain/edges.js";
import { parseBody, respondError } from "../http/middleware.js";

export async function handleCreateEdge(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as
      | { source_id?: string; target_id?: string; relation?: string }
      | undefined;
    if (!body?.source_id || !body.target_id || !body.relation) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "source_id, target_id, relation required" }),
      );
      return;
    }
    if (!(EDGE_RELATIONS as readonly string[]).includes(body.relation)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `invalid relation; must be one of ${EDGE_RELATIONS.join(", ")}`,
        }),
      );
      return;
    }
    if (body.source_id === body.target_id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "source and target must differ" }));
      return;
    }
    const db = getDb();
    const check = await db.execute({
      sql: "SELECT id FROM nodes WHERE id IN (?, ?)",
      args: [body.source_id, body.target_id],
    });
    if (check.rows.length < 2) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "one or both nodes not found" }));
      return;
    }
    const dup = await db.execute({
      sql: "SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?",
      args: [body.source_id, body.target_id, body.relation],
    });
    if (dup.rows.length > 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: dup.rows[0].id, duplicate: true }));
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
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        source_id: body.source_id,
        target_id: body.target_id,
        relation: body.relation,
      }),
    );
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === "EDGE_NOT_FOUND") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    if (code === "ORG_INVARIANT") {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    respondError(res, `${req.method} /edges/${edgeId}`, err);
  }
}
