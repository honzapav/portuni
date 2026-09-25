// #507: a runner-driven run's own Portuni MCP connection authenticates at
// the real HTTP front door. The run's URL and bearer come from provisioning
// (provisionRun in a personal workspace, createProvisionRunCentral on a
// team workspace's sync agent) with the env the desktop gives a sidecar --
// PORTUNI_WORKSPACE_ID + PORTUNI_AUTH_TOKEN, no PORTUNI_MCP_TOKEN* -- and a
// runner-style MCP client (the headers the Claude adapter sends:
// `Authorization: Bearer <mcp.token>` + X-Portuni-Spawn-Id) must get past
// the bearer gate instead of the 401 an empty bearer gets.
//
// The server reads the bearer live (#521); it only has to be set before
// the server starts.
process.env.PORTUNI_AUTH_TOKEN = "front-door-token";
process.env.PORTUNI_WORKSPACE_ID = "ws-test";
delete process.env.PORTUNI_MCP_TOKEN;
delete process.env.PORTUNI_MCP_TOKEN_WS_TEST;

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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
import type { HttpServerHandle } from "../apps/server/http/server.js";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import type { NodeSyncInfo } from "../apps/server/domain/sync/sync-remote-api.js";
import type { ProvisionRunResult } from "../apps/server/domain/runner/provision.js";
import { makeSharedDb } from "./helpers/shared-db.js";
import { installTestContentDb } from "./helpers/content-db.js";
import { startHttpServer } from "../apps/server/http/server.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { provisionRun } from "../apps/server/domain/runner/provision.js";
import { SOLO_USER } from "../apps/server/infra/schema.js";
import { createAgentMcpTransport } from "../apps/server/mcp/agent-transport.js";
import { createAgentRouter } from "../apps/server/api/agent-router.js";
import { createProvisionRunCentral } from "../apps/server/domain/runner/provision-central.js";

async function listen(handle: HttpServerHandle): Promise<number> {
  if (!handle.server.listening) {
    await new Promise<void>((r) => handle.server.once("listening", r));
  }
  return (handle.server.address() as AddressInfo).port;
}

// What the Claude adapter's MCP client presents (adapters/claude.ts).
async function connectLikeTheRunner(mcp: ProvisionRunResult["mcp"]): Promise<Client> {
  const client = new Client({ name: "claude-code", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${mcp.token}`, "X-Portuni-Spawn-Id": randomUUID() } },
    }),
  );
  return client;
}

// The bearer gate is really on: the same URL with the empty bearer the old
// provisioning produced is refused.
async function emptyBearerStatus(url: string): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } },
    }),
  });
  await res.body?.cancel();
  return res.status;
}

let workspace: string;

before(async () => {
  await installTestContentDb();
  workspace = await mkdtemp(join(tmpdir(), "portuni-runner-front-door-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
});

after(async () => {
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  await rm(workspace, { recursive: true, force: true });
});

describe("personal workspace: the run's MCP connection passes the front door", () => {
  let handle: HttpServerHandle;
  let nodeId: string;

  before(async () => {
    resetLocalDbForTests();
    const shared = await makeSharedDb();
    nodeId = shared.nodeId;
    setDbForTesting(shared.db);
    handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false });
    process.env.PORT = String(await listen(handle));
    resetGateCachesForTesting();
  });

  after(async () => {
    await handle.shutdown();
    setDbForTesting(null);
    delete process.env.PORT;
  });

  it("provisionRun's token and URL connect, list tools, and an empty bearer is a 401", async () => {
    const provisioned = await provisionRun({ userId: SOLO_USER, nodeId, sessionId: "S1", resume: null });
    assert.equal(provisioned.mcp.token, "front-door-token");

    const client = await connectLikeTheRunner(provisioned.mcp);
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.some((t) => t.name === "portuni_get_node"), "the run sees mcp__portuni__* tools");
    } finally {
      await client.close().catch(() => undefined);
    }
    assert.equal(await emptyBearerStatus(provisioned.mcp.url), 401);
  });
});

// A stand-in central MCP server the sync agent's front door proxies graph
// tools to (same shape as test/agent-mcp-e2e.test.ts's).
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
      mcp.tool("portuni_get_node", { node_id: z.string() }, async () => ({
        content: [{ type: "text" as const, text: "central-marker" }],
      }));
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
      });
    });
  });
}

const AGENT_NODE = "N0000000000000000000PROJ1";

// Only what provisioning and the front door's connect reach; anything else
// fails loudly.
function fakeCentral(): CentralClient {
  const info: NodeSyncInfo = {
    node: { id: AGENT_NODE, name: "Proj", type: "project", sync_key: "proj", org_sync_key: "workflow" },
    remote_name: null,
    files: [],
    deleted: [],
  };
  const impl: Record<string, unknown> = {
    async syncInfo() {
      return info;
    },
    async syncInfoBatch() {
      return [info];
    },
    async dataSources() {
      return [];
    },
    async orientation() {
      return null;
    },
    async nodeExists() {
      return true;
    },
    invalidateSyncInfo() {
      // No cache in this fake.
    },
  };
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === "then") return undefined;
      return () => {
        throw new Error(`CentralClient.${String(prop)} not used in this test`);
      };
    },
  }) as unknown as CentralClient;
}

describe("team workspace (sync agent): the run's MCP connection passes the front door", () => {
  let handle: HttpServerHandle;
  let central: { base: string; close: () => Promise<void> };
  let client: CentralClient;

  before(async () => {
    process.env.PORTUNI_AGENT_MODE = "1";
    resetLocalDbForTests();
    central = await startStubCentral();
    client = fakeCentral();
    handle = startHttpServer({
      port: 0,
      host: "127.0.0.1",
      registerSigint: false,
      router: createAgentRouter(client),
      mcpTransport: createAgentMcpTransport({ client, centralUrl: central.base, centralToken: "central-device-token" }),
    });
    const port = await listen(handle);
    process.env.PORT = String(port);
    process.env.PORTUNI_PORT = String(port);
    resetGateCachesForTesting();
  });

  after(async () => {
    await handle.shutdown();
    await central.close();
    delete process.env.PORTUNI_AGENT_MODE;
    delete process.env.PORT;
    delete process.env.PORTUNI_PORT;
  });

  it("createProvisionRunCentral's token and URL connect, list tools, and an empty bearer is a 401", async () => {
    const provisioned = await createProvisionRunCentral(client)({
      userId: SOLO_USER,
      nodeId: AGENT_NODE,
      sessionId: "S1",
      resume: null,
    });
    assert.equal(provisioned.mcp.token, "front-door-token");
    assert.match(provisioned.mcp.url, new RegExp(`^http://127\\.0\\.0\\.1:${process.env.PORTUNI_PORT}/mcp\\?`));

    const mcp = await connectLikeTheRunner(provisioned.mcp);
    try {
      const tools = await mcp.listTools();
      assert.ok(tools.tools.some((t) => t.name === "portuni_get_node"), "the run sees mcp__portuni__* tools");
    } finally {
      await mcp.close().catch(() => undefined);
    }
    assert.equal(await emptyBearerStatus(provisioned.mcp.url), 401);
  });
});
