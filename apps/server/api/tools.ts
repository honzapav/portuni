// REST endpoints for /tools (entity attribute, not MCP tool).

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import {
  addTool,
  listTools,
  removeTool,
  updateTool,
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

export async function handleListTools(
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
    const rows = await listTools(getDb(), nodeId);
    respondJson(res, 200, rows);
  } catch (err) {
    respondError(res, `${req.method} ${url.pathname}`, err);
  }
}

export async function handleCreateTool(
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
    const row = await addTool(db, identity.userId, body as Parameters<typeof addTool>[2]);
    respondJson(res, 201, row);
  } catch (err) {
    respondError(res, `${req.method} /tools`, err);
  }
}

export async function handleDeleteTool(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  toolId: string,
): Promise<void> {
  try {
    const db = getDb();
    const toolRow = await db.execute({
      sql: "SELECT node_id FROM tools WHERE id = ?",
      args: [toolId],
    });
    if (toolRow.rows.length === 0) {
      respondApiError(res, 404, "TOOL_NOT_FOUND", `tool ${toolId} not found`, { toolId: toolId });
      return;
    }
    const nodeId = String(toolRow.rows[0].node_id);
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondApiError(res, 404, "TOOL_NOT_FOUND", `tool ${toolId} not found`, { toolId: toolId });
      return;
    }
    if (!(await guardRestNodeWrite(req, res, identity, nodeId))) return;
    await removeTool(db, identity.userId, toolId);
    respondJson(res, 200, { deleted: toolId });
  } catch (err) {
    respondError(res, `${req.method} /tools/${toolId}`, err);
  }
}

export async function handleUpdateTool(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  toolId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length === 0) {
      respondApiError(res, 400, "INVALID_REQUEST", "no fields to update");
      return;
    }
    const db = getDb();
    const toolRow = await db.execute({
      sql: "SELECT node_id FROM tools WHERE id = ?",
      args: [toolId],
    });
    if (toolRow.rows.length === 0) {
      respondApiError(res, 404, "TOOL_NOT_FOUND", `tool ${toolId} not found`, { toolId: toolId });
      return;
    }
    const nodeId = String(toolRow.rows[0].node_id);
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondApiError(res, 404, "TOOL_NOT_FOUND", `tool ${toolId} not found`, { toolId: toolId });
      return;
    }
    if (!(await guardRestNodeWrite(req, res, identity, nodeId))) return;
    const row = await updateTool(
      db,
      identity.userId,
      toolId,
      body as Parameters<typeof updateTool>[3],
    );
    respondJson(res, 200, row);
  } catch (err) {
    respondError(res, `${req.method} /tools/${toolId}`, err);
  }
}
