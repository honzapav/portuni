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

interface StubCentral {
  base: string;
  close: () => Promise<void>;
  // Every request-target (path + query) the stub's HTTP layer saw. Used to
  // assert the agent forwards ?home_node_id=... onto the upstream URL.
  seenUrls: string[];
  // Number of upstream MCP sessions initialized on the stub (one per
  // openUpstream() in the agent transport).
  sessionsInitialized: () => number;
  // Live standalone GET SSE streams. The SDK client opens one after the
  // initialized notification and its close() aborts it -- so an upstream
  // client that was properly closed leaves no open GET behind, while a
  // leaked one holds its stream open forever.
  openGets: () => number;
}

function startStubCentral(): Promise<StubCentral> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const seenUrls: string[] = [];
  let openGets = 0;
  const httpServer = createServer(async (req, res) => {
    seenUrls.push(req.url ?? "");
    if (req.method === "GET") {
      openGets++;
      res.on("close", () => {
        openGets--;
      });
    }
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
        "portuni_read_file",
        { node_id: z.string(), path: z.string() },
        async (a) => ({
          content: [{ type: "text" as const, text: `central-file:${a.node_id}:${a.path}` }],
        }),
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
            httpServer.closeAllConnections?.();
          }),
        seenUrls,
        sessionsInitialized: () => sessions.size,
        openGets: () => openGets,
      });
    });
  });
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

let workspace: string;
let central: StubCentral;
let agentServer: Server;
let agentBase: string;
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
  agentBase = `http://127.0.0.1:${addr.port}`;

  localClient = new Client({ name: "agent-transport-test", version: "0.0.0" });
  await localClient.connect(new StreamableHTTPClientTransport(new URL(`${agentBase}/mcp`)));
  // Let the shared session's upstream standalone GET stream settle so the
  // leak test below starts from a stable openGets baseline.
  await waitFor(() => central.openGets() >= 1);
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

  it("portuni_read_file proxies upstream when the device holds no mirror of the node", async () => {
    // No mirror registered for this node on the device: central has the
    // Drive-direct fallback, so the read goes upstream verbatim (after the
    // get_node gate, which the stub answers for any node).
    const r = (await localClient.callTool({
      name: "portuni_read_file",
      arguments: { node_id: "01NOMIRROR000000000000000", path: "wip/n.md" },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    assert.notEqual(r.isError, true, r.content[0]?.text);
    assert.equal(r.content[0].text, "central-file:01NOMIRROR000000000000000:wip/n.md");
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

  it("forwards ?home_node_id onto the upstream central URL", async () => {
    const homeClient = new Client({ name: "agent-transport-home", version: "0.0.0" });
    await homeClient.connect(
      new StreamableHTTPClientTransport(
        new URL(`${agentBase}/mcp?home_node_id=01TESTHOME000000000000000`),
      ),
    );
    try {
      assert.ok(
        central.seenUrls.some((u) => u.includes("home_node_id=01TESTHOME000000000000000")),
        `central never saw home_node_id; urls: ${central.seenUrls.join(", ")}`,
      );
    } finally {
      await homeClient.close().catch(() => undefined);
    }
    // Closing the local client does not tear down the agent-side session
    // (streamable HTTP close is client-local), so this session's upstream --
    // and its standalone GET stream -- stays alive until GC/shutdown. Wait
    // for that GET to open so the leak test below starts from a stable
    // baseline instead of racing it.
    await waitFor(() => central.openGets() >= 2);
  });

  it("closes the upstream client when the first request never initializes a session", async () => {
    const sessionsBefore = central.sessionsInitialized();
    const getsBefore = central.openGets();

    // A first request that is NOT an initialize (and carries no
    // mcp-session-id): the SDK server transport rejects it with 400 and
    // onsessioninitialized never fires -- the freshly opened upstream client
    // must be closed by the transport, not orphaned.
    const res = await fetch(`${agentBase}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 400);
    await res.body?.cancel();

    // The agent DID open an upstream connection for the doomed request...
    assert.equal(central.sessionsInitialized(), sessionsBefore + 1);
    // ...and closed it: a leaked client would (eventually) hold its
    // standalone GET SSE stream open forever, so openGets must return to
    // the pre-request baseline and stay there.
    const settled = await waitFor(() => central.openGets() === getsBefore);
    assert.ok(
      settled,
      `orphaned upstream GET stream still open: ${central.openGets()} != ${getsBefore}`,
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(central.openGets(), getsBefore, "upstream GET stream reopened after close");
  });
});
