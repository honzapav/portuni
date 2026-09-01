// Tests for the write gate: the domain-layer function (guardWrite in
// domain/write-gate.ts) plus its MCP tool-layer wiring (write-gate ->
// guardNodeWrite -> individual tool handlers) and the portuni_expand_scope
// `writable` flag that grants write access ahead of protocol elicitation
// (#188). Spec: docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Write scope", "Enforcement points").

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient as createDbClient, type Client as DbClient } from "@libsql/client";
import { ulid } from "ulid";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { guardWrite, type WriteContext } from "../apps/server/domain/write-gate.js";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { createScopeReconciler } from "../apps/server/mcp/scope-reconciler.js";
import { createElicitor } from "../apps/server/mcp/elicit.js";
import { registerNodeTools } from "../apps/server/mcp/tools/nodes.js";
import { registerGetNodeTool } from "../apps/server/mcp/tools/get-node.js";
import { registerScopeTools } from "../apps/server/mcp/tools/scope.js";
import type { SessionCtx } from "../apps/server/mcp/server.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

describe("guardWrite (domain layer, pure)", () => {
  const HOME = "H";
  const OTHER = "X";

  it("env always allows, regardless of home node or write set", () => {
    const ctx: WriteContext = { sessionType: "env", homeNodeId: null, writableNodes: new Set() };
    assert.equal(guardWrite(ctx, OTHER).kind, "allow");
  });

  for (const sessionType of ["interactive_task", "headless"] as const) {
    it(`${sessionType}: the home node is always writable`, () => {
      const ctx: WriteContext = { sessionType, homeNodeId: HOME, writableNodes: new Set() };
      assert.equal(guardWrite(ctx, HOME).kind, "allow");
    });

    it(`${sessionType}: an explicitly granted (writable) node is allowed`, () => {
      const ctx: WriteContext = { sessionType, homeNodeId: HOME, writableNodes: new Set([OTHER]) };
      assert.equal(guardWrite(ctx, OTHER).kind, "allow");
    });
  }

  it("headless: a node outside the write set is refused outright, not elicited", () => {
    const ctx: WriteContext = { sessionType: "headless", homeNodeId: HOME, writableNodes: new Set() };
    const outcome = guardWrite(ctx, OTHER);
    assert.equal(outcome.kind, "refused");
  });

  it("interactive_task: a node outside the write set elicits (round trip is possible)", () => {
    const ctx: WriteContext = { sessionType: "interactive_task", homeNodeId: HOME, writableNodes: new Set() };
    const outcome = guardWrite(ctx, OTHER);
    assert.equal(outcome.kind, "elicit");
  });

  it("interactive_chat: write set starts empty (no home node) -- every write elicits", () => {
    const ctx: WriteContext = { sessionType: "interactive_chat", homeNodeId: null, writableNodes: new Set() };
    const outcome = guardWrite(ctx, OTHER);
    assert.equal(outcome.kind, "elicit");
  });
});

const SOLO = "01SOLO0000000000000000000";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    userId: SOLO,
    email: "solo@x.com",
    name: "Solo",
    globalScope: "manage",
    groups: [],
    groupIds: [],
    via: "env",
    ...overrides,
  };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function payloadOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

async function connect(scope: SessionScope, ident: RequestIdentity): Promise<McpClient> {
  const reconciler = createScopeReconciler({ userId: ident.userId, scope });
  const ctx: SessionCtx = { scope, identity: ident, reconciler };
  const server = new McpServer({ name: "write-gate-test", version: "0.0.1" }, {});
  registerNodeTools(server, ctx);
  registerScopeTools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "write-gate-test-client", version: "0.0.1" }, { capabilities: {} });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

