// REST endpoints for /data-sources.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import {
  addDataSource,
  listDataSources,
  removeDataSource,
  updateDataSource,
} from "../domain/entity-attributes.js";
import { nodeVisibleTo } from "../auth/node-access.js";
import {
  respondApiError,
  parseBody,
  respondError,
  respondJson,
  type RequestIdentity,
} from "../http/middleware.js";
import { guardRestNodeWrite } from "./write-gate.js";

export async function handleListDataSources(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const nodeId = url.searchParams.get("node_id");
  if (!nodeId) {
    respondApiError(res, 400, "INVALID_REQUEST", "node_id parameter required");
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
  identity: RequestIdentity,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length === 0) {
      respondApiError(res, 400, "INVALID_REQUEST", "body required");
      return;
    }
    const nodeId = body.node_id as string | undefined;
    if (!nodeId) {
      respondApiError(res, 400, "INVALID_REQUEST", "node_id required");
      return;
    }
    const db = getDb();
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondApiError(res, 404, "NODE_NOT_FOUND", `node ${nodeId} not found`, { nodeId });
      return;
    }
    if (!(await guardRestNodeWrite(req, res, identity, nodeId))) return;
    const row = await addDataSource(
      db,
      identity.userId,
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
  identity: RequestIdentity,
  dsId: string,
): Promise<void> {
  try {
    const db = getDb();
    const dsRow = await db.execute({
      sql: "SELECT node_id FROM data_sources WHERE id = ?",
      args: [dsId],
    });
    if (dsRow.rows.length === 0) {
      respondApiError(res, 404, "DATA_SOURCE_NOT_FOUND", `data source ${dsId} not found`, { dataSourceId: dsId });
      return;
    }
    const nodeId = String(dsRow.rows[0].node_id);
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondApiError(res, 404, "DATA_SOURCE_NOT_FOUND", `data source ${dsId} not found`, { dataSourceId: dsId });
      return;
    }
    if (!(await guardRestNodeWrite(req, res, identity, nodeId))) return;
    await removeDataSource(db, identity.userId, dsId);
    respondJson(res, 200, { deleted: dsId });
  } catch (err) {
    respondError(res, `${req.method} /data-sources/${dsId}`, err);
  }
}

export async function handleUpdateDataSource(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  dsId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length === 0) {
      respondApiError(res, 400, "INVALID_REQUEST", "no fields to update");
      return;
    }
    const db = getDb();
    const dsRow = await db.execute({
      sql: "SELECT node_id FROM data_sources WHERE id = ?",
      args: [dsId],
    });
    if (dsRow.rows.length === 0) {
      respondApiError(res, 404, "DATA_SOURCE_NOT_FOUND", `data source ${dsId} not found`, { dataSourceId: dsId });
      return;
    }
    const nodeId = String(dsRow.rows[0].node_id);
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondApiError(res, 404, "DATA_SOURCE_NOT_FOUND", `data source ${dsId} not found`, { dataSourceId: dsId });
      return;
    }
    if (!(await guardRestNodeWrite(req, res, identity, nodeId))) return;
    const row = await updateDataSource(
      db,
      identity.userId,
      dsId,
      body as Parameters<typeof updateDataSource>[3],
    );
    respondJson(res, 200, row);
  } catch (err) {
    respondError(res, `${req.method} /data-sources/${dsId}`, err);
  }
}
