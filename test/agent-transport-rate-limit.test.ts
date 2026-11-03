// #633: the agent MCP front door against a central server whose rate
// limiter refuses the upstream initialize with 429 + Retry-After. The front
// door waits as told (an injected sleep, so the test waits for nothing) and
// opens the session on the retry; a limit that outlasts the budget is
// answered with 429 RATE_LIMITED and the same Retry-After, never with the
// "unreachable" 503.

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
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";

const identity: RequestIdentity = {
  userId: "01SOLO0000000000000000000",
  email: "solo@localhost",
  name: "Solo",
  globalScope: "admin",
  groups: [],
  groupIds: [],
  via: "env",
};

// The front door never touches the CentralClient on connect.
const unusedCentral = {} as CentralClient;

interface FakeCentral {
  base: string;
  // How many upcoming POSTs answer 429 before the real MCP server is reached.
  limitNext: (n: number, retryAfterSeconds: number) => void;
  rateLimited: () => number;
  close: () => Promise<void>;
}

function startFakeCentral(): Promise<FakeCentral> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let limitLeft = 0;
  let retryAfter = 1;
  let rateLimited = 0;
  const httpServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.method === "POST" && limitLeft > 0) {
      limitLeft--;
      rateLimited++;
      // Same shape as central's rate limiter (http/server.ts).
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
      res.end(
        JSON.stringify({
          error: "rate limited",
          code: "RATE_LIMITED",
          params: { retryAfterSeconds: retryAfter },
        }),
      );
      return;
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw.length > 0 ? JSON.parse(raw) : undefined;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      const mcp = new McpServer({ name: "fake-central", version: "0.0.0" });
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
        limitNext: (n, secs) => {
          limitLeft = n;
          retryAfter = secs;
        },
        rateLimited: () => rateLimited,
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

let workspace: string;
let central: FakeCentral;
let agentServer: Server;
let agentBase: string;
let agentTransport: ReturnType<typeof createAgentMcpTransport>;
const slept: number[] = [];

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-agent-ratelimit-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  process.env.PORTUNI_DATA_DIR = join(workspace, "data");
  resetLocalDbForTests();
  central = await startFakeCentral();
  agentTransport = createAgentMcpTransport({
    client: unusedCentral,
    centralUrl: central.base,
    centralToken: "test-token",
    rateLimitRetry: {
      budgetMs: 20_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    },
  });
  agentServer = createServer((req, res) => {
    void agentTransport.handle(req, res, identity);
  });
  await new Promise<void>((r) => agentServer.listen(0, "127.0.0.1", r));
  agentBase = `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}`;
});

after(async () => {
  agentTransport.shutdown();
  await new Promise<void>((r) => agentServer.close(() => r()));
  await central.close();
  resetLocalDbForTests();
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  delete process.env.PORTUNI_DATA_DIR;
  await rm(workspace, { recursive: true, force: true });
});

describe("agent MCP front door under central's rate limit (#633)", () => {
  it("a 429 with Retry-After on the upstream connect is waited out and the session opens", async () => {
    slept.length = 0;
    central.limitNext(2, 3);
    const client = new Client({ name: "rate-limit-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${agentBase}/mcp`)));
    try {
      assert.deepEqual(slept, [3000, 3000], "waited Retry-After before each retry");
      assert.equal(central.rateLimited(), 2);
      const r = await client.callTool({ name: "portuni_get_node", arguments: { node_id: "x" } });
      assert.match(JSON.stringify(r.content), /central-marker/);
    } finally {
      await client.close();
    }
  });

  it("a limit that outlasts the budget answers 429 RATE_LIMITED with Retry-After, not 503", async () => {
    slept.length = 0;
    central.limitNext(10, 30);
    const res = await fetch(`${agentBase}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "raw", version: "0" },
        },
      }),
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "30");
    const body = (await res.json()) as { code?: string; params?: { retryAfterSeconds?: number } };
    assert.equal(body.code, "RATE_LIMITED");
    assert.equal(body.params?.retryAfterSeconds, 30);
    assert.deepEqual(slept, [], "a wait longer than the budget is not attempted");
    central.limitNext(0, 1);
  });
});
