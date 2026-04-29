// REST endpoints for /actors. List/POST/PATCH/DELETE.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";
import { archiveActor, createActor, updateActor } from "../domain/actors.js";
import { parseBody, respondError , respondJson} from "../http/middleware.js";

export async function handleListActors(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  try {
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    const type = url.searchParams.get("type");
    if (type === "person" || type === "automation") {
      clauses.push("type = ?");
      values.push(type);
    }
    const placeholder = url.searchParams.get("is_placeholder");
    if (placeholder === "1" || placeholder === "true") {
      clauses.push("is_placeholder = 1");
    } else if (placeholder === "0" || placeholder === "false") {
      clauses.push("is_placeholder = 0");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await getDb().execute({
      sql: `SELECT id, type, name, is_placeholder, user_id, notes, external_id
            FROM actors ${where} ORDER BY type, name`,
      args: values,
    });
    respondJson(res, 200, rows.rows);
  } catch (err) {
    respondError(res, `${req.method} ${url.pathname}`, err);
  }
}

export async function handleCreateActor(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length === 0) {
      respondJson(res, 400, { error: "body required" });
      return;
    }
    const row = await createActor(getDb(), SOLO_USER, body as Parameters<typeof createActor>[2]);
    respondJson(res, 201, row);
  } catch (err) {
    respondError(res, `${req.method} /actors`, err);
  }
}

export async function handleUpdateActor(
  req: IncomingMessage,
  res: ServerResponse,
  actorId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length === 0) {
      respondJson(res, 400, { error: "no fields to update" });
      return;
    }
    const row = await updateActor(getDb(), SOLO_USER, {
      actor_id: actorId,
      ...(body as object),
    } as Parameters<typeof updateActor>[2]);
    respondJson(res, 200, row);
  } catch (err) {
    respondError(res, `${req.method} /actors/${actorId}`, err);
  }
}

export async function handleDeleteActor(
  req: IncomingMessage,
  res: ServerResponse,
  actorId: string,
): Promise<void> {
  try {
    await archiveActor(getDb(), SOLO_USER, actorId);
    respondJson(res, 200, { archived: actorId });
  } catch (err) {
    respondError(res, `${req.method} /actors/${actorId}`, err);
  }
}
