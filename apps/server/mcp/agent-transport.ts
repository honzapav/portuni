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
  ElicitRequestSchema,
  isInitializeRequest,
  type ClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { parseBody, RequestBodyTooLargeError } from "../http/middleware.js";
import type { RequestIdentity } from "../auth/request-identity.js";
import type { McpTransport } from "./transport.js";
import { INSTRUCTIONS } from "./server.js";
import { parseHomeNodeIdFromUrl } from "./auto-seed.js";
import { nodeConsentPrompt, type SessionType } from "./scope.js";
import {
  LOCAL_TOOLS,
  callLocalTool,
  enrichGetNodeResult,
  enrichGetContextResult,
  isProxiedDiskMutation,
  localToolWriteTargets,
  snapshotForDiskMutation,
  applyLocalAfterSnapshot,
  applyLocalAfterProxiedMutation,
  deriveOrNull,
} from "./agent-tools.js";
import { awaitPendingPush } from "../domain/sync/pending-pushes.js";
import {
  guardWrite,
  writeGuardError,
  WRITE_SCOPE_WHY,
  type WriteContext,
} from "../domain/write-gate.js";
import { createElicitorFromServer, AGENT_RELAY_ELICIT_TIMEOUT_MS } from "./elicit.js";
import { CentralHttpError, type CentralClient } from "../domain/sync/central/client.js";
import { spawnSessionIdFromHeader } from "../domain/sessions.js";
import { readNodeFileOrPath, type RemoteRawFetch } from "../domain/read-node-file.js";
import { getMirrorPath } from "../domain/sync/mirror-registry.js";

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
  homeNodeId: string | null;
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

// The first request on a brand-new session is required to be `initialize`
// (refused otherwise -- see the isInitializeRequest guard in handle(),
// BEFORE this is called), and its params carry the real downstream client's
// declared capabilities. Peeking at the already-parsed body here -- before
// opening the upstream connection -- is what lets that upstream connection
// advertise the SAME capabilities (elicitation in particular) instead of
// the historical `capabilities: {}`, so central knows it can send the
// agent-mode session an elicitation request at all.
function extractDownstreamCapabilities(body: unknown): ClientCapabilities | undefined {
  const msg = Array.isArray(body) ? body[0] : body;
  if (
    msg !== null &&
    typeof msg === "object" &&
    (msg as { method?: unknown }).method === "initialize"
  ) {
    const params = (msg as { params?: { capabilities?: ClientCapabilities } }).params;
    return params?.capabilities;
  }
  return undefined;
}

// Advertise upstream only the capabilities this front door can actually
// relay in the reverse direction. Today that is elicitation alone (the
// setRequestHandler(ElicitRequestSchema, ...) reverse path in
// buildAgentServer below); forwarding the whole downstream capabilities
// object made central believe e.g. sampling/createMessage or roots/list were
// available here too, and a central-initiated request for either would fail
// with "method not found" instead of never being offered.
function relayableCapabilities(caps: ClientCapabilities | undefined): ClientCapabilities {
  return caps?.elicitation ? { elicitation: caps.elicitation } : {};
}

// The downstream spawn-id header a direct connection's transport.ts already
// reads for its own session row -- forwarded upstream unchanged so central's
// own session row for this connection binds the same way (runner batch Rule
// 2, "the session exists before the runner").
interface UpstreamHeaders {
  spawnSessionId: string | null;
}

