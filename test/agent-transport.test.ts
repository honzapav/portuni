// Agent MCP front-door transport. Verifies the routing contract:
// LOCAL_TOOLS are served on-device (and must NOT reach central), everything
// else is proxied to the central MCP server verbatim. Harness:
//   - a stub upstream McpServer over StreamableHTTP on an ephemeral port,
//     exposing a graph tool (portuni_get_node -> "central-marker") and a
//     local-only tool the central must never actually serve
//     (portuni_mirror -> "CENTRAL SHOULD NOT SERVE THIS");
//   - createAgentMcpTransport mounted on a second ephemeral HTTP server;
//   - a real SDK Client connected to the agent server.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAgentMcpTransport } from "../apps/server/mcp/agent-transport.js";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import type { NodeSyncInfo } from "../apps/server/domain/sync/sync-remote-api.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";

// Minimal CentralClient stub. The routing tests only need the local tools to
// NOT return the central marker; the actual local handlers fail fast (no
// mirror registered), which is exactly the contract under test.
const fakeCentral: CentralClient = {
  async syncInfo(): Promise<NodeSyncInfo> {
    throw new Error("no such node");
  },
  async syncInfoBatch() {
    return [];
  },
  async registerFile() {
    throw new Error("not implemented");
  },
  async registerFiles() {
    return [];
  },
  async getFileRaw() {
    throw new Error("not implemented");
  },
  async putFileRaw() {
    throw new Error("not implemented");
  },
  async dataSources() {
    return [];
  },
  async nodeExists() {
    return false;
  },
  invalidateSyncInfo() {
    /* no cache */
  },
};

const identity: RequestIdentity = {
  userId: "01SOLO0000000000000000000",
  email: "solo@localhost",
  name: "Solo",
  globalScope: "admin",
  groups: [],
  groupIds: [],
  via: "env",
};

function startStubCentral(): Promise<{ base: string; close: () => Promise<void> }> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw.length > 0 ? JSON.parse(raw) : undefined;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      const mcp = new McpServer({ name: "stub-central", version: "0.0.0" });
      mcp.tool(
        "portuni_get_node",
        { node_id: z.string() },
        async () => ({ content: [{ type: "text" as const, text: "central-marker" }] }),
      );
      mcp.tool(
        "portuni_mirror",
        { node_id: z.string(), targets: z.array(z.string()).optional() },
        async () => ({
          content: [{ type: "text" as const, text: "CENTRAL SHOULD NOT SERVE THIS" }],
        }),
      );
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, t),
      });
      await mcp.connect(t);
      transport = t;
    }
    await transport.handleRequest(req, res, body);
  });
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            for (const t of sessions.values()) t.close().catch(() => undefined);
            httpServer.close(() => r());
          }),
      });
    });
  });
}

let workspace: string;
let central: { base: string; close: () => Promise<void> };
let agentServer: Server;
let agentTransport: ReturnType<typeof createAgentMcpTransport>;
let localClient: Client;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-agenttransport-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();

  central = await startStubCentral();
  agentTransport = createAgentMcpTransport({
    client: fakeCentral,
    centralUrl: central.base,
    centralToken: "test-token",
  });
  agentServer = createServer((req, res) => {
    void agentTransport.handle(req, res, identity);
  });
  await new Promise<void>((r) => agentServer.listen(0, "127.0.0.1", r));
  const addr = agentServer.address() as AddressInfo;
  const agentBase = `http://127.0.0.1:${addr.port}`;

  localClient = new Client({ name: "agent-transport-test", version: "0.0.0" });
  await localClient.connect(new StreamableHTTPClientTransport(new URL(`${agentBase}/mcp`)));
});

after(async () => {
  await localClient.close().catch(() => undefined);
  agentTransport.shutdown();
  await new Promise<void>((r) => agentServer.close(() => r()));
  await central.close();
  resetLocalDbForTests();
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  await rm(workspace, { recursive: true, force: true });
});

describe("agent MCP front door", () => {
  it("graph tool passes through to central", async () => {
    const r = await localClient.callTool({
      name: "portuni_get_node",
      arguments: { node_id: "x" },
    });
    assert.match(JSON.stringify(r.content), /central-marker/);
  });

  it("portuni_mirror is intercepted locally, never reaches central", async () => {
    const r = await localClient.callTool({
      name: "portuni_mirror",
      arguments: { node_id: "01TESTNODE0000000000000000", targets: ["local"] },
    });
    assert.doesNotMatch(JSON.stringify(r.content), /CENTRAL SHOULD NOT SERVE THIS/);
  });

  it("tools/list mirrors the central tool list", async () => {
    const tools = await localClient.listTools();
    assert.ok(tools.tools.some((t) => t.name === "portuni_get_node"));
    assert.ok(tools.tools.some((t) => t.name === "portuni_mirror"));
  });

  it("a local handler throw becomes an isError result, not a protocol error", async () => {
    // portuni_store on a node with no mirror registered: storeFileCentral
    // throws a plain Error (not one of the types callLocalTool catches), so
    // the transport must convert the uncaught throw to an isError MCP result
    // the same way McpServer does -- agent sessions must not see a transport
    // error where central sessions see a tool error.
    const r = await localClient.callTool({
      name: "portuni_store",
      arguments: { node_id: "01TESTNODE0000000000000000", local_path: "/tmp/nope.md" },
    });
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /no local mirror/);
  });
});
