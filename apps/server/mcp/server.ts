// Build a fresh McpServer instance with all Portuni tools and resources
// registered and a per-session SessionScope wired through the scope-aware
// tools. Each new MCP HTTP session gets its own server (this is what the
// transport layer calls).

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionScope, deriveSessionType } from "./scope.js";
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
import { createElicitor, type Elicitor } from "./elicit.js";
import { bindExistingSessionHandshake, bindSessionPersistence } from "./session-persistence.js";
import type { RequestIdentity } from "../auth/request-identity.js";
import { TOOL_MIN_SCOPE } from "../auth/min-scopes.js";
import { scopeAtLeast } from "../auth/roles.js";
import { getDb } from "../infra/db.js";
import { LocalModeNoRemoteError } from "../domain/sync/types.js";

// Top-level server brief. Kept short -- many MCP clients truncate this
// field at ~2 KB. Anything load-bearing for an individual tool lives in
// that tool's description; deeper reference material lives in the
// portuni:// resources, which the agent pulls on demand.
export const INSTRUCTIONS = `Portuni is the organizational knowledge graph (POPP: organizations, projects, processes, areas, principles).
Call portuni_get_context before starting work on a node; portuni_get_node for details and the local mirror path.
Portuni tracks file changes automatically (the desktop app watches each mirror): new files in wip/outputs/resources are registered and edits are reflected without any action from you -- you normally need neither portuni_store nor portuni_status.
portuni_store uploads a file to the remote (a deliberate push); portuni_status forces a sync-state recompute. Reach for them only to push on purpose, or to inspect/repair state where automatic tracking is not active (portuni_status then lists unregistered files as new_local).
For semantics, contracts, and enums fetch resources: portuni://architecture, portuni://sync-model, portuni://scope-rules, portuni://enums.`;

export interface SessionCtx {
  scope: SessionScope;
  identity: RequestIdentity;
  // Optional: absent in most test harnesses that build a SessionCtx by hand,
  // which is equivalent to every confirm() call resolving "unsupported"
  // (the pre-elicitation honor-system fallback). createMcpServer always
  // provides a real one.
  elicit?: Elicitor;
  // Key of the disk area portuni_read_file may spill a mirror-less node's
  // bytes into (#406). It is the MCP TRANSPORT's own session id, not the
  // durable `sessions` row: the transport that owns it removes the
  // directory when it closes, and a durable session can have several live
  // connections. createMcpServer always provides one.
  spillSessionId: string;
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
    groupIds: [],
    via: "env",
  };
}

// A domain error that carries a code is returned as a structured error
// result, so an MCP caller sees the same `code` a REST caller gets from
// respondError (http/middleware.ts) instead of only the message the SDK
// would otherwise wrap an uncaught throw in.
function typedToolError(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  if (err instanceof LocalModeNoRemoteError) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err.message, code: err.code }) }],
      isError: true,
    };
  }
  return null;
}

// Wrap server.tool so every registered tool is guarded by the caller's
// globalScope and its typed domain errors are mapped (typedToolError).
// Installed once before any registerXxxTools call.
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
      try {
        return await handler(...h);
      } catch (err) {
        const typed = typedToolError(err);
        if (typed) return typed;
        throw err;
      }
    };
    return original(...(args as Parameters<typeof original>));
  };
}

// Guides an agent/admin through the service-account path for Google Drive
// sync -- the only path now that collaboration runs through central mode
// (a local workspace cannot route to a remote at all, see #310/#311).
// Surfaced to the model as a slash-style prompt so it can be invoked
// directly instead of being rediscovered from the routing error text every
// time.
function registerSetupDriveRemotePrompt(server: McpServer): void {
  server.prompt(
    "setup-drive-remote",
    "Guide the user through configuring Google Drive file sync (service-account path for servers/admins).",
    () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            "Help me configure Portuni file sync to Google Drive using a service account. " +
            "Walk me through: (1) Google Cloud Console — create/select a project, enable the Drive API, " +
            "create a service account, download its JSON key; (2) share the target shared drive with the " +
            "service account e-mail as Content manager; (3) call portuni_setup_remote with type gdrive, " +
            "config {shared_drive_id}, and the JSON key as service_account_json; (4) call " +
            "portuni_set_routing_policy with [{priority: 1, node_type: null, org_slug: null, remote_name: <name>}] " +
            "unless a policy already exists (check portuni_list_remotes first); (5) verify with a test " +
            "portuni_store and confirm the file appears on the shared drive. This is a central-mode-only " +
            "setup — a local workspace cannot register or route to a remote.",
        },
      }],
    }),
  );
}

