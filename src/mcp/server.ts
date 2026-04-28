// Build a fresh McpServer instance with all Portuni tools and resources
// registered and a per-session SessionScope wired through the scope-aware
// tools. Each new MCP HTTP session gets its own server (this is what the
// transport layer calls).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionScope, parseScopeMode } from "./scope.js";
import { registerResources } from "./resources/index.js";
import { registerScopeTools } from "./tools/scope.js";
import { registerNodeTools } from "./tools/nodes.js";
import { registerGetNodeTool } from "./tools/get-node.js";
import { registerEdgeTools } from "./tools/edges.js";
import { registerContextTools } from "./tools/context.js";
import { registerMirrorTools } from "./tools/mirrors.js";
import { registerFileTools } from "./tools/files.js";
import { registerSyncStatusTools } from "./tools/sync-status.js";
import { registerSyncRemoteTools } from "./tools/sync-remotes.js";
import { registerSyncSnapshotTools } from "./tools/sync-snapshot.js";
import { registerEventTools } from "./tools/events.js";
import { registerActorTools } from "./tools/actors.js";
import { registerResponsibilityTools } from "./tools/responsibilities.js";
import { registerEntityAttributeTools } from "./tools/entity-attributes.js";

// Top-level server brief. Kept short -- many MCP clients truncate this
// field at ~2 KB. Anything load-bearing for an individual tool lives in
// that tool's description; deeper reference material lives in the
// portuni:// resources, which the agent pulls on demand.
const INSTRUCTIONS = `Portuni is the organizational knowledge graph (POPP: organizations, projects, processes, areas, principles).
Call portuni_get_context before starting work on a node; portuni_get_node for details and the local mirror path.
For semantics, contracts, and enums fetch resources: portuni://architecture, portuni://sync-model, portuni://scope-rules, portuni://enums.`;

export function createMcpServer(): { server: McpServer; scope: SessionScope } {
  const scope = new SessionScope(parseScopeMode(process.env.PORTUNI_SCOPE_MODE));
  const server = new McpServer(
    { name: "portuni", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  registerResources(server);
  registerScopeTools(server, scope);
  registerNodeTools(server, scope);
  registerGetNodeTool(server, scope);
  registerEdgeTools(server);
  registerContextTools(server, scope);
  registerMirrorTools(server);
  registerFileTools(server, scope);
  registerSyncStatusTools(server);
  registerSyncRemoteTools(server);
  registerSyncSnapshotTools(server);
  registerEventTools(server, scope);
  registerActorTools(server);
  registerResponsibilityTools(server);
  registerEntityAttributeTools(server);
  return { server, scope };
}
