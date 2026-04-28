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
import { parseBody, respondError } from "../http/middleware.js";

export async function handleListDataSources(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const nodeId = url.searchParams.get("node_id");
  if (!nodeId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "node_id parameter required" }));
    return;
  }
  try {
    const rows = await listDataSources(getDb(), nodeId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
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
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "body required" }));
      return;
    }
    const row = await addDataSource(
      getDb(),
      SOLO_USER,
      body as Parameters<typeof addDataSource>[2],
    );
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(row));
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted: dsId }));
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
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no fields to update" }));
      return;
    }
    const row = await updateDataSource(
      getDb(),
      SOLO_USER,
      dsId,
      body as Parameters<typeof updateDataSource>[3],
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(row));
  } catch (err) {
    respondError(res, `${req.method} /data-sources/${dsId}`, err);
  }
}
