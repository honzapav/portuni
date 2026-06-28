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
import type { RequestIdentity } from "../auth/request-identity.js";
import { TOOL_MIN_SCOPE } from "../auth/min-scopes.js";
import { scopeAtLeast } from "../auth/roles.js";

// Top-level server brief. Kept short -- many MCP clients truncate this
// field at ~2 KB. Anything load-bearing for an individual tool lives in
// that tool's description; deeper reference material lives in the
// portuni:// resources, which the agent pulls on demand.
const INSTRUCTIONS = `Portuni is the organizational knowledge graph (POPP: organizations, projects, processes, areas, principles).
Call portuni_get_context before starting work on a node; portuni_get_node for details and the local mirror path.
When you create a new file inside a Portuni mirror via Write/Edit/MultiEdit, your next action MUST be portuni_store for that file. Write alone places bytes on disk but does not register the file -- future sessions, teammates, and the remote will not see it. Treat "create file in mirror" and "call portuni_store" as a single atomic step.
After any file-state mutation (portuni_store, portuni_move_file, portuni_delete_file, portuni_rename_folder, portuni_adopt_files), call portuni_status before ending the turn so disk, DB, and remote stay consistent.
For semantics, contracts, and enums fetch resources: portuni://architecture, portuni://sync-model, portuni://scope-rules, portuni://enums.`;

export interface SessionCtx {
  scope: SessionScope;
  identity: RequestIdentity;
}

// Default identity used when createMcpServer() is called without arguments
// (e.g. in-process test harnesses and stdio mode). The userId string is the
// canonical SOLO_USER value; we use the literal here so this file does not
// import SOLO_USER -- the env-mode binding point is stdio-entry.ts.
export function buildDefaultEnvIdentity(): RequestIdentity {
  return {
    userId: "01SOLO0000000000000000000",
    email: process.env.PORTUNI_USER_EMAIL ?? "solo@localhost",
    name: process.env.PORTUNI_USER_NAME ?? "Solo User",
    globalScope: "admin",
    groups: [],
    via: "env",
  };
}

// Wrap server.tool so every registered tool is guarded by the caller's
// globalScope. Installed once before any registerXxxTools call.
// The registration-time throw (missing map entry) ensures gaps are caught
// immediately rather than at call time.
function gateToolsByScope(server: McpServer, identity: RequestIdentity): void {
  const original = server.tool.bind(server);
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (
    ...args: unknown[]
  ) => {
    const name = args[0] as string;
    const min = TOOL_MIN_SCOPE[name];
    if (min === undefined) {
      throw new Error(`Tool ${name} missing from TOOL_MIN_SCOPE — add it to src/auth/min-scopes.ts`);
    }
    const handlerIdx = args.length - 1;
    const handler = args[handlerIdx] as (...h: unknown[]) => Promise<unknown>;
    args[handlerIdx] = async (...h: unknown[]) => {
      if (!scopeAtLeast(identity.globalScope, min)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "forbidden",
                required_scope: min,
                your_scope: identity.globalScope,
              }),
            },
          ],
          isError: true,
        };
      }
      return handler(...h);
    };
    return original(...(args as Parameters<typeof original>));
  };
}

export function createMcpServer(
  identity: RequestIdentity,
): { server: McpServer; scope: SessionScope } {
  const scope = new SessionScope(parseScopeMode(process.env.PORTUNI_SCOPE_MODE));
  const ctx: SessionCtx = { scope, identity };
  const server = new McpServer(
    { name: "portuni", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  gateToolsByScope(server, identity);
  registerResources(server);
  registerScopeTools(server, ctx);
  registerNodeTools(server, ctx);
  registerGetNodeTool(server, ctx);
  registerEdgeTools(server, ctx);
  registerContextTools(server, ctx);
  registerMirrorTools(server, ctx);
  registerFileTools(server, ctx);
  registerSyncStatusTools(server, ctx);
  registerSyncRemoteTools(server, ctx);
  registerSyncSnapshotTools(server, ctx);
  registerEventTools(server, ctx);
  registerActorTools(server, ctx);
  registerResponsibilityTools(server, ctx);
  registerEntityAttributeTools(server, ctx);
  return { server, scope };
}
