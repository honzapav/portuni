// Minimum GlobalScope required to call each MCP tool or REST route.
// Tool names must be exhaustive — createMcpServer throws at registration
// time for any tool missing from this map, so the test suite catches gaps.

import type { GlobalScope } from "./roles.js";
import { scopeAtLeast } from "./roles.js";

// ---------------------------------------------------------------------------
// MCP tool minimum scopes
// ---------------------------------------------------------------------------

export const TOOL_MIN_SCOPE: Record<string, GlobalScope> = {
  // --- read ---
  portuni_get_context: "read",
  portuni_get_node: "read",
  portuni_get_actor: "read",
  portuni_list_nodes: "read",
  portuni_list_events: "read",
  portuni_list_files: "read",
  portuni_read_file: "read",
  portuni_list_actors: "read",
  portuni_list_responsibilities: "read",
  portuni_list_data_sources: "read",
  portuni_list_tools: "read",
  portuni_list_remotes: "read",
  portuni_status: "read",
  portuni_session_init: "read",
  portuni_session_log: "read",
  portuni_expand_scope: "read",
  // portuni_resolve closes/finalises an event — it mutates state, so write.
  portuni_resolve: "write",

  // --- write ---
  portuni_log: "write",
  portuni_store: "write",
  portuni_supersede: "write",
  portuni_snapshot: "write",
  portuni_pull: "write",
  portuni_mirror: "write",
  portuni_move_file: "write",
  portuni_adopt_files: "write",
  portuni_rename_folder: "write",

  // --- manage ---
  portuni_create_node: "manage",
  portuni_update_node: "manage",
  portuni_move_node: "manage",
  portuni_connect: "manage",
  portuni_disconnect: "manage",
  portuni_create_actor: "manage",
  portuni_update_actor: "manage",
  portuni_create_responsibility: "manage",
  portuni_update_responsibility: "manage",
  portuni_assign_responsibility: "manage",
  portuni_unassign_responsibility: "manage",
  portuni_add_data_source: "manage",
  portuni_remove_data_source: "manage",
  portuni_add_tool: "manage",
  portuni_remove_tool: "manage",
  portuni_set_routing_policy: "manage",
  portuni_setup_remote: "manage",

  // --- admin ---
  portuni_delete_node: "admin",
  portuni_delete_actor: "admin",
  portuni_delete_responsibility: "admin",
  portuni_delete_file: "admin",
};

// ---------------------------------------------------------------------------
// REST route minimum scope matcher
// ---------------------------------------------------------------------------