// `homeNodeId` is the ?home_node_id query param off the connection URL, when
// present (parsed by the transport before this is called). It feeds
// deriveSessionType so a headless-flagged device token without it can be
// refused at seed time by the caller (transport.ts) before a server/scope
// pair is even built for it.
//
// `resumeSessionId` is the ?resume_session_id query param (#204). When set,
// the caller (transport.ts) is responsible for awaiting
// resumeSessionPersistence itself -- attaching to an existing session must
// be authorized and rehydrated before any tool call, which the fire-and-
// forget bindSessionPersistence path cannot guarantee. This function only
// skips its own bindSessionPersistence call in that case so the two paths
// never race to create/attach the same connection's session row twice.
// `spawnSessionId` is the X-Portuni-Spawn-Id header (transport.ts) -- see
// bindSessionPersistence for what it threads through and why.
//
// `bindSession` is returned rather than called here (#272): a `sessions`
// row must only ever be created once a connection completes a genuine MCP
// handshake, never merely because a server/scope pair was constructed for
// it -- an aborted connection, a client's protocol/version probe, or any
// other non-initialize first request used to leak a permanent `running`
// row that nothing would ever close, since a transport that never reaches
// its own "session initialized" point never fires `onclose` either. The
// caller (transport.ts's onsessioninitialized, stdio-entry.ts's
// server.server.oninitialized) invokes it exactly at that point -- after
// the underlying transport has confirmed a real session exists, not
// before. A resumed connection's row already exists (resumeSessionPersistence,
// awaited by the caller before the connection is allowed to proceed), so
// bindSession is a no-op then.
//
// `boundExistingSessionId` (runner batch, Rule 2 "The session exists before
// the runner"): set when the caller (transport.ts) already resolved
// spawnSessionId to a `running` row this identity owns
// (lookupSpawnSessionForBind) and awaited bindExistingSessionPersistence's
// rehydration on `scope` before this function was even called -- bindSession
// then only fills in the CLI name and touches last_active_at
// (bindExistingSessionHandshake) instead of creating a second row.
//
// `transportSessionId` is the id the caller's own transport will report as
// its MCP session id -- transport.ts/agent-transport.ts generate it up front
// so they can both feed it to their StreamableHTTPServerTransport and key
// this session's read-file spill directory by it (#406). stdio mode has no
// such id and gets a fresh uuid instead; either way the directory is removed
// when the connection closes, and the boot sweep clears whatever a crash
// left behind.
export function createMcpServer(
  identity: RequestIdentity,
  homeNodeId: string | null = null,
  resumeSessionId: string | null = null,
  spawnSessionId: string | null = null,
  boundExistingSessionId: string | null = null,
  transportSessionId: string | null = null,
): { server: McpServer; scope: SessionScope; bindSession: (cli?: string | null) => void } {
  const scope = new SessionScope(deriveSessionType(identity, homeNodeId));
  const bindSession =
    resumeSessionId || boundExistingSessionId
      ? boundExistingSessionId
        ? (cli?: string | null) => bindExistingSessionHandshake(getDb(), boundExistingSessionId, cli)
        : () => undefined
      : (cli?: string | null) =>
          bindSessionPersistence(
            getDb(),
            scope,
            identity,
            homeNodeId,
            spawnSessionId,
            cli,
          );
  const server = new McpServer(
    { name: "portuni", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  const ctx: SessionCtx = {
    scope,
    identity,
    elicit: createElicitor(server),
    spillSessionId: transportSessionId ?? randomUUID(),
  };
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
  registerSetupDriveRemotePrompt(server);
  registerSyncSnapshotTools(server, ctx);
  registerEventTools(server, ctx);
  registerActorTools(server, ctx);
  registerResponsibilityTools(server, ctx);
  registerEntityAttributeTools(server, ctx);
  return { server, scope, bindSession };
}
