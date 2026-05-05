// REST router. Pattern-matches the request URL/method and dispatches to
// the per-resource handler. Kept here (rather than spread across resource
// files) so the URL-shape rules — most importantly the
// /responsibilities/:id/assignments precedence over the bare
// /responsibilities/:id handlers — live in one place.

import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHealth } from "./health.js";
import { handleGraph } from "./graph.js";
import { handleWriteScope } from "./write-scope.js";
import { handleListUsers } from "./users.js";
import {
  handleCreateActor,
  handleDeleteActor,
  handleListActors,
  handleUpdateActor,
} from "./actors.js";
import {
  handleAssignResponsibility,
  handleCreateResponsibility,
  handleDeleteResponsibility,
  handleListResponsibilities,
  handleUnassignResponsibility,
  handleUpdateResponsibility,
} from "./responsibilities.js";
import {
  handleCreateDataSource,
  handleDeleteDataSource,
  handleListDataSources,
  handleUpdateDataSource,
} from "./data-sources.js";
import {
  handleCreateTool,
  handleDeleteTool,
  handleListTools,
  handleUpdateTool,
} from "./tools.js";
import {
  handleCreateNode,
  handleDeleteNode,
  handleFolderUrl,
  handleGetNode,
  handleMoveNode,
  handlePatchNode,
  handlePositions,
  handleSyncRun,
  handleSyncStatus,
} from "./nodes.js";
import { handleCreateEdge, handleDeleteEdge } from "./edges.js";
import {
  handleArchiveEvent,
  handleCreateEvent,
  handleUpdateEvent,
} from "./events.js";

// A sub-router takes the request and returns true if it handled the route
// (response written or in flight), false to fall through to the next group.
type SubRouter = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
) => Promise<boolean>;

// Dispatch table. Order matters only when prefixes overlap; today each group
// owns a disjoint pathname prefix, so any order works.
const SUB_ROUTERS: SubRouter[] = [
  routeSystem,
  routeActors,
  routeResponsibilities,
  routeDataSources,
  routeTools,
  routeNodes,
  routeEdges,
  routeEvents,
];

// Returns true when the route was handled (response written or in flight).
// Falls through to a 404 by the caller when none match.
export async function routeApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = req.method ?? "GET";
  for (const sub of SUB_ROUTERS) {
    if (await sub(req, res, url, method)) return true;
  }
  return false;
}

