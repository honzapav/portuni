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
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { ulid } from "ulid";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
  // Stands in for central's Drive-direct GET /nodes/:id/file?encoding=base64
  // -- the read-file spill path (#252) calls this directly instead of
  // proxying the portuni_read_file tool call, so it needs real content for
  // the "device holds no mirror" test below rather than throwing.
  async getFileRaw(nodeId: string, relPath: string) {
    return {
      bytes: Buffer.from(`central-file:${nodeId}:${relPath}`),
      version: "v1",
      canonicalHash: "h1",
    };
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

// Identities for the write-gate tests below. Production identities reaching
// this front door always have via: "env" -- the sidecar's own local HTTP
// server defaults to PORTUNI_AUTH_MODE=env for agent mode too, so
// resolveRequestIdentity never produces a device_token/oauth_grant identity
// here even for a genuinely spawned terminal. That is exactly the bug
// deriveAgentSessionType (agent-transport.ts) fixes: it derives
// interactive_task/headless from identity.headless rather than falling
// through to "env" (which mcp/scope.ts's deriveSessionType would treat as
// exempt). headlessIdentity sets the headless flag directly to exercise
// that branch even though no real auth path sets it on an "env" identity
// today -- see deriveAgentSessionType's comment.
const headlessIdentity: RequestIdentity = { ...identity, headless: true };
const taskIdentity: RequestIdentity = { ...identity };

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
  // Headers on the most recent POST the stub saw (#272: asserts
  // openUpstream forwards X-Portuni-Terminal/Spawn-Id/Profile).
  lastHeaders: () => Record<string, string | string[] | undefined>;
}

