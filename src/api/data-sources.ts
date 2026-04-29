// REST endpoints for /data-sources.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";
import {
  addDataSource,
  listDataSources,
  removeDataSource,
  updateDataSource,
} from "../domain/entity-attributes.js";
import { parseBody, respondError , respondJson} from "../http/middleware.js";

export async function handleListDataSources(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const nodeId = url.searchParams.get("node_id");
  if (!nodeId) {
    respondJson(res, 400, { error: "node_id parameter required" });
    return;
  }
  try {
    const rows = await listDataSources(getDb(), nodeId);
    respondJson(res, 200, rows);
  } catch (err) {
    respondError(res, `${req.method} ${url.pathname}`, err);
  }
}

export async function handleCreateDataSource(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length === 0) {
      respondJson(res, 400, { error: "body required" });
      return;
    }
    const row = await addDataSource(
      getDb(),
      SOLO_USER,
      body as Parameters<typeof addDataSource>[2],
    );
    respondJson(res, 201, row);
  } catch (err) {
    respondError(res, `${req.method} /data-sources`, err);
  }
}

export async function handleDeleteDataSource(
  req: IncomingMessage,
  res: ServerResponse,
  dsId: string,
): Promise<void> {
  try {
    await removeDataSource(getDb(), SOLO_USER, dsId);
    respondJson(res, 200, { deleted: dsId });
  } catch (err) {
    respondError(res, `${req.method} /data-sources/${dsId}`, err);
  }
}

export async function handleUpdateDataSource(
  req: IncomingMessage,
  res: ServerResponse,
  dsId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length === 0) {
      respondJson(res, 400, { error: "no fields to update" });
      return;
    }
    const row = await updateDataSource(
      getDb(),
      SOLO_USER,
      dsId,
      body as Parameters<typeof updateDataSource>[3],
    );
    respondJson(res, 200, row);
  } catch (err) {
    respondError(res, `${req.method} /data-sources/${dsId}`, err);
  }
}
