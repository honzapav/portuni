// Shared request plumbing for the node-scoped attribute routes
// (/responsibilities, /data-sources, /tools): body parsing, the node
// visibility check and the write gate, each answering with the same coded
// error the routes gave before they shared it.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb, type DbClient } from "../infra/db.js";
import { nodeVisibleTo } from "../auth/node-access.js";
import {
  respondApiError,
  parseBody,
  respondError,
  respondJson,
  type RequestIdentity,
} from "../http/middleware.js";
import type { ErrorCode, ErrorParams } from "../shared/error-codes.js";
import { guardRestNodeWrite } from "./write-gate.js";

// GET ?node_id=... listing: 400 without the parameter, else the rows.
export async function handleListByNode(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  list: (db: DbClient, nodeId: string) => Promise<unknown>,
): Promise<void> {
  const nodeId = url.searchParams.get("node_id");
  if (!nodeId) {
    respondApiError(res, 400, "INVALID_REQUEST", "node_id parameter required");
    return;
  }
  try {
    respondJson(res, 200, await list(getDb(), nodeId));
  } catch (err) {
    respondError(res, `${req.method} ${url.pathname}`, err);
  }
}

// A JSON object body with at least one field; otherwise a 400 carrying
// `emptyMessage` and null.
export async function readNonEmptyBody(
  req: IncomingMessage,
  res: ServerResponse,
  emptyMessage: string,
): Promise<Record<string, unknown> | null> {
  const body = (await parseBody(req)) as Record<string, unknown> | undefined;
  if (!body || Object.keys(body).length === 0) {
    respondApiError(res, 400, "INVALID_REQUEST", emptyMessage);
    return null;
  }
  return body;
}

// A create body naming the node it attaches to: the node must be visible
// to the caller and pass the write gate. Null once a response is sent.
export async function readNodeCreateBody(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<{ db: DbClient; body: Record<string, unknown> } | null> {
  const body = await readNonEmptyBody(req, res, "body required");
  if (!body) return null;
  const nodeId = body.node_id as string | undefined;
  if (!nodeId) {
    respondApiError(res, 400, "INVALID_REQUEST", "node_id required");
    return null;
  }
  const db = getDb();
  if (!(await nodeVisibleTo(db, identity, nodeId))) {
    respondApiError(res, 404, "NODE_NOT_FOUND", `node ${nodeId} not found`, { nodeId });
    return null;
  }
  if (!(await guardRestNodeWrite(req, res, identity, nodeId))) return null;
  return { db, body };
}

export interface NodeChildLookup {
  table: "responsibilities" | "data_sources" | "tools";
  id: string;
  notFoundCode: ErrorCode;
  notFoundMessage: string;
  notFoundParams: ErrorParams;
}

// Resolves the node a row of `lookup.table` hangs off. A missing row and a
// node the caller cannot see answer the same 404; a visible node must pass
// the write gate. Returns the node id, or null once a response is sent.
export async function guardNodeChildWrite(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  db: DbClient,
  lookup: NodeChildLookup,
): Promise<string | null> {
  const row = await db.execute({
    sql: `SELECT node_id FROM ${lookup.table} WHERE id = ?`,
    args: [lookup.id],
  });
  const nodeId = row.rows.length === 0 ? null : String(row.rows[0].node_id);
  if (nodeId === null || !(await nodeVisibleTo(db, identity, nodeId))) {
    respondApiError(res, 404, lookup.notFoundCode, lookup.notFoundMessage, lookup.notFoundParams);
    return null;
  }
  if (!(await guardRestNodeWrite(req, res, identity, nodeId))) return null;
  return nodeId;
}