function startStubCentral(): Promise<StubCentral> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const seenUrls: string[] = [];
  let openGets = 0;
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  const httpServer = createServer(async (req, res) => {
    seenUrls.push(req.url ?? "");
    lastHeaders = req.headers;
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
      // Exists only to drive the front-door elicitation round-trip test
      // below: calls elicitInput on the stub's own low-level Server exactly
      // the way a graph-plane tool's "elicit" classification would, so the
      // request travels stub-central -> agent-transport's upstream Client ->
      // (reverse handler) -> the real downstream Server -> the actual local
      // test client, and the answer flows back the same way.
      mcp.tool(
        "portuni_test_elicit",
        { message: z.string() },
        async (a) => {
          const result = await mcp.server.elicitInput({
            message: a.message,
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean", title: "Confirm" } },
              required: ["confirm"],
            },
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        },
      );
      mcp.tool(
        "portuni_read_file",
        { node_id: z.string(), path: z.string() },
        async (a) => ({
          content: [{ type: "text" as const, text: `central-file:${a.node_id}:${a.path}` }],
        }),
      );
      mcp.tool(
        "portuni_snapshot",
        { node_id: z.string(), doc_url: z.string() },
        async (a) => ({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                file_id: "F1",
                filename: "snap.pdf",
                remote_path: `workflow/projects/${a.node_id}/wip/snap.pdf`,
              }),
            },
          ],
        }),
      );
      mcp.tool(
        "portuni_mirror",
        { node_id: z.string(), targets: z.array(z.string()).optional() },
        async () => ({
          content: [{ type: "text" as const, text: "CENTRAL SHOULD NOT SERVE THIS" }],
        }),
      );
      // Central's own answer always has an empty/useless projected map (it
      // has no device filesystem) -- the agent-transport overlay (#252)
      // replaces it with this device's own projection.
      mcp.tool(
        "portuni_expand_scope",
        { node_ids: z.array(z.string()), reason: z.string() },
        async (a) => ({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ added: a.node_ids, added_via: {}, projected: {}, not_projected: {} }),
            },
          ],
        }),
      );
      // Exists only to drive the capability-filtering test below: reports
      // what capabilities central actually saw from the agent-transport's
      // upstream Client at initialize, so the test can assert the front
      // door only forwards what it can relay (#206).
      mcp.tool(
        "portuni_test_capabilities",
        {},
        async () => ({
          content: [
            { type: "text" as const, text: JSON.stringify(mcp.server.getClientCapabilities() ?? {}) },
          ],
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
        lastHeaders: () => lastHeaders,
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

  // home_node_id matches the node id the LOCAL_TOOLS tests below target
  // (portuni_mirror, portuni_store) so those calls clear the write gate and
  // reach callLocalTool exactly as before deriveAgentSessionType stopped
  // treating this front door's "env" identity as unscoped/exempt -- the
  // write-gate-specific behavior (refusal on a NON-home node) is exercised
  // separately below in "write gate on LOCAL_TOOLS".
  localClient = new Client({ name: "agent-transport-test", version: "0.0.0" });
  await localClient.connect(
    new StreamableHTTPClientTransport(
      new URL(`${agentBase}/mcp?home_node_id=01TESTNODE0000000000000000`),
    ),
  );
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

  it("portuni_read_file fetches raw bytes from central when the device holds no mirror of the node", async () => {
    // No mirror registered for this node on the device: after the get_node
    // gate (which the stub answers for any node), the content is fetched via
    // CentralClient.getFileRaw (#252 -- not proxied through central's own
    // portuni_read_file tool call, so an oversized/as_path result could be
    // spilled to this device's disk instead).
    const r = (await localClient.callTool({
      name: "portuni_read_file",
      arguments: { node_id: "01NOMIRROR000000000000000", path: "wip/n.md" },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    assert.notEqual(r.isError, true, r.content[0]?.text);
    assert.equal(r.content[0].text, "central-file:01NOMIRROR000000000000000:wip/n.md");
  });

  it("portuni_expand_scope overlays this device's own projection (#252)", async () => {
    const { registerMirror } = await import("../apps/server/domain/sync/mirror-registry.js");
    const { mkdir: mkdirp, writeFile } = await import("node:fs/promises");
    const mirrored = "01EXPANDMIRROR00000000000";
    const noMirror = "01EXPANDNOMIRROR000000000";
    const mirrorDir = join(workspace, "org", "projects", "expand-target");
    await mkdirp(join(mirrorDir, "wip"), { recursive: true });
    await writeFile(join(mirrorDir, "wip", "n.md"), "hi\n");
    const { SOLO_USER } = await import("../apps/server/infra/schema.js");
    await registerMirror(SOLO_USER, mirrored, mirrorDir);

    const r = (await localClient.callTool({
      name: "portuni_expand_scope",
      arguments: { node_ids: [mirrored, noMirror], reason: "user-requested: test" },
    })) as { content: Array<{ text: string }>; isError?: boolean };
    assert.notEqual(r.isError, true, r.content[0]?.text);
    const payload = JSON.parse(r.content[0].text) as {
      projected: Record<string, string>;
      not_projected: Record<string, string>;
    };
    assert.ok(payload.projected[mirrored], "mirrored node got a device-local projection");
    assert.equal(payload.not_projected[noMirror], "no_mirror");
    // No X-Portuni-Spawn-Id on this connection: the projection must land in
    // the shared bucket the Seatbelt profile grants unconditionally, never
    // under this transport's own (never-granted) MCP session id.
    assert.ok(
      payload.projected[mirrored].includes(`${sep}_shared${sep}`),
      `expected the _shared bucket, got ${payload.projected[mirrored]}`,
    );
  });

  it("drops a malformed X-Portuni-Spawn-Id and falls back to the shared bucket", async () => {
    const { registerMirror } = await import("../apps/server/domain/sync/mirror-registry.js");
    const { mkdir: mkdirp, writeFile } = await import("node:fs/promises");
    const mirrored = "01BADSPAWNMIRROR000000000";
    const mirrorDir = join(workspace, "org", "projects", "bad-spawn-target");
    await mkdirp(join(mirrorDir, "wip"), { recursive: true });
    await writeFile(join(mirrorDir, "wip", "n.md"), "hi\n");
    const { SOLO_USER } = await import("../apps/server/infra/schema.js");
    await registerMirror(SOLO_USER, mirrored, mirrorDir);

    const client = new Client({ name: "agent-transport-badspawn", version: "0.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(
      new URL(`${agentBase}/mcp?home_node_id=01TESTNODE0000000000000000`),
      { requestInit: { headers: { "X-Portuni-Spawn-Id": "../../.." } } },
    );
    await client.connect(clientTransport);
    try {
      const r = (await client.callTool({
        name: "portuni_expand_scope",
        arguments: { node_ids: [mirrored], reason: "user-requested: test" },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.notEqual(r.isError, true, r.content[0]?.text);
      const payload = JSON.parse(r.content[0].text) as { projected: Record<string, string> };
      assert.ok(
        payload.projected[mirrored]?.includes(`${sep}_shared${sep}`),
        `expected the _shared bucket, got ${payload.projected[mirrored]}`,
      );
      // The shared `localClient` session (no spawn header) on the same
      // home node is still live, so ending THIS session must leave the
      // shared bucket and its registry entry alone.
      await clientTransport.terminateSession();
      await client.close();
      await new Promise((r) => setTimeout(r, 100));
      const { stat } = await import("node:fs/promises");
      await stat(payload.projected[mirrored]);
      const { projectedEntriesForNode } = await import("../apps/server/domain/session-projection.js");
      assert.ok(projectedEntriesForNode(mirrored).some((e) => e.sessionId === "_shared"));
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("a reconnect with the same X-Portuni-Spawn-Id keeps the narrow projection until the last session closes", async () => {
    const { registerMirror } = await import("../apps/server/domain/sync/mirror-registry.js");
    const { mkdir: mkdirp, writeFile, stat } = await import("node:fs/promises");
    const mirrored = "01RECONNECTMIRROR00000000";
    const mirrorDir = join(workspace, "org", "projects", "reconnect-target");
    await mkdirp(join(mirrorDir, "wip"), { recursive: true });
    await writeFile(join(mirrorDir, "wip", "n.md"), "hi\n");
    const { SOLO_USER } = await import("../apps/server/infra/schema.js");
    await registerMirror(SOLO_USER, mirrored, mirrorDir);

    const spawnId = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    const connect = async () => {
      const client = new Client({ name: "agent-transport-reconnect", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${agentBase}/mcp?home_node_id=01TESTNODE0000000000000000`),
        { requestInit: { headers: { "X-Portuni-Spawn-Id": spawnId } } },
      );
      await client.connect(transport);
      return { client, transport };
    };
    const first = await connect();
    const second = await connect();
    const exists = (p: string) => stat(p).then(() => true, () => false);
    try {
      const r = (await second.client.callTool({
        name: "portuni_expand_scope",
        arguments: { node_ids: [mirrored], reason: "user-requested: test" },
      })) as { content: Array<{ text: string }> };
      const dir = (JSON.parse(r.content[0].text) as { projected: Record<string, string> }).projected[mirrored];
      assert.ok(dir?.includes(`${sep}${spawnId}${sep}`), `expected the spawn-id directory, got ${dir}`);

      // The stale first session goes away: the replacement still reads here.
      await first.transport.terminateSession();
      await first.client.close();
      await new Promise((res) => setTimeout(res, 100));
      assert.ok(await exists(dir), "projection must survive the stale session's close");

      await second.transport.terminateSession();
      await second.client.close();
      const deadline = Date.now() + 2000;
      while ((await exists(dir)) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 25));
      assert.ok(!(await exists(dir)), "projection gone once the last session closed");
    } finally {
      await first.client.close().catch(() => undefined);
      await second.client.close().catch(() => undefined);
    }
  });

  it("keys the projection by the relayed X-Portuni-Spawn-Id, the directory the Seatbelt profile granted (#252)", async () => {
    const { registerMirror } = await import("../apps/server/domain/sync/mirror-registry.js");
    const { mkdir: mkdirp, writeFile, stat } = await import("node:fs/promises");
    const mirrored = "01SPAWNMIRROR000000000000";
    const mirrorDir = join(workspace, "org", "projects", "spawn-target");
    await mkdirp(join(mirrorDir, "wip"), { recursive: true });
    await writeFile(join(mirrorDir, "wip", "n.md"), "hi\n");
    const { SOLO_USER } = await import("../apps/server/infra/schema.js");
    await registerMirror(SOLO_USER, mirrored, mirrorDir);

    const spawnId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const client = new Client({ name: "agent-transport-spawn", version: "0.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(
      new URL(`${agentBase}/mcp?home_node_id=01TESTNODE0000000000000000`),
      { requestInit: { headers: { "X-Portuni-Spawn-Id": spawnId } } },
    );
    await client.connect(clientTransport);
    try {
      const r = (await client.callTool({
        name: "portuni_expand_scope",
        arguments: { node_ids: [mirrored], reason: "user-requested: test" },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.notEqual(r.isError, true, r.content[0]?.text);
      const payload = JSON.parse(r.content[0].text) as { projected: Record<string, string> };
      const projectedDir = payload.projected[mirrored];
      assert.ok(projectedDir, "mirrored node got a device-local projection");
      assert.ok(
        projectedDir.includes(`${sep}${spawnId}${sep}`),
        `expected the spawn-id directory, got ${projectedDir}`,
      );
      await stat(join(projectedDir, "wip", "n.md"));
      // Ending the session (DELETE -> server transport onclose) drops its
      // own narrow directory. A bare client.close() only tears down the
      // client side; the server would learn of it via the idle GC instead.
      await clientTransport.terminateSession();
      await client.close();
      const deadline = Date.now() + 2000;
      let gone = false;
      while (!gone && Date.now() < deadline) {
        gone = await stat(projectedDir).then(
          () => false,
          () => true,
        );
        if (!gone) await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(gone, `projection directory still present after close: ${projectedDir}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("portuni_snapshot proxies to central and reports local_path null without a device mirror", async () => {
    const r = (await localClient.callTool({
      name: "portuni_snapshot",
      arguments: { node_id: "N1", doc_url: "https://docs.google.com/document/d/X/edit" },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.ok(!r.isError);
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.file_id, "F1");
    assert.equal(payload.remote_path, "workflow/projects/N1/wip/snap.pdf");
    assert.equal(payload.local_path, null);
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

  it("refuses a first request that never initializes a session, without ever opening an upstream connection (#272)", async () => {
    const sessionsBefore = central.sessionsInitialized();
    const getsBefore = central.openGets();

    // A first request that is NOT an initialize (and carries no
    // mcp-session-id): refused with 400 BEFORE openUpstream runs at all --
    // openUpstream's client.connect() always issues its own genuine
    // initialize handshake regardless of what the downstream request was,
    // so opening it for a doomed request would burn a real session on
    // central for traffic that never became a session here.
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

    // No upstream connection was opened for the doomed request at all.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(central.sessionsInitialized(), sessionsBefore);
    assert.equal(central.openGets(), getsBefore);
  });

  it("forwards X-Portuni-Terminal/Spawn-Id/Profile from the downstream connection onto the upstream request (#272)", async () => {
    const spawnId = ulid();
    const client = new Client({ name: "agent-transport-header-test", version: "0.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`${agentBase}/mcp?home_node_id=01TESTNODE0000000000000000`),
          {
            requestInit: {
              headers: {
                "X-Portuni-Terminal": "term-abc",
                "X-Portuni-Spawn-Id": spawnId,
                "X-Portuni-Profile": "profile-xyz",
              },
            },
          },
        ),
      );
      const headers = central.lastHeaders();
      assert.equal(headers["x-portuni-terminal"], "term-abc");
      assert.equal(headers["x-portuni-spawn-id"], spawnId);
      assert.equal(headers["x-portuni-profile"], "profile-xyz");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

// The five LOCAL_TOOLS (portuni_mirror, portuni_status, portuni_store,
// portuni_pull, portuni_adopt_files) dispatch straight to CentralClient from
// this transport -- they never reach apps/server/mcp/tools/*.ts, so the
// domain-layer write gate (guardWrite in domain/write-gate.ts) has to be
// applied here too, or it is bypassed for exactly this path. See
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Enforcement points").
describe("agent MCP front door: write gate on LOCAL_TOOLS", () => {
  const HOME = "01HOMENODE00000000000000A";
  const OTHER = "01OTHERNODE0000000000000B";

  async function connectAs(reqIdentity: RequestIdentity, homeNodeId: string): Promise<Client> {
    const server = createServer((req, res) => {
      void agentTransport.handle(req, res, reqIdentity);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    const client = new Client({ name: "write-gate-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp?home_node_id=${homeNodeId}`)),
    );
    (client as unknown as { __server: Server }).__server = server;
    return client;
  }

  async function closeClient(client: Client): Promise<void> {
    const server = (client as unknown as { __server: Server }).__server;
    await client.close().catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
  }

  it("headless session: portuni_mirror on the home node is not write-gated (allowed through to the local handler)", async () => {
    const client = await connectAs(headlessIdentity, HOME);
    try {
      const r = (await client.callTool({
        name: "portuni_mirror",
        arguments: { node_id: HOME, targets: ["local"] },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      // Blocked by fakeCentral (no such node), NOT by the write gate --
      // proves the home node passed guardWrite and reached callLocalTool.
      assert.equal(r.isError, true);
      assert.doesNotMatch(r.content[0].text, /write_refused|write_expansion_required/);
    } finally {
      await closeClient(client);
    }
  });

  it("headless session: portuni_mirror on a non-home node is refused outright, never reaching the local handler", async () => {
    const client = await connectAs(headlessIdentity, HOME);
    try {
      const r = (await client.callTool({
        name: "portuni_mirror",
        arguments: { node_id: OTHER, targets: ["local"] },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.equal(r.isError, true);
      const payload = JSON.parse(r.content[0].text);
      assert.equal(payload.error, "write_refused");
      assert.equal(payload.node_id, OTHER);
    } finally {
      await closeClient(client);
    }
  });

  it("headless session: portuni_store on a non-home node is refused outright", async () => {
    const client = await connectAs(headlessIdentity, HOME);
    try {
      const r = (await client.callTool({
        name: "portuni_store",
        arguments: { node_id: OTHER, local_path: "/tmp/nope.md" },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.equal(r.isError, true);
      const payload = JSON.parse(r.content[0].text);
      assert.equal(payload.error, "write_refused");
    } finally {
      await closeClient(client);
    }
  });

  it("interactive (non-headless) session: a non-home node elicits rather than being refused outright", async () => {
    const client = await connectAs(taskIdentity, HOME);
    try {
      const r = (await client.callTool({
        name: "portuni_mirror",
        arguments: { node_id: OTHER, targets: ["local"] },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.equal(r.isError, true);
      const payload = JSON.parse(r.content[0].text);
      assert.equal(payload.error, "write_expansion_required");
    } finally {
      await closeClient(client);
    }
  });

  // #206: writableNodes used to be rebuilt empty on every tool call, so an
  // accepted write dialog was forgotten immediately and the user was
  // re-prompted on every write to the same node. It must now be remembered
  // for the life of the local session.
  it("an accepted write grant is remembered: a second write to the same node does not re-prompt", async () => {
    // Tracks this local server's own standalone GET/SSE stream the same way
    // startStubCentral's openGets() does above: a server-initiated request
    // (the elicitation dialog) can only be delivered once the client's
    // standalone GET stream is open, and that stream is established
    // asynchronously just after client.connect() resolves -- calling a tool
    // that triggers a push before it is up would leave the push with
    // nowhere to go until the client reconnects, well past this test's
    // patience. waitFor(() => openGets() >= 1) below is the same guard the
    // top-level before() hook already uses for the OTHER standalone stream
    // in this file (the front door's own upstream connection to the stub).
    let openGets = 0;
    const server = createServer((req, res) => {
      if (req.method === "GET") {
        openGets++;
        res.on("close", () => {
          openGets--;
        });
      }
      void agentTransport.handle(req, res, taskIdentity);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    const client = new Client(
      { name: "write-persist-test", version: "0.0.0" },
      { capabilities: { elicitation: {} } },
    );
    let elicitCalls = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicitCalls++;
      return { action: "accept", content: { confirm: true } };
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp?home_node_id=${HOME}`)),
    );
    try {
      const streamReady = await waitFor(() => openGets >= 1);
      assert.ok(streamReady, "client's standalone GET stream never opened");

      const call = () =>
        client.callTool({
          name: "portuni_mirror",
          arguments: { node_id: OTHER, targets: ["local"] },
        }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

      const r1 = await call();
      assert.equal(elicitCalls, 1, "first write to a non-home node must elicit once");
      assert.doesNotMatch(r1.content[0].text, /write_expansion_required|write_refused/);

      const r2 = await call();
      assert.equal(elicitCalls, 1, "second write to the SAME node must not re-prompt");
      assert.doesNotMatch(r2.content[0].text, /write_expansion_required|write_refused/);
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

// #206: the front door forwarded the whole downstream capabilities object
// upstream, even though only elicitation has a reverse handler -- a
// central-initiated sampling/roots request would get "method not found"
// instead of never being offered. Only elicitation should be advertised.
describe("agent MCP front door: capability filtering", () => {
  it("advertises only elicitation upstream, even when the real client declares more", async () => {
    const server = createServer((req, res) => {
      void agentTransport.handle(req, res, taskIdentity);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    const client = new Client(
      { name: "capability-filter-test", version: "0.0.0" },
      { capabilities: { elicitation: {}, sampling: {}, roots: { listChanged: true } } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const r = (await client.callTool({
        name: "portuni_test_capabilities",
        arguments: {},
      })) as { content: Array<{ text: string }> };
      const seen = JSON.parse(r.content[0].text);
      // The SDK normalizes an empty elicitation capability to { form: {} }
      // (backwards-compat default) when the server reads it back via
      // getClientCapabilities() -- the point under test is that sampling and
      // roots, which this front door has no reverse handler for, did not
      // survive the trip.
      assert.deepEqual(seen, { elicitation: { form: {} } });
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

// The front-door round trip (#188): a server-initiated elicitation request
// from central has to travel central -> agent-transport's upstream Client
// (a server-initiated request arriving on what is, from this process's
// point of view, a Client) -> the reverse handler registered in
// buildAgentServer -> the real downstream Server's own elicitInput -> the
// actual connected local client -> and the answer has to flow all the way
// back to unblock central's original call. Exercised via
// portuni_test_elicit on the stub central (added above).
describe("agent MCP front door: elicitation round trip", () => {
  async function connectElicitationCapable(
    dialogAnswer: "accept" | "decline",
  ): Promise<{ client: Client; server: Server }> {
    const server = createServer((req, res) => {
      void agentTransport.handle(req, res, taskIdentity);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    const client = new Client(
      { name: "elicit-round-trip-test", version: "0.0.0" },
      { capabilities: { elicitation: {} } },
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: dialogAnswer,
      content: dialogAnswer === "accept" ? { confirm: true } : undefined,
    }));
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    return { client, server };
  }

  it("relays an elicitInput call from central all the way down to the real client and back: accept", async () => {
    const { client, server } = await connectElicitationCapable("accept");
    try {
      const r = (await client.callTool({
        name: "portuni_test_elicit",
        arguments: { message: "Confirm the round trip?" },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.equal(r.isError, undefined, JSON.stringify(r));
      const result = JSON.parse(r.content[0].text);
      assert.equal(result.action, "accept");
      assert.equal(result.content.confirm, true);
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("relays a decline answer back to central too", async () => {
    const { client, server } = await connectElicitationCapable("decline");
    try {
      const r = (await client.callTool({
        name: "portuni_test_elicit",
        arguments: { message: "Confirm the round trip?" },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.equal(r.isError, undefined, JSON.stringify(r));
      const result = JSON.parse(r.content[0].text);
      assert.equal(result.action, "decline");
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});