// Same wiring as connect(), but ctx.elicit is a real Elicitor and the
// client either declares elicitation (dialogAnswer set) or not (undefined,
// the capability-absent fallback path).
async function connectWithElicitation(
  scope: SessionScope,
  ident: RequestIdentity,
  dialogAnswer: "accept" | "decline" | undefined,
): Promise<McpClient> {
  const reconciler = createScopeReconciler({ userId: ident.userId, scope });
  const server = new McpServer({ name: "write-gate-elicit-test", version: "0.0.1" }, {});
  const ctx: SessionCtx = { scope, identity: ident, reconciler, elicit: createElicitor(server) };
  registerNodeTools(server, ctx);
  registerGetNodeTool(server, ctx);
  registerScopeTools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new McpClient(
    { name: "write-gate-elicit-test-client", version: "0.0.1" },
    { capabilities: dialogAnswer !== undefined ? { elicitation: {} } : {} },
  );
  if (dialogAnswer !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: dialogAnswer === "accept" ? "accept" : "decline",
      content: dialogAnswer === "accept" ? { confirm: true } : undefined,
    }));
  }
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

let workspace: string;
let db: DbClient;
let orgId: string;
let homeId: string;
let otherId: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-write-gate-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);

  orgId = ulid();
  homeId = ulid();
  otherId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [orgId, "organization", "Acme", "acme", SOLO],
  });
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [homeId, "project", "Home", "home", SOLO],
  });
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [otherId, "project", "Other", "other", SOLO],
  });
});

after(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

describe("write gate wired into portuni_update_node", () => {
  it("headless session: updating the home node succeeds", async () => {
    const scope = new SessionScope("headless");
    scope.homeNodeId = homeId;
    scope.addSeed(homeId);
    const client = await connect(scope, identity({ via: "device_token", headless: true }));
    const r = (await client.callTool({
      name: "portuni_update_node",
      arguments: { node_id: homeId, name: "Home Renamed" },
    })) as ToolResult;
    assert.equal(r.isError, undefined);
  });

  it("headless session: updating a non-home node is refused outright", async () => {
    const scope = new SessionScope("headless");
    scope.homeNodeId = homeId;
    scope.addSeed(homeId);
    scope.add(otherId); // in read scope, but not write scope
    const client = await connect(scope, identity({ via: "device_token", headless: true }));
    const r = (await client.callTool({
      name: "portuni_update_node",
      arguments: { node_id: otherId, name: "Other Renamed" },
    })) as ToolResult;
    assert.equal(r.isError, true);
    const payload = payloadOf(r);
    assert.equal(payload.error, "write_refused");
    assert.equal(payload.node_id, otherId);
  });

  it("interactive_task session: updating a non-home node elicits rather than refuses", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = homeId;
    scope.addSeed(homeId);
    scope.add(otherId);
    const client = await connect(scope, identity({ via: "device_token" }));
    const r = (await client.callTool({
      name: "portuni_update_node",
      arguments: { node_id: otherId, name: "Other Renamed" },
    })) as ToolResult;
    assert.equal(r.isError, true);
    const payload = payloadOf(r);
    assert.equal(payload.error, "write_expansion_required");
  });

  it("env session: unaffected -- updates outside any home node still succeed (historical behavior)", async () => {
    const scope = new SessionScope("env");
    const client = await connect(scope, identity());
    const r = (await client.callTool({
      name: "portuni_update_node",
      arguments: { node_id: otherId, name: "Other Renamed Again" },
    })) as ToolResult;
    assert.equal(r.isError, undefined);
  });
});

describe("portuni_expand_scope writable flag", () => {
  it("grants write access, letting a subsequent mutation on a previously-refused node succeed", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = homeId;
    scope.addSeed(homeId);
    scope.add(otherId);
    const client = await connect(scope, identity({ via: "device_token" }));

    const refused = (await client.callTool({
      name: "portuni_update_node",
      arguments: { node_id: otherId, name: "Still Refused" },
    })) as ToolResult;
    assert.equal(refused.isError, true);

    const expand = (await client.callTool({
      name: "portuni_expand_scope",
      arguments: { node_ids: [otherId], reason: "user-confirmed-in-chat", writable: true },
    })) as ToolResult;
    assert.equal(expand.isError, undefined);
    const expandPayload = payloadOf(expand) as { writable: string[] };
    assert.deepEqual(expandPayload.writable, [otherId]);
    assert.equal(scope.canWrite(otherId), true);

    const granted = (await client.callTool({
      name: "portuni_update_node",
      arguments: { node_id: otherId, name: "Now Writable" },
    })) as ToolResult;
    assert.equal(granted.isError, undefined);
  });

  it("is rejected outright for headless sessions -- write-set expansion is impossible mid-run", async () => {
    const scope = new SessionScope("headless");
    scope.homeNodeId = homeId;
    scope.addSeed(homeId);
    scope.add(otherId);
    const client = await connect(scope, identity({ via: "device_token", headless: true }));

    const expand = (await client.callTool({
      name: "portuni_expand_scope",
      arguments: { node_ids: [otherId], reason: "headless jump", writable: true },
    })) as ToolResult;
    assert.equal(expand.isError, true);
    const payload = payloadOf(expand);
    assert.equal(payload.error, "write_expansion_impossible");
    assert.equal(scope.canWrite(otherId), false);
  });
});

