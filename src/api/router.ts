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

// Returns true when the route was handled (response written or in flight).
// Falls through to a 404 by the caller when none match.
export async function routeApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const { pathname } = url;
  const method = req.method ?? "GET";

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

  // --- Actors ---
  if (pathname === "/actors" && method === "GET") {
    await handleListActors(req, res, url);
    return true;
  }
  if (pathname === "/actors" && method === "POST") {
    await handleCreateActor(req, res);
    return true;
  }
  if (pathname.startsWith("/actors/") && method === "PATCH") {
    const id = decodeURIComponent(pathname.slice("/actors/".length));
    await handleUpdateActor(req, res, id);
    return true;
  }
  if (pathname.startsWith("/actors/") && method === "DELETE") {
    const id = decodeURIComponent(pathname.slice("/actors/".length));
    await handleDeleteActor(req, res, id);
    return true;
  }

  // --- Responsibilities & assignments ---
  // Match assignments BEFORE the bare /responsibilities/:id routes so the
  // longer URL doesn't get swallowed by PATCH/DELETE handlers.
  const respAssignMatch = pathname.match(
    /^\/responsibilities\/([^/]+)\/assignments(?:\/([^/]+))?$/,
  );
  if (respAssignMatch) {
    const respId = decodeURIComponent(respAssignMatch[1]);
    const actorIdFromPath = respAssignMatch[2]
      ? decodeURIComponent(respAssignMatch[2])
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
  if (pathname.startsWith("/responsibilities/") && method === "PATCH") {
    const id = decodeURIComponent(pathname.slice("/responsibilities/".length));
    await handleUpdateResponsibility(req, res, id);
    return true;
  }
  if (pathname.startsWith("/responsibilities/") && method === "DELETE") {
    const id = decodeURIComponent(pathname.slice("/responsibilities/".length));
    await handleDeleteResponsibility(req, res, id);
    return true;
  }

  // --- Data sources ---
  if (pathname === "/data-sources" && method === "GET") {
    await handleListDataSources(req, res, url);
    return true;
  }
  if (pathname === "/data-sources" && method === "POST") {
    await handleCreateDataSource(req, res);
    return true;
  }
  if (pathname.startsWith("/data-sources/") && method === "DELETE") {
    const id = decodeURIComponent(pathname.slice("/data-sources/".length));
    await handleDeleteDataSource(req, res, id);
    return true;
  }
  if (pathname.startsWith("/data-sources/") && method === "PATCH") {
    const id = decodeURIComponent(pathname.slice("/data-sources/".length));
    await handleUpdateDataSource(req, res, id);
    return true;
  }

  // --- Tools (entity attribute) ---
  if (pathname === "/tools" && method === "GET") {
    await handleListTools(req, res, url);
    return true;
  }
  if (pathname === "/tools" && method === "POST") {
    await handleCreateTool(req, res);
    return true;
  }
  if (pathname.startsWith("/tools/") && method === "DELETE") {
    const id = decodeURIComponent(pathname.slice("/tools/".length));
    await handleDeleteTool(req, res, id);
    return true;
  }
  if (pathname.startsWith("/tools/") && method === "PATCH") {
    const id = decodeURIComponent(pathname.slice("/tools/".length));
    await handleUpdateTool(req, res, id);
    return true;
  }

  // --- Nodes (compound paths first) ---
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
  if (pathname.startsWith("/nodes/") && method === "GET") {
    await handleGetNode(req, res, decodeURIComponent(pathname.slice("/nodes/".length)));
    return true;
  }
  if (pathname.startsWith("/nodes/") && method === "PATCH") {
    await handlePatchNode(req, res, decodeURIComponent(pathname.slice("/nodes/".length)));
    return true;
  }
  if (pathname.startsWith("/nodes/") && method === "DELETE") {
    await handleDeleteNode(req, res, decodeURIComponent(pathname.slice("/nodes/".length)));
    return true;
  }

  // --- Edges ---
  if (pathname === "/edges" && method === "POST") {
    await handleCreateEdge(req, res);
    return true;
  }
  if (pathname.startsWith("/edges/") && method === "DELETE") {
    await handleDeleteEdge(req, res, decodeURIComponent(pathname.slice("/edges/".length)));
    return true;
  }

  // --- Events ---
  if (pathname === "/events" && method === "POST") {
    await handleCreateEvent(req, res);
    return true;
  }
  if (pathname.startsWith("/events/") && method === "PATCH") {
    await handleUpdateEvent(req, res, decodeURIComponent(pathname.slice("/events/".length)));
    return true;
  }
  if (pathname.startsWith("/events/") && method === "DELETE") {
    await handleArchiveEvent(req, res, decodeURIComponent(pathname.slice("/events/".length)));
    return true;
  }

  return false;
}
