// Task 4 e2e: the central-mode agent sidecar serves MCP over the same HTTP
// server as its REST routes, gated by the identical loopback env-token auth
// as the REST routes -- the /mcp route is not carved out of the bearer-token
// gate the way /health and /mcp/info are. Verifies:
//   - tools/list on /mcp answers via the injected agent transport, which
//     proxies to a stub central MCP server (the same wiring agentMain now
//     uses instead of `mountMcp: false`).
//   - an unauthenticated POST /mcp is rejected with 401, same as REST.
//
// PORTUNI_AUTH_TOKEN must be set before any of apps/server/http/middleware.ts
// is evaluated: it freezes AUTH_ENABLED from process.env at module load
// time. ES module `import` bindings evaluate their target modules before ANY
// of the importing module's own top-level code runs -- even statements
// textually preceding the import declarations -- so a plain assignment above
// the static imports below would run too late. All apps/server modules whose
// behavior depends on env are therefore loaded dynamically, after the
// assignment actually executes.
process.env.PORTUNI_AUTH_TOKEN = "test-token";

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

// Minimal CentralClient stub -- only the MCP plane is under test here, not
// the REST plane the agent router also serves. Same no-op shape as
// agent-transport.test.ts's fakeCentral.
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

interface StubCentral {
  base: string;
  close: () => Promise<void>;
}

// A tiny stand-in for the real central MCP server: one graph tool so
// tools/list and tools/call have something to prove the proxy path works.
function startStubCentral(): Promise<StubCentral> {
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
        async (a) =>
          // Central's scope gate: a node not in scope comes back as an error
          // (the front door's portuni_read_file uses this as its authorization).
          a.node_id === "N000000000000000000OUTSC"
            ? {
                content: [{ type: "text" as const, text: "expand scope first" }],
                isError: true,
              }
            : { content: [{ type: "text" as const, text: "central-marker" }] },
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
      });
    });
  });
}

let workspace: string;
let central: StubCentral;
let handle: HttpServerHandle;
let port: number;

before(async () => {
  // Dynamic import: must happen after the PORTUNI_AUTH_TOKEN assignment
  // above has actually run (see the file-header comment) so middleware.ts's
  // module-level AUTH_ENABLED const picks it up.
  const { startHttpServer } = await import("../apps/server/http/server.js");
  const { createAgentMcpTransport } = await import("../apps/server/mcp/agent-transport.js");
  const { createAgentRouter } = await import("../apps/server/api/agent-router.js");
  const { resetLocalDbForTests } = await import("../apps/server/domain/sync/local-db.js");
  const { resetGateCachesForTesting } = await import("../apps/server/http/middleware.js");

  workspace = await mkdtemp(join(tmpdir(), "portuni-agent-mcp-e2e-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();

  central = await startStubCentral();

  // Exactly the wiring agentMain now does: the agent transport is built
  // once and injected into startHttpServer via mcpTransport (replacing the
  // old `mountMcp: false`), sitting behind the same router/gates the REST
  // routes use.
  const mcpTransport = createAgentMcpTransport({
    client: fakeCentral,
    centralUrl: central.base,
    centralToken: "central-device-token",
  });

  handle = startHttpServer({
    port: 0,
    host: "127.0.0.1",
    registerSigint: false,
    router: createAgentRouter(fakeCentral),
    mcpTransport,
  });
  if (!handle.server.listening) {
    await new Promise<void>((r) => handle.server.once("listening", r));
  }
  const addr = handle.server.address() as AddressInfo;
  port = addr.port;
  process.env.PORT = String(port);
  resetGateCachesForTesting();
});

after(async () => {
  const { resetLocalDbForTests } = await import("../apps/server/domain/sync/local-db.js");
  await handle.shutdown();
  await central.close();
  resetLocalDbForTests();
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  await rm(workspace, { recursive: true, force: true });
});

describe("agent sidecar MCP front door", () => {
  it("agent serves MCP and the graph plane answers via central", async () => {
    const client = new Client({ name: "agent-mcp-e2e", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer test-token" } },
      }),
    );
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.length > 0);
      assert.ok(tools.tools.some((t) => t.name === "portuni_get_node"));
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("unauthenticated /mcp is rejected", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401);
    await res.body?.cancel();
  });

  it("portuni_read_file enforces the central scope gate, not just mirror-presence", async () => {
    const { registerMirror } = await import("../apps/server/domain/sync/mirror-registry.js");
    const { SOLO_USER } = await import("../apps/server/infra/schema.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const mirror = join(workspace, "org", "projects", "p");
    await mkdir(join(mirror, "wip"), { recursive: true });
    await writeFile(join(mirror, "wip", "n.md"), "hello ad-hoc\n");
    const IN = "N00000000000000000000INSC";
    const OUT = "N000000000000000000OUTSC"; // stub get_node returns isError for this
    // BOTH nodes are mirrored on this device -- mirror-presence alone would
    // expose both. Only the central scope gate distinguishes them.
    await registerMirror(SOLO_USER, IN, mirror);
    await registerMirror(SOLO_USER, OUT, mirror);

    const client = new Client({ name: "rf-gate", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer test-token" } },
      }),
    );
    try {
      const ok = (await client.callTool({
        name: "portuni_read_file",
        arguments: { node_id: IN, path: "wip/n.md" },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.notEqual(ok.isError, true, "in-scope read must succeed");
      assert.equal(ok.content[0].text, "hello ad-hoc\n");

      const denied = (await client.callTool({
        name: "portuni_read_file",
        arguments: { node_id: OUT, path: "wip/n.md" },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.equal(denied.isError, true, "out-of-scope read must be denied");
      assert.notEqual(denied.content[0].text, "hello ad-hoc\n", "content must not leak");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
