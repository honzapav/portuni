// MCP front door for central-mode agent sessions. Terminals spawned by the
// desktop app in agent mode connect here (the local sidecar), not directly
// to central, so the five device-local tools (mirror create, file copy-in/
// upload/download, local discovery -- see agent-tools.ts) run on the device
// that owns the mirror. Everything else is proxied to the central MCP server
// unchanged, so the agent sees the same graph/registry/scope surface a
// central session would.
//
// Design:
//   - Per local MCP session, lazily open ONE upstream `Client` connected to
//     `${centralUrl}/mcp` with `Authorization: Bearer ${centralToken}`. The
//     local connection's `?home_node_id=...` query param is forwarded onto
//     the upstream URL so central auto-seeds scope exactly as a direct
//     session would.
//   - The local side is served by the low-level SDK `Server` (not McpServer)
//     with explicit request handlers:
//       * initialize   -- handled by the Server constructor (server info
//         {name:"portuni-agent"} + the shared INSTRUCTIONS string).
//       * tools/list    -- `upstream.listTools()` verbatim (central registry
//         is the source of truth; LOCAL_TOOLS names exist there with
//         identical schemas since it is the same codebase).
//       * tools/call    -- LOCAL_TOOLS.has(name) -> callLocalTool on-device;
//         else `upstream.callTool` verbatim.
//       * resources/list + resources/read -- proxy upstream (static markdown
//         on central; no local divergence).
//   - Session bookkeeping mirrors createMcpTransport() in transport.ts (Map +
//     TTL GC, session pinning by userId). On local session close/GC the
//     upstream client is closed too.
//   - Upstream connect failure -> 503 with the underlying reason (mirrors the
//     auto-seed 503 contract in transport.ts): letting a session start with a
//     dead upstream would surface downstream as opaque tool errors.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { parseBody, RequestBodyTooLargeError } from "../http/middleware.js";
import type { RequestIdentity } from "../auth/request-identity.js";
import type { McpTransport } from "./transport.js";
import { INSTRUCTIONS } from "./server.js";
import { parseHomeNodeIdFromUrl } from "./auto-seed.js";
import {
  LOCAL_TOOLS,
  callLocalTool,
  enrichGetNodeResult,
  enrichGetContextResult,
} from "./agent-tools.js";
import { readNodeFileFromMirror, formatNodeFileContent } from "../domain/read-node-file.js";
import type { CentralClient } from "../domain/sync/central/client.js";

const MAX_SESSIONS = Number(process.env.PORTUNI_MAX_SESSIONS ?? 100);
const SESSION_TTL_MS = Number(process.env.PORTUNI_SESSION_TTL_MS ?? 30 * 60 * 1000);
const SESSION_GC_INTERVAL_MS = Number(
  process.env.PORTUNI_SESSION_GC_INTERVAL_MS ?? 60 * 1000,
);

interface AgentSessionEntry {
  transport: StreamableHTTPServerTransport;
  upstream: Client;
  lastUsedAt: number;
  userId: string;
}

export interface AgentTransportOpts {
  client: CentralClient;
  centralUrl: string;
  centralToken: string;
}

// Build the upstream URL: `${centralUrl}/mcp`, carrying the local
// connection's `?home_node_id=...` forward so central auto-seeds scope.
function upstreamUrl(centralUrl: string, homeNodeId: string | null): URL {
  const url = new URL("/mcp", centralUrl);
  if (homeNodeId) url.searchParams.set("home_node_id", homeNodeId);
  return url;
}

