// REST endpoints for /responsibilities + /responsibilities/:id/assignments.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";
import {
  assignResponsibility,
  createResponsibility,
  deleteResponsibility,
  listResponsibilities,
  unassignResponsibility,
  updateResponsibility,
} from "../domain/responsibilities.js";
import { parseBody, respondError } from "../http/middleware.js";

export async function handleListResponsibilities(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  try {
    const filters: { node_id?: string; actor_id?: string } = {};
    const nodeId = url.searchParams.get("node_id");
    const actorId = url.searchParams.get("actor_id");
    if (nodeId) filters.node_id = nodeId;
    if (actorId) filters.actor_id = actorId;
    const rows = await listResponsibilities(getDb(), filters);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
  } catch (err) {
    respondError(res, `${req.method} ${url.pathname}`, err);
  }
}

export async function handleCreateResponsibility(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "body required" }));
      return;
    }
    const row = await createResponsibility(
      getDb(),
      SOLO_USER,
      body as Parameters<typeof createResponsibility>[2],
    );
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(row));
  } catch (err) {
    respondError(res, `${req.method} /responsibilities`, err);
  }
}

export async function handleUpdateResponsibility(
  req: IncomingMessage,
  res: ServerResponse,
  respId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no fields to update" }));
      return;
    }
    const row = await updateResponsibility(getDb(), SOLO_USER, {
      responsibility_id: respId,
      ...(body as object),
    } as Parameters<typeof updateResponsibility>[2]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(row));
  } catch (err) {
    respondError(res, `${req.method} /responsibilities/${respId}`, err);
  }
}

export async function handleDeleteResponsibility(
  req: IncomingMessage,
  res: ServerResponse,
  respId: string,
): Promise<void> {
  try {
    await deleteResponsibility(getDb(), SOLO_USER, respId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted: respId }));
  } catch (err) {
    respondError(res, `${req.method} /responsibilities/${respId}`, err);
  }
}

export async function handleAssignResponsibility(
  req: IncomingMessage,
  res: ServerResponse,
  respId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as { actor_id?: string } | undefined;
    if (!body?.actor_id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "actor_id required" }));
      return;
    }
    await assignResponsibility(getDb(), SOLO_USER, {
      responsibility_id: respId,
      actor_id: body.actor_id,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    respondError(
      res,
      `${req.method} /responsibilities/${respId}/assignments`,
      err,
    );
  }
}

export async function handleUnassignResponsibility(
  req: IncomingMessage,
  res: ServerResponse,
  respId: string,
  actorId: string,
): Promise<void> {
  try {
    await unassignResponsibility(getDb(), SOLO_USER, {
      responsibility_id: respId,
      actor_id: actorId,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    respondError(
      res,
      `${req.method} /responsibilities/${respId}/assignments/${actorId}`,
      err,
    );
  }
}
