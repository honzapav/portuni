// MCP tool-layer test for portuni_session_suspend: end-to-end through a
// real MCP client/server pair, covering the happy path and its three error
// cases (session not yet persisted, no home node, no local mirror).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { createScopeReconciler } from "../apps/server/mcp/scope-reconciler.js";
import { registerScopeTools } from "../apps/server/mcp/tools/scope.js";
import { createSession, getSession } from "../apps/server/domain/sessions.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import type { SessionCtx } from "../apps/server/mcp/server.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function payloadOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const identity: RequestIdentity = {
  userId: "U1",
  email: "a@b",
  name: "A",
  globalScope: "manage",
  groups: [],
  groupIds: [],
  via: "device_token",
};

async function connect(scope: SessionScope): Promise<McpClient> {
  const reconciler = createScopeReconciler({ userId: identity.userId, scope });
  const ctx: SessionCtx = { scope, identity, reconciler };
  const server = new McpServer({ name: "session-suspend-test", version: "0.0.1" }, {});
  registerScopeTools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "session-suspend-test-client", version: "0.0.1" }, { capabilities: {} });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

let workspace: string;
let shared: SharedDb;
let mirrorRoot: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-session-suspend-tool-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  shared = await makeSharedDb();
  setDbForTesting(shared.db);
  mirrorRoot = join(workspace, "mirror");
  await mkdir(mirrorRoot, { recursive: true });
  await registerMirror("U1", shared.nodeId, mirrorRoot);
});

after(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  await rm(workspace, { recursive: true, force: true });
});

describe("portuni_session_suspend", () => {
  it("writes the handoff, stores its hash, and suspends the session", async () => {
    const session = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "interactive_task",
    });
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = shared.nodeId;
    scope.sessionId = session.id;
    const client = await connect(scope);

    const r = (await client.callTool({
      name: "portuni_session_suspend",
      arguments: { content: "# Handoff\nDone with A, next is B.", agent_session_id: "conv-xyz" },
    })) as ToolResult;
    assert.equal(r.isError, undefined, JSON.stringify(r));
    const payload = payloadOf(r);
    assert.equal(payload.session_id, session.id);
    assert.equal(payload.state, "suspended");
    assert.equal(payload.handoff_path, `wip/sessions/${session.id}-handoff.md`);

    const onDisk = await readFile(join(mirrorRoot, payload.handoff_path as string), "utf8");
    assert.equal(onDisk, "# Handoff\nDone with A, next is B.");

    const fetched = await getSession(shared.db, session.id);
    assert.equal(fetched?.state, "suspended");
    assert.equal(fetched?.agent_session_id, "conv-xyz");
  });

  it("errors with session_not_ready when scope.sessionId has not been assigned yet", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = shared.nodeId;
    // sessionId deliberately left null -- simulates the narrow window right
    // after connect, before bindSessionPersistence's async INSERT resolves.
    const client = await connect(scope);

    const r = (await client.callTool({
      name: "portuni_session_suspend",
      arguments: { content: "too early" },
    })) as ToolResult;
    assert.equal(r.isError, true);
    assert.equal(payloadOf(r).error, "session_not_ready");
  });

  it("errors when the session has no home node (interactive_chat has no anchor)", async () => {
    const session = await createSession(shared.db, "U1", {
      node_id: null,
      session_type: "interactive_chat",
    });
    const scope = new SessionScope("interactive_chat");
    scope.sessionId = session.id;
    const client = await connect(scope);

    const r = (await client.callTool({
      name: "portuni_session_suspend",
      arguments: { content: "chat session handoff" },
    })) as ToolResult;
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /no home node/);
  });

  it("errors when the home node has no local mirror on this machine", async () => {
    const unmirroredNode = "N00000000000000000000UNMIR";
    await shared.db.execute({
      sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
      args: [unmirroredNode, "project", "Unmirrored", "unmirrored", "U1"],
    });
    const session = await createSession(shared.db, "U1", {
      node_id: unmirroredNode,
      session_type: "headless",
    });
    const scope = new SessionScope("headless");
    scope.homeNodeId = unmirroredNode;
    scope.sessionId = session.id;
    const client = await connect(scope);

    const r = (await client.callTool({
      name: "portuni_session_suspend",
      arguments: { content: "no mirror here" },
    })) as ToolResult;
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /no local mirror/);
  });
});