// Protocol elicitation (#188): an "elicit" classification tries a real
// dialog before falling back to the honor-system convention exercised
// above. Covers the capability-present accept/decline paths and the
// capability-absent fallback for both the write gate and the read gate.
describe("write gate: protocol elicitation", () => {
  it("capability-present, user accepts: grants write access and the mutation succeeds", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = homeId;
    scope.addSeed(homeId);
    scope.add(otherId);
    const client = await connectWithElicitation(scope, identity({ via: "device_token" }), "accept");
    const r = (await client.callTool({
      name: "portuni_update_node",
      arguments: { node_id: otherId, name: "Elicited Write" },
    })) as ToolResult;
    assert.equal(r.isError, undefined);
    assert.equal(scope.canWrite(otherId), true);
  });

  it("capability-present, user declines: falls back to write_expansion_required", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = homeId;
    scope.addSeed(homeId);
    scope.add(otherId);
    const client = await connectWithElicitation(scope, identity({ via: "device_token" }), "decline");
    const r = (await client.callTool({
      name: "portuni_update_node",
      arguments: { node_id: otherId, name: "Should Not Apply" },
    })) as ToolResult;
    assert.equal(r.isError, true);
    assert.equal(payloadOf(r).error, "write_expansion_required");
    assert.equal(scope.canWrite(otherId), false);
  });

  it("capability-absent client: ctx.elicit is set but the client never declared elicitation, so it falls back", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = homeId;
    scope.addSeed(homeId);
    scope.add(otherId);
    const client = await connectWithElicitation(scope, identity({ via: "device_token" }), undefined);
    const r = (await client.callTool({
      name: "portuni_update_node",
      arguments: { node_id: otherId, name: "Should Not Apply Either" },
    })) as ToolResult;
    assert.equal(r.isError, true);
    assert.equal(payloadOf(r).error, "write_expansion_required");
  });

  it("headless sessions never see a dialog, even when ctx.elicit and client capability are both present", async () => {
    const scope = new SessionScope("headless");
    scope.homeNodeId = homeId;
    scope.addSeed(homeId);
    scope.add(otherId);
    const client = await connectWithElicitation(scope, identity({ via: "device_token", headless: true }), "accept");
    const r = (await client.callTool({
      name: "portuni_update_node",
      arguments: { node_id: otherId, name: "Should Still Be Refused" },
    })) as ToolResult;
    assert.equal(r.isError, true);
    assert.equal(payloadOf(r).error, "write_refused");
  });
});

describe("read gate: protocol elicitation", () => {
  it("capability-present, user accepts a disconnected-jump read: auto-adds the node, addedVia elicited", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = homeId;
    scope.addSeed(homeId);
    const client = await connectWithElicitation(scope, identity({ via: "device_token" }), "accept");
    const r = (await client.callTool({
      name: "portuni_get_node",
      arguments: { node_id: otherId },
    })) as ToolResult;
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.equal(scope.has(otherId), true);
    const expansion = scope.expansions().find((e) => e.node_ids.includes(otherId));
    assert.equal(expansion?.addedVia, "elicited");
  });

  it("capability-present, user declines: still returns scope_expansion_required", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = homeId;
    scope.addSeed(homeId);
    const client = await connectWithElicitation(scope, identity({ via: "device_token" }), "decline");
    const r = (await client.callTool({
      name: "portuni_get_node",
      arguments: { node_id: otherId },
    })) as ToolResult;
    assert.equal(r.isError, true);
    assert.equal(payloadOf(r).error, "scope_expansion_required");
    assert.equal(scope.has(otherId), false);
  });
});
