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
import { parseBody, respondError } from "../http/middleware.js";

export async function handleListTools(
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
    const rows = await listTools(getDb(), nodeId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
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
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "body required" }));
      return;
    }
    const row = await addTool(getDb(), SOLO_USER, body as Parameters<typeof addTool>[2]);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(row));
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted: toolId }));
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
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no fields to update" }));
      return;
    }
    const row = await updateTool(
      getDb(),
      SOLO_USER,
      toolId,
      body as Parameters<typeof updateTool>[3],
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(row));
  } catch (err) {
    respondError(res, `${req.method} /tools/${toolId}`, err);
  }
}
