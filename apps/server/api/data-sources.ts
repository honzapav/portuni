// REST endpoints for /data-sources.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import {
  addDataSource,
  listDataSources,
  removeDataSource,
  updateDataSource,
} from "../domain/entity-attributes.js";
import { respondError, respondJson, type RequestIdentity } from "../http/middleware.js";
import {
  guardNodeChildWrite,
  handleListByNode,
  readNodeCreateBody,
  readNonEmptyBody,
  type NodeChildLookup,
} from "./route-helpers.js";

function dataSourceLookup(dsId: string): NodeChildLookup {
  return {
    table: "data_sources",
    id: dsId,
    notFoundCode: "DATA_SOURCE_NOT_FOUND",
    notFoundMessage: `data source ${dsId} not found`,
    notFoundParams: { dataSourceId: dsId },
  };
}

export async function handleListDataSources(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  await handleListByNode(req, res, url, listDataSources);
}

export async function handleCreateDataSource(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    const parsed = await readNodeCreateBody(req, res, identity);
    if (!parsed) return;
    const row = await addDataSource(
      parsed.db,
      identity.userId,
      parsed.body as Parameters<typeof addDataSource>[2],
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
    if (!(await guardNodeChildWrite(req, res, identity, db, dataSourceLookup(dsId)))) return;
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
    const body = await readNonEmptyBody(req, res, "no fields to update");
    if (!body) return;
    const db = getDb();
    if (!(await guardNodeChildWrite(req, res, identity, db, dataSourceLookup(dsId)))) return;
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