// --- System: health, graph, scope, users ---
async function routeSystem(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<boolean> {
  const { pathname } = url;
  if (pathname === "/health") {
    handleHealth(res);
    return true;
  }
  if (pathname === "/graph" && method === "GET") {
    await handleGraph(req, res);
    return true;
  }
  if (pathname === "/scope" && method === "GET") {
    await handleWriteScope(req, res, url);
    return true;
  }
  if (pathname === "/users" && method === "GET") {
    await handleListUsers(req, res);
    return true;
  }
  return false;
}

// --- Actors ---
async function routeActors(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<boolean> {
  const { pathname } = url;
  if (pathname === "/actors" && method === "GET") {
    await handleListActors(req, res, url);
    return true;
  }
  if (pathname === "/actors" && method === "POST") {
    await handleCreateActor(req, res);
    return true;
  }
  if (pathname.startsWith("/actors/")) {
    const id = decodeURIComponent(pathname.slice("/actors/".length));
    if (method === "PATCH") {
      await handleUpdateActor(req, res, id);
      return true;
    }
    if (method === "DELETE") {
      await handleDeleteActor(req, res, id);
      return true;
    }
  }
  return false;
}

// --- Responsibilities & assignments ---
// Match assignments BEFORE the bare /responsibilities/:id routes so the
// longer URL doesn't get swallowed by PATCH/DELETE handlers.
async function routeResponsibilities(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<boolean> {
  const { pathname } = url;
  const assignMatch = pathname.match(
    /^\/responsibilities\/([^/]+)\/assignments(?:\/([^/]+))?$/,
  );
  if (assignMatch) {
    const respId = decodeURIComponent(assignMatch[1]);
    const actorIdFromPath = assignMatch[2]
      ? decodeURIComponent(assignMatch[2])
      : undefined;
    if (method === "POST" && !actorIdFromPath) {
      await handleAssignResponsibility(req, res, respId);
      return true;
    }
    if (method === "DELETE" && actorIdFromPath) {
      await handleUnassignResponsibility(req, res, respId, actorIdFromPath);
      return true;
    }
  }
  if (pathname === "/responsibilities" && method === "GET") {
    await handleListResponsibilities(req, res, url);
    return true;
  }
  if (pathname === "/responsibilities" && method === "POST") {
    await handleCreateResponsibility(req, res);
    return true;
  }
  if (pathname.startsWith("/responsibilities/")) {
    const id = decodeURIComponent(pathname.slice("/responsibilities/".length));
    if (method === "PATCH") {
      await handleUpdateResponsibility(req, res, id);
      return true;
    }
    if (method === "DELETE") {
      await handleDeleteResponsibility(req, res, id);
      return true;
    }
  }
  return false;
}

// --- Data sources ---
async function routeDataSources(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<boolean> {
  const { pathname } = url;
  if (pathname === "/data-sources" && method === "GET") {
    await handleListDataSources(req, res, url);
    return true;
  }
  if (pathname === "/data-sources" && method === "POST") {
    await handleCreateDataSource(req, res);
    return true;
  }
  if (pathname.startsWith("/data-sources/")) {
    const id = decodeURIComponent(pathname.slice("/data-sources/".length));
    if (method === "DELETE") {
      await handleDeleteDataSource(req, res, id);
      return true;
    }
    if (method === "PATCH") {
      await handleUpdateDataSource(req, res, id);
      return true;
    }
  }
  return false;
}

// --- Tools (entity attribute) ---
async function routeTools(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<boolean> {
  const { pathname } = url;
  if (pathname === "/tools" && method === "GET") {
    await handleListTools(req, res, url);
    return true;
  }
  if (pathname === "/tools" && method === "POST") {
    await handleCreateTool(req, res);
    return true;
  }
  if (pathname.startsWith("/tools/")) {
    const id = decodeURIComponent(pathname.slice("/tools/".length));
    if (method === "DELETE") {
      await handleDeleteTool(req, res, id);
      return true;
    }
    if (method === "PATCH") {
      await handleUpdateTool(req, res, id);
      return true;
    }
  }
  return false;
}

// --- Nodes (compound paths first) ---
async function routeNodes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<boolean> {
  const { pathname } = url;

  const syncStatusMatch = pathname.match(/^\/nodes\/([^/]+)\/sync-status$/);
  if (syncStatusMatch && method === "GET") {
    await handleSyncStatus(req, res, decodeURIComponent(syncStatusMatch[1]));
    return true;
  }
  const folderUrlMatch = pathname.match(/^\/nodes\/([^/]+)\/folder-url$/);
  if (folderUrlMatch && method === "GET") {
    await handleFolderUrl(req, res, decodeURIComponent(folderUrlMatch[1]));
    return true;
  }
  const syncRunMatch = pathname.match(/^\/nodes\/([^/]+)\/sync$/);
  if (syncRunMatch && method === "POST") {
    await handleSyncRun(req, res, decodeURIComponent(syncRunMatch[1]));
    return true;
  }
  const moveMatch = pathname.match(/^\/nodes\/([^/]+)\/move$/);
  if (moveMatch && method === "POST") {
    await handleMoveNode(req, res, decodeURIComponent(moveMatch[1]));
    return true;
  }
  if (pathname === "/positions" && method === "POST") {
    await handlePositions(req, res);
    return true;
  }
  if (pathname === "/nodes" && method === "POST") {
    await handleCreateNode(req, res);
    return true;
  }
  if (pathname.startsWith("/nodes/")) {
    const id = decodeURIComponent(pathname.slice("/nodes/".length));
    if (method === "GET") {
      await handleGetNode(req, res, id);
      return true;
    }
    if (method === "PATCH") {
      await handlePatchNode(req, res, id);
      return true;
    }
    if (method === "DELETE") {
      await handleDeleteNode(req, res, id);
      return true;
    }
  }
  return false;
}

// --- Edges ---
async function routeEdges(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<boolean> {
  const { pathname } = url;
  if (pathname === "/edges" && method === "POST") {
    await handleCreateEdge(req, res);
    return true;
  }
  if (pathname.startsWith("/edges/") && method === "DELETE") {
    await handleDeleteEdge(
      req,
      res,
      decodeURIComponent(pathname.slice("/edges/".length)),
    );
    return true;
  }
  return false;
}

// --- Events ---
async function routeEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
): Promise<boolean> {
  const { pathname } = url;
  if (pathname === "/events" && method === "POST") {
    await handleCreateEvent(req, res);
    return true;
  }
  if (pathname.startsWith("/events/")) {
    const id = decodeURIComponent(pathname.slice("/events/".length));
    if (method === "PATCH") {
      await handleUpdateEvent(req, res, id);
      return true;
    }
    if (method === "DELETE") {
      await handleArchiveEvent(req, res, id);
      return true;
    }
  }
  return false;
}