// Returns the minimum GlobalScope required for a given HTTP method + path.
// Defaults to "admin" for any unmatched route (fail-closed).
export function minScopeForRoute(method: string, pathname: string): GlobalScope {
  const m = method.toUpperCase();

  // --- Public / read-only system routes ---
  if (pathname === "/health") return "read";
  if (pathname === "/mcp/info") return "read";
  if (pathname === "/auth/login") return "read";
  if (pathname === "/auth/groups" && m === "GET") return "manage";
  if (pathname === "/auth/users" && m === "GET") return "manage";
  if (pathname === "/auth/users/admin" && m === "GET") return "admin";
  if (pathname === "/auth/users/invite" && m === "POST") return "admin";
  if (pathname === "/me" && m === "GET") return "read";
  if (pathname === "/graph" && m === "GET") return "read";
  if (pathname === "/scope" && m === "GET") return "read";
  // GET /users backs the OwnerPicker dropdown (apps/server/api/users.ts).
  // Its only frontend call site is ActorModal's user_id picker
  // (apps/web/src/components/ActorsPage.tsx), and that assignment can only
  // ever be persisted via POST/PATCH /actors, both already manage-gated --
  // a read-scope user opening the picker could browse the full workspace
  // user directory (email/name/avatar for everyone) but could never save
  // anything with it. Raised from "read" so that directory listing isn't
  // handed out more broadly than the one flow that can use it.
  if (pathname === "/users" && m === "GET") return "manage";
  if (pathname === "/sync/pending" && m === "GET") return "read";

  // --- Google Drive connect (Settings -> Synchronizace) ---
  // Configuring, inspecting, or tearing down the Drive remote is the REST
  // equivalent of portuni_setup_remote / portuni_set_routing_policy (both
  // "manage"). Kept at "manage" for the whole surface — including the GET
  // status/targets and POST test — since all six only exist to drive that
  // one configuration flow, and there is no read-only consumer of them.
  if (pathname.startsWith("/sync/drive/")) return "manage";

  // --- Device tokens ---
  if (pathname === "/device-tokens" && m === "GET") return "read";
  if (pathname === "/device-tokens" && m === "POST") return "write";
  if (pathname.startsWith("/device-tokens/") && m === "DELETE") return "write";

  // --- Events (POST = log event = write; PATCH = update = write; DELETE = archive = write) ---
  if (pathname === "/events" && m === "POST") return "write";
  if (pathname.startsWith("/events/") && m === "PATCH") return "write";
  if (pathname.startsWith("/events/") && m === "DELETE") return "write";

  // --- File content ---
  if (/^\/nodes\/[^/]+\/file$/.test(pathname) && m === "GET") return "read";
  if (/^\/nodes\/[^/]+\/file$/.test(pathname) && m === "PUT") return "write";
  if (/^\/nodes\/[^/]+\/sync-info$/.test(pathname) && m === "GET") return "read";
  if (pathname === "/sync/info-batch" && m === "POST") return "read";
  if (/^\/nodes\/[^/]+\/files\/register$/.test(pathname) && m === "POST") return "write";
  if (/^\/nodes\/[^/]+\/files\/register-batch$/.test(pathname) && m === "POST") return "write";
  if (/^\/nodes\/[^/]+\/files$/.test(pathname) && m === "POST") return "write";
  if (/^\/nodes\/[^/]+\/files\/[^/]+\/rename$/.test(pathname) && m === "POST") return "write";
  if (/^\/nodes\/[^/]+\/files\/[^/]+$/.test(pathname) && m === "DELETE") return "admin";

  // --- Sync/mirror triggers ---
  if (/^\/nodes\/[^/]+\/sync$/.test(pathname) && m === "POST") return "manage";
  if (/^\/nodes\/[^/]+\/mirror$/.test(pathname) && m === "POST") return "manage";

  // --- Nodes ---
  if (pathname === "/nodes" && m === "POST") return "manage";
  if (/^\/nodes\/[^/]+$/.test(pathname) && m === "GET") return "read";
  if (/^\/nodes\/[^/]+$/.test(pathname) && m === "PATCH") return "manage";
  if (/^\/nodes\/[^/]+$/.test(pathname) && m === "DELETE") return "admin";
  if (/^\/nodes\/[^/]+\/move$/.test(pathname) && m === "POST") return "manage";
  if (/^\/nodes\/[^/]+\/access$/.test(pathname) && m === "GET") return "read";
  if (/^\/nodes\/[^/]+\/access$/.test(pathname) && m === "PUT") return "manage";
  if (/^\/nodes\/[^/]+\/sync-status$/.test(pathname) && m === "GET") return "read";
  if (/^\/nodes\/[^/]+\/folder-url$/.test(pathname) && m === "GET") return "read";
  if (/^\/nodes\/[^/]+\/file-url$/.test(pathname) && m === "GET") return "read";
  if (pathname === "/positions" && m === "POST") return "manage";

  // --- Edges ---
  if (pathname === "/edges" && m === "POST") return "manage";
  if (pathname.startsWith("/edges/") && m === "DELETE") return "manage";

  // --- Actors ---
  if (pathname === "/actors" && m === "GET") return "read";
  if (pathname === "/actors" && m === "POST") return "manage";
  if (pathname.startsWith("/actors/") && m === "PATCH") return "manage";
  if (pathname.startsWith("/actors/") && m === "DELETE") return "admin";

  // --- Responsibilities & assignments ---
  if (pathname === "/responsibilities" && m === "GET") return "read";
  if (pathname === "/responsibilities" && m === "POST") return "manage";
  if (/^\/responsibilities\/[^/]+\/assignments$/.test(pathname) && m === "POST") return "manage";
  if (/^\/responsibilities\/[^/]+\/assignments\/[^/]+$/.test(pathname) && m === "DELETE") return "manage";
  if (pathname.startsWith("/responsibilities/") && m === "PATCH") return "manage";
  if (pathname.startsWith("/responsibilities/") && m === "DELETE") return "admin";

  // --- Data sources ---
  if (pathname === "/data-sources" && m === "GET") return "read";
  if (pathname === "/data-sources" && m === "POST") return "manage";
  if (pathname.startsWith("/data-sources/") && m === "PATCH") return "manage";
  if (pathname.startsWith("/data-sources/") && m === "DELETE") return "admin";

  // --- Tools (entity attribute) ---
  if (pathname === "/tools" && m === "GET") return "read";
  if (pathname === "/tools" && m === "POST") return "manage";
  if (pathname.startsWith("/tools/") && m === "PATCH") return "manage";
  if (pathname.startsWith("/tools/") && m === "DELETE") return "admin";

  // --- Fail-closed: unknown future routes require admin ---
  return "admin";
}

// ---------------------------------------------------------------------------
// Utility: decide allow/deny for REST without importing HTTP machinery
// ---------------------------------------------------------------------------

export interface RouteGateResult {
  allowed: boolean;
  required: GlobalScope;
}

export function gateRoute(
  identity: { globalScope: GlobalScope },
  method: string,
  pathname: string,
): RouteGateResult {
  const required = minScopeForRoute(method, pathname);
  return { allowed: scopeAtLeast(identity.globalScope, required), required };
}
