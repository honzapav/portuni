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
import { parseBody, respondError , respondJson} from "../http/middleware.js";

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
    respondJson(res, 200, rows);
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
      respondJson(res, 400, { error: "body required" });
      return;
    }
    const row = await createResponsibility(
      getDb(),
      SOLO_USER,
      body as Parameters<typeof createResponsibility>[2],
    );
    respondJson(res, 201, row);
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
      respondJson(res, 400, { error: "no fields to update" });
      return;
    }
    const row = await updateResponsibility(getDb(), SOLO_USER, {
      responsibility_id: respId,
      ...(body as object),
    } as Parameters<typeof updateResponsibility>[2]);
    respondJson(res, 200, row);
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
    respondJson(res, 200, { deleted: respId });
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
      respondJson(res, 400, { error: "actor_id required" });
      return;
    }
    await assignResponsibility(getDb(), SOLO_USER, {
      responsibility_id: respId,
      actor_id: body.actor_id,
    });
    respondJson(res, 200, { ok: true });
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
    respondJson(res, 200, { ok: true });
  } catch (err) {
    respondError(
      res,
      `${req.method} /responsibilities/${respId}/assignments/${actorId}`,
      err,
    );
  }
}