async function openUpstream(
  opts: AgentTransportOpts,
  homeNodeId: string | null,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    upstreamUrl(opts.centralUrl, homeNodeId),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${opts.centralToken}` },
      },
    },
  );
  const client = new Client(
    { name: "portuni-agent-upstream", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

// Low-level server wired to proxy tools/list + resources/* upstream and to
// route tools/call by LOCAL_TOOLS membership. tools/call must convert any
// uncaught throw from callLocalTool (e.g. "no local mirror" from
// storeFileCentral, which is a plain Error callLocalTool does not catch) into
// an isError result -- the same contract McpServer gives central sessions.
function buildAgentServer(
  opts: AgentTransportOpts,
  upstream: Client,
  identity: RequestIdentity,
  homeNodeId: string | null,
): Server {
  const server = new Server(
    { name: "portuni-agent", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => upstream.listTools());

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (LOCAL_TOOLS.has(name)) {
      try {
        return await callLocalTool(opts.client, identity.userId, name, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    }
    // Graph reads proxy to central verbatim, but central has no device state,
    // so portuni_get_node comes back with local_mirror:null. Overlay the
    // device mirror here so an agent in central mode sees the same
    // registration metadata a local session would.
    // Content read for ad-hoc nodes, served from THIS device's mirror (the
    // file is on disk here in teammate mode) -- but scope + visibility MUST be
    // enforced first, and the device has no graph DB to run guardNodeRead. So
    // gate on central via get_node: a successful call means the node is in (or
    // was just auto-added to) scope with the same guardNodeRead semantics the
    // local tool uses; an elicit/not_found error means it is not, and we return
    // that error verbatim (telling the agent to expand_scope). Mirror-presence
    // alone is NOT sufficient -- the device mirrors a superset of the session
    // scope, so gating on it would let an agent read out-of-scope nodes and
    // bypass the seatbelt boundary.
    if (name === "portuni_read_file") {
      const gate = (await upstream.callTool({
        name: "portuni_get_node",
        arguments: { node_id: args.node_id },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      if (gate.isError) return gate;
      const r = await readNodeFileFromMirror(
        identity.userId,
        args.node_id as string,
        args.path as string,
      );
      return formatNodeFileContent(r, args.path as string);
    }
    if (name === "portuni_get_node") {
      const result = await upstream.callTool({ name, arguments: args });
      return enrichGetNodeResult(opts.client, identity.userId, homeNodeId, result as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      });
    }
    if (name === "portuni_get_context") {
      const result = await upstream.callTool({ name, arguments: args });
      return enrichGetContextResult(opts.client, identity.userId, homeNodeId, result as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      });
    }
    return upstream.callTool({ name, arguments: args });
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => upstream.listResources());

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    upstream.readResource({ uri: request.params.uri }),
  );

  return server;
}

export function createAgentMcpTransport(opts: AgentTransportOpts): McpTransport {
  const sessions = new Map<string, AgentSessionEntry>();

  const closeEntry = (entry: AgentSessionEntry): void => {
    entry.transport.close().catch(() => undefined);
    entry.upstream.close().catch(() => undefined);
  };

  const sessionGc = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, entry] of sessions) {
      if (entry.lastUsedAt < cutoff) {
        sessions.delete(id);
        closeEntry(entry);
      }
    }
  }, SESSION_GC_INTERVAL_MS);
  sessionGc.unref?.();

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    identity: RequestIdentity,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Pre-registration leak guard: the upstream Client is opened BEFORE the
    // session entry exists (storage happens in onsessioninitialized during a
    // successful initialize). If the first request is not an initialize, or
    // anything throws before that callback fires, no session entry ever
    // references the client -- onclose/GC/shutdown would never close it. Track
    // the client and whether it got adopted by a session so every early-exit
    // path below can close the orphan.
    let upstream: Client | null = null;
    let tracked = false;

    let body: unknown;
    try {
      body = await parseBody(req);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    try {
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        // Session pinning: reject cross-user session reuse.
        if (existing.userId !== identity.userId) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session belongs to a different user" }));
          return;
        }
        existing.lastUsedAt = Date.now();
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      if (sessionId && !existing) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      if (sessions.size >= MAX_SESSIONS) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session capacity reached" }));
        return;
      }

      // Lazily open the upstream client for this new session. Forward the
      // connection's home_node_id so central auto-seeds scope. A dead
      // upstream is a 503 with the underlying reason (same contract as the
      // auto-seed 503 in transport.ts) rather than an empty-scope session.
      const homeNodeId = parseHomeNodeIdFromUrl(req.url);
      try {
        upstream = await openUpstream(opts, homeNodeId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error("Agent MCP upstream connect failed:", err);
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Central MCP server unreachable; refusing to start agent session",
            reason,
          }),
        );
        return;
      }

      const up = upstream;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          tracked = true;
          sessions.set(newSessionId, {
            transport,
            upstream: up,
            lastUsedAt: Date.now(),
            userId: identity.userId,
          });
        },
      });

      // Each transport owns exactly one upstream client: whenever the local
      // side closes (explicit close, GC, orphan cleanup), the upstream
      // session goes with it. close() is idempotent, so overlap with the
      // explicit orphan cleanup below is harmless.
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        up.close().catch(() => undefined);
      };

      const server = buildAgentServer(opts, up, identity, homeNodeId);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);

      if (!tracked) {
        // The request never initialized a session (e.g. a non-initialize
        // first request, which the SDK rejects with 400): without this the
        // freshly opened upstream client would be orphaned forever.
        transport.close().catch(() => undefined);
        up.close().catch(() => undefined);
      }
    } catch (error) {
      console.error("Agent MCP error:", error);
      if (upstream && !tracked) upstream.close().catch(() => undefined);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  }

  function shutdown(): void {
    clearInterval(sessionGc);
    for (const entry of sessions.values()) {
      closeEntry(entry);
    }
    sessions.clear();
  }

  return { handle, shutdown };
}
