// REST endpoints for /responsibilities + /responsibilities/:id/assignments.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDb } from "../infra/db.js";
import {
  assignResponsibility,
  createResponsibility,
  deleteResponsibility,
  listResponsibilities,
  unassignResponsibility,
  updateResponsibility,
  reorderResponsibilities,
} from "../domain/responsibilities.js";
import {
  respondApiError,
  parseBody,
  parseJsonBody,
  respondError,
  respondJson,
  type RequestIdentity,
} from "../http/middleware.js";
import {
  guardNodeChildWrite,
  readNodeCreateBody,
  readNonEmptyBody,
  type NodeChildLookup,
} from "./route-helpers.js";

function responsibilityLookup(respId: string): NodeChildLookup {
  return {
    table: "responsibilities",
    id: respId,
    notFoundCode: "RESPONSIBILITY_NOT_FOUND",
    notFoundMessage: `responsibility ${respId} not found`,
    notFoundParams: { responsibilityId: respId },
  };
}

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
  identity: RequestIdentity,
): Promise<void> {
  try {
    const parsed = await readNodeCreateBody(req, res, identity);
    if (!parsed) return;
    const row = await createResponsibility(
      parsed.db,
      identity.userId,
      parsed.body as Parameters<typeof createResponsibility>[2],
    );
    respondJson(res, 201, row);
  } catch (err) {
    respondError(res, `${req.method} /responsibilities`, err);
  }
}

// POST /responsibilities/reorder (client traffic contract, rule 6): every
// row's sort_order in one request. Each row's node must be writable.
const ReorderBody = z.object({
  updates: z.array(z.object({ id: z.string().min(1), sort_order: z.number().int().min(0) })).min(1).max(200),
});

export async function handleReorderResponsibilities(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    const body = await parseJsonBody(req, res, ReorderBody);
    if (!body) return;
    const db = getDb();
    for (const u of body.updates) {
      if (!(await guardNodeChildWrite(req, res, identity, db, responsibilityLookup(u.id)))) return;
    }
    respondJson(res, 200, await reorderResponsibilities(db, identity.userId, body.updates));
  } catch (err) {
    respondError(res, `${req.method} /responsibilities/reorder`, err);
  }
}

export async function handleUpdateResponsibility(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  respId: string,
): Promise<void> {
  try {
    const body = await readNonEmptyBody(req, res, "no fields to update");
    if (!body) return;
    const db = getDb();
    if (!(await guardNodeChildWrite(req, res, identity, db, responsibilityLookup(respId)))) return;
    const row = await updateResponsibility(db, identity.userId, {
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
  identity: RequestIdentity,
  respId: string,
): Promise<void> {
  try {
    const db = getDb();
    if (!(await guardNodeChildWrite(req, res, identity, db, responsibilityLookup(respId)))) return;
    await deleteResponsibility(db, identity.userId, respId);
    respondJson(res, 200, { deleted: respId });
  } catch (err) {
    respondError(res, `${req.method} /responsibilities/${respId}`, err);
  }
}

export async function handleAssignResponsibility(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  respId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as { actor_id?: string } | undefined;
    if (!body?.actor_id) {
      respondApiError(res, 400, "INVALID_REQUEST", "actor_id required");
      return;
    }
    const db = getDb();
    if (!(await guardNodeChildWrite(req, res, identity, db, responsibilityLookup(respId)))) return;
    await assignResponsibility(db, identity.userId, {
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
  identity: RequestIdentity,
  respId: string,
  actorId: string,
): Promise<void> {
  try {
    const db = getDb();
    if (!(await guardNodeChildWrite(req, res, identity, db, responsibilityLookup(respId)))) return;
    await unassignResponsibility(db, identity.userId, {
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
