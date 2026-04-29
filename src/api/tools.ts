// REST endpoints for /tools (entity attribute, not MCP tool).

import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";
import {
  addTool,
  listTools,
  removeTool,
  updateTool,
} from "../domain/entity-attributes.js";
import { parseBody, respondError , respondJson} from "../http/middleware.js";

export async function handleListTools(
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
    const rows = await listTools(getDb(), nodeId);
    respondJson(res, 200, rows);
  } catch (err) {
    respondError(res, `${req.method} ${url.pathname}`, err);
  }
}

export async function handleCreateTool(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length === 0) {
      respondJson(res, 400, { error: "body required" });
      return;
    }
    const row = await addTool(getDb(), SOLO_USER, body as Parameters<typeof addTool>[2]);
    respondJson(res, 201, row);
  } catch (err) {
    respondError(res, `${req.method} /tools`, err);
  }
}

export async function handleDeleteTool(
  req: IncomingMessage,
  res: ServerResponse,
  toolId: string,
): Promise<void> {
  try {
    await removeTool(getDb(), SOLO_USER, toolId);
    respondJson(res, 200, { deleted: toolId });
  } catch (err) {
    respondError(res, `${req.method} /tools/${toolId}`, err);
  }
}

export async function handleUpdateTool(
  req: IncomingMessage,
  res: ServerResponse,
  toolId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).length === 0) {
      respondJson(res, 400, { error: "no fields to update" });
      return;
    }
    const row = await updateTool(
      getDb(),
      SOLO_USER,
      toolId,
      body as Parameters<typeof updateTool>[3],
    );
    respondJson(res, 200, row);
  } catch (err) {
    respondError(res, `${req.method} /tools/${toolId}`, err);
  }
}