async function openUpstream(
  opts: AgentTransportOpts,
  homeNodeId: string | null,
  downstreamCapabilities: ClientCapabilities | undefined,
  forward: UpstreamHeaders,
): Promise<Client> {
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.centralToken}` };
  if (forward.spawnSessionId) headers["X-Portuni-Spawn-Id"] = forward.spawnSessionId;
  const transport = new StreamableHTTPClientTransport(
    upstreamUrl(opts.centralUrl, homeNodeId),
    {
      requestInit: { headers },
    },
  );
  const client = new Client(
    { name: "portuni-agent-upstream", version: "0.1.0" },
    { capabilities: relayableCapabilities(downstreamCapabilities) },
  );
  await client.connect(transport);
  return client;
}

// Session type for the LOCAL_TOOLS write gate below. This is deliberately
// NOT mcp/scope.ts's deriveSessionType(identity, homeNodeId): that function
// treats identity.via === "env" as the exempt, unscoped solo-desktop-UI
// case -- but every connection reaching THIS front door is, by construction,
// a desktop-spawned terminal (this transport serves only /mcp, carries
// ?home_node_id, and is never reached by the webview's own REST calls), so
// it is always a real scoped session. It just never has a chance to prove
// that through identity.via: the sidecar's own local HTTP server defaults
// to PORTUNI_AUTH_MODE=env for agent mode too, so identity.via is "env"
// here regardless of what actually spawned the connection. Falling through
// to deriveSessionType's "env" case would make guardWrite allow every
// LOCAL_TOOLS write unconditionally -- the gate above would never fire in
// production. headless/oauth_grant are kept for forward compatibility (a
// future auth mode that resolves real identities for this front door) but
// are not reachable today.
function deriveAgentSessionType(identity: RequestIdentity): SessionType {
  if (identity.via === "oauth_grant") return "interactive_chat";
  if (identity.headless) return "headless";
  return "interactive_task";
}

// Raw-byte fetch for readNodeFileOrPath's no-local-mirror branch, backed by
// CentralClient's REST endpoint (GET /nodes/:id/file?encoding=base64) rather
// than a graph db -- this front door has none. Maps the same
// FileContentErrorCode central's REST layer surfaces onto the RemoteRawFetch
// error shape.
function fetchRemoteRawViaCentral(client: CentralClient): RemoteRawFetch {
  return async (nodeId, relPath) => {
    try {
      const r = await client.getFileRaw(nodeId, relPath);
      return { kind: "ok", bytes: r.bytes };
    } catch (e) {
      if (e instanceof CentralHttpError) {
        switch (e.code) {
          case "NOT_FOUND":
          case "INVALID_PATH":
            return { kind: "not_found" };
          case "NO_REMOTE":
            return { kind: "no_remote" };
          case "NOT_EDITABLE":
            return { kind: "native_format" };
          default:
            break;
        }
      }
      throw e;
    }
  };
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
  downstreamCapabilities: ClientCapabilities | undefined,
): Server {
  const server = new Server(
    { name: "portuni-agent", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  const elicitor = createElicitorFromServer(server);

  // Reverse path for server-initiated elicitation: central (reached via
  // `upstream`, a Client from this process's point of view) sends an
  // `elicitation/create` request when a graph-plane tool call hits an
  // "elicit" classification. Without this handler the upstream Client has
  // no way to answer it, even though openUpstream() now advertises the real
  // downstream client's capabilities (so central believes it can ask).
  // Forwarding to server.elicitInput() relays the dialog one hop further
  // down to the actual connected client (the real CLI), and its answer
  // flows back up through this same chain to unblock central's call.
  // Only registered when the real client actually declared elicitation --
  // the Client class asserts its own registered capabilities include it
  // before allowing this handler at all, matching the capabilities
  // openUpstream() just advertised upstream (see extractDownstreamCapabilities).
  if (downstreamCapabilities?.elicitation) {
    upstream.setRequestHandler(ElicitRequestSchema, async (request) =>
      server.elicitInput(request.params, { timeout: AGENT_RELAY_ELICIT_TIMEOUT_MS }),
    );
  }

  // Write context for the LOCAL_TOOLS gate below. Built once per session
  // (this function runs once per local MCP session -- see
  // createAgentMcpTransport) rather than once per tool call, so writableNodes
  // accumulates accepted elicitation grants across the session's lifetime:
  // an accepted write dialog for a node is remembered, and a later write to
  // the same node is allowed without re-prompting. No SessionScope exists at
  // this layer (the local sidecar has no graph DB / expansion history, so
  // there is no session_scope row to persist into either) -- this in-memory
  // set, scoped to the local session's own lifetime (same TTL/GC as the rest
  // of AgentSessionEntry), is the front door's equivalent.
  const sessionType = deriveAgentSessionType(identity);
  const writableNodes = new Set<string>();
  const writeCtx: WriteContext = { sessionType, homeNodeId, writableNodes };

  server.setRequestHandler(ListToolsRequestSchema, async () => upstream.listTools());

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (LOCAL_TOOLS.has(name)) {
      // LOCAL_TOOLS never reach apps/server/mcp/tools/*.ts (they dispatch
      // straight to CentralClient/REST from here), so the domain-layer write
      // gate every other mutating tool goes through has to be applied here
      // instead -- otherwise it is bypassed.
      const writeTargets = await localToolWriteTargets(opts.client, identity.userId, name, args);
      for (const nodeId of writeTargets) {
        const outcome = guardWrite(writeCtx, nodeId);
        if (outcome.kind === "allow") continue;
        // Same fallback rule as guardNodeWrite (mcp/write-gate.ts): try a
        // real dialog for "elicit" (never headless, guardWrite only
        // refuses that outright), otherwise fall back to the structured
        // refusal.
        // This front door has no graph DB (see the note above), so the
        // prompt cannot name the node -- but it still must not show the
        // human the agent-facing expand_scope instructions.
        let elicitationSupported: boolean | undefined;
        if (outcome.kind === "elicit") {
          const dialogOutcome = await elicitor.confirm(
            nodeConsentPrompt("write to", nodeId, { name: null, type: null }, WRITE_SCOPE_WHY),
          );
          if (dialogOutcome === "accept") {
            writableNodes.add(nodeId);
            continue;
          }
          // Same honest-hint rule as guardNodeWrite (mcp/write-gate.ts): a
          // client without the elicitation capability must not be told to
          // call portuni_expand_scope(writable: true), which is refused
          // for it.
          elicitationSupported = dialogOutcome !== "unsupported";
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                writeGuardError(nodeId, outcome.kind, outcome.agentHint, { elicitationSupported }),
              ),
            },
          ],
          isError: true,
        };
      }
      try {
        return await callLocalTool(opts.client, identity.userId, name, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    }
    // Delete/move/rename proxy their record step to central, but the local
    // disk step must run HERE -- central has no device mirrors, so without
    // this the file survives on disk and a later scan resurrects it (GH #78).
    // Snapshot before the proxy (afterwards the record is gone), apply after
    // a successful result. Best-effort: a failure degrades to the tombstone
    // reconciliation path instead of blocking the mutation.
    if (isProxiedDiskMutation(name)) {
      const snapshot = await snapshotForDiskMutation(
        opts.client,
        identity.userId,
        name,
        args,
      ).catch(() => null);
      // #277 finding 8: a create's background push (agent-router.ts's
      // POST /nodes/:id/files, #266) answers before its adapter.put lands,
      // tracked per local path so a later mutation on the same file waits
      // for it first. That tracking used to be visible only to
      // agent-router.ts's OWN REST handlers -- an MCP portuni_delete_file/
      // portuni_move_file call reaching this proxied-mutation path had no
      // way to see it, so the exact same race (a delayed put landing after
      // the record is already gone/moved, resurrecting it as an orphan)
      // was reachable through the MCP tool path even though the REST path
      // already guarded against it. pending-pushes.ts is now shared by
      // both dispatchers.
      if (snapshot?.oldRemotePath) {
        const localPath = deriveOrNull({
          mirrorRoot: snapshot.mirrorRoot,
          nodeRoot: snapshot.nodeRoot,
          remotePath: snapshot.oldRemotePath,
        });
        if (localPath) await awaitPendingPush(localPath);
      }
      const result = (await upstream.callTool({ name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const textPart = result.content?.find((c) => c.type === "text");
      if (snapshot && !result.isError && textPart?.text) {
        const rewritten = await applyLocalAfterProxiedMutation(
          opts.client,
          identity.userId,
          snapshot,
          textPart.text,
        ).catch((e) => {
          console.error(`[portuni:agent] local disk step after ${name} failed:`, e);
          return null;
        });
        // The device's local step outcome replaces central's (which has no
        // mirror and would report local_done:false for every move).
        if (rewritten !== null) textPart.text = rewritten;
      }
      return result;
    }
    // Snapshot runs on central (it holds the Drive credentials) and creates
    // the exported file remote-direct; pull it into this device's mirror so
    // the agent gets a real local_path (null when the node is not mirrored
    // here).
    if (name === "portuni_snapshot") {
      const result = (await upstream.callTool({ name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const textPart = result.content?.find((c) => c.type === "text");
      if (!result.isError && textPart?.text) {
        const rewritten = await applyLocalAfterSnapshot(
          opts.client,
          identity.userId,
          args,
          textPart.text,
        ).catch((e) => {
          console.error(`[portuni:agent] local pull after ${name} failed:`, e);
          return null;
        });
        if (rewritten !== null) textPart.text = rewritten;
      }
      return result;
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
    // scope, so gating on it would let an agent read out-of-scope nodes.
    // When the device holds no mirror of the node, the raw bytes are fetched
    // straight from central over REST (CentralClient.getFileRaw, uncapped --
    // unlike an MCP tool result) instead of proxying the tools/call: that lets
    // an oversized/as_path file be written to a plain temp file on this
    // device, which a plain proxy could never do since central has no device
    // filesystem of its own to write into.
    if (name === "portuni_read_file") {
      const gate = (await upstream.callTool({
        name: "portuni_get_node",
        arguments: { node_id: args.node_id },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      if (gate.isError) return gate;
      return readNodeFileOrPath({
        userId: identity.userId,
        nodeId: args.node_id as string,
        relPath: args.path as string,
        asPath: args.as_path === true,
        remote: fetchRemoteRawViaCentral(opts.client),
      });
    }
    // expand_scope is otherwise proxied verbatim (falls to the generic
    // upstream.callTool below), but central has no device filesystem, so its
    // own `readable` field is structurally useless in agent mode -- overlay
    // this device's own mirror lookup of each accepted node instead.
    if (name === "portuni_expand_scope") {
      const result = (await upstream.callTool({ name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      if (result.isError) return result;
      const textPart = result.content?.find((c) => c.type === "text");
      if (textPart?.text) {
        try {
          const payload = JSON.parse(textPart.text) as Record<string, unknown>;
          const added = Array.isArray(payload.added) ? (payload.added as string[]) : [];
          const readable: Record<string, string> = {};
          await Promise.all(
            added.map(async (id) => {
              const mirror = await getMirrorPath(identity.userId, id);
              if (mirror) readable[id] = mirror;
            }),
          );
          payload.readable = readable;
          textPart.text = JSON.stringify(payload);
        } catch {
          /* unexpected shape -- pass through unchanged */
        }
      }
      return result;
    }
    if (name === "portuni_get_node") {
      const result = await upstream.callTool({ name, arguments: args });
      return enrichGetNodeResult(opts.client, identity.userId, result as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      });
    }
    if (name === "portuni_get_context") {
      const result = await upstream.callTool({ name, arguments: args });
      return enrichGetContextResult(identity.userId, result as {
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

      // #272: refuse a non-initialize first request BEFORE opening the
      // upstream connection. openUpstream()'s client.connect() always
      // issues its own genuine initialize handshake to central, regardless
      // of what the downstream request actually was -- so without this
      // check, a protocol/version probe or any other non-initialize first
      // request from the local terminal (which the downstream SDK would
      // reject anyway, but only after the upstream is already open) burned
      // a real session row on central for traffic that never became a
      // session on this side. Same JSON-RPC error shape the downstream
      // transport itself uses for this case ("Server not initialized").
      if (!isInitializeRequest(Array.isArray(body) ? body[0] : body)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Server not initialized" },
            id: null,
          }),
        );
        return;
      }

      // Lazily open the upstream client for this new session. Forward the
      // connection's home_node_id so central auto-seeds scope. A dead
      // upstream is a 503 with the underlying reason (same contract as the
      // auto-seed 503 in transport.ts) rather than an empty-scope session.
      const homeNodeId = parseHomeNodeIdFromUrl(req.url);
      const downstreamCapabilities = extractDownstreamCapabilities(body);
      // Same header transport.ts reads for its own (direct-connection)
      // session row -- forwarded upstream so central's row for this
      // connection binds the same way (runner batch Rule 2).
      const spawnSessionIdHeader = spawnSessionIdFromHeader(req.headers["x-portuni-spawn-id"]);
      try {
        upstream = await openUpstream(opts, homeNodeId, downstreamCapabilities, {
          spawnSessionId: spawnSessionIdHeader,
        });
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
            homeNodeId,
          });
        },
      });

      // Each transport owns exactly one upstream client: whenever the local
      // side closes (explicit close, GC, orphan cleanup), the upstream
      // session goes with it.
      transport.onclose = () => {
        const closedSessionId = transport.sessionId;
        if (closedSessionId) sessions.delete(closedSessionId);
        up.close().catch(() => undefined);
      };

      const server = buildAgentServer(opts, up, identity, homeNodeId, downstreamCapabilities);
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
