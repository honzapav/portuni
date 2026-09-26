// REST endpoints for /tools (entity attribute, not MCP tool).

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import {
  addTool,
  listTools,
  removeTool,
  updateTool,
} from "../domain/entity-attributes.js";
import { respondError, respondJson, type RequestIdentity } from "../http/middleware.js";
import {
  guardNodeChildWrite,
  handleListByNode,
  readNodeCreateBody,
  readNonEmptyBody,
  type NodeChildLookup,
} from "./route-helpers.js";

function toolLookup(toolId: string): NodeChildLookup {
  return {
    table: "tools",
    id: toolId,
    notFoundCode: "TOOL_NOT_FOUND",
    notFoundMessage: `tool ${toolId} not found`,
    notFoundParams: { toolId: toolId },
  };
}

export async function handleListTools(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  await handleListByNode(req, res, url, listTools);
}

export async function handleCreateTool(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    const parsed = await readNodeCreateBody(req, res, identity);
    if (!parsed) return;
    const row = await addTool(parsed.db, identity.userId, parsed.body as Parameters<typeof addTool>[2]);
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
    if (!(await guardNodeChildWrite(req, res, identity, db, toolLookup(toolId)))) return;
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
    const body = await readNonEmptyBody(req, res, "no fields to update");
    if (!body) return;
    const db = getDb();
    if (!(await guardNodeChildWrite(req, res, identity, db, toolLookup(toolId)))) return;
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
