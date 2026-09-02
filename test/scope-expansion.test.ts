// Tests for the parts of the edge-reachability expansion issue that need a
// full schema + registered tool (not just the pure scope.ts helpers covered
// in scope.test.ts / scope-fixes.test.ts):
//   - portuni_create_node adds the new node to the session's read AND write
//     set automatically.
//   - portuni_expand_scope classifies accepted nodes as addedVia edge vs
//     disconnected, independent of what the agent's `reason` claims.
//   - headless sessions cannot override a hard floor with
//     confirmed_hard_floor.
//
// Spec: docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Read scope").

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
import { SessionScope } from "../apps/server/mcp/scope.js";
import { createDiskProjector } from "../apps/server/mcp/disk-projection.js";
import { registerNodeTools } from "../apps/server/mcp/tools/nodes.js";
import { registerScopeTools } from "../apps/server/mcp/tools/scope.js";
import type { SessionCtx } from "../apps/server/mcp/server.js";
import type { Elicitor } from "../apps/server/mcp/elicit.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

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

function fakeElicitor(outcome: "accept" | "decline"): Elicitor {
  return { confirm: async () => outcome };
}

async function connect(
  scope: SessionScope,
  ident: RequestIdentity,
  elicit?: Elicitor,
): Promise<{ client: McpClient; scope: SessionScope }> {
  const projector = createDiskProjector({ userId: ident.userId, scope });
  const ctx: SessionCtx = { scope, identity: ident, projector, elicit };
  const server = new McpServer({ name: "scope-expansion-test", version: "0.0.1" }, {});
  registerNodeTools(server, ctx);
  registerScopeTools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "scope-expansion-test-client", version: "0.0.1" }, { capabilities: {} });
  await server.connect(serverT);
  await client.connect(clientT);
  return { client, scope };
}

let workspace: string;
let db: DbClient;
let orgId: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-scope-expansion-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);

  orgId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [orgId, "organization", "Acme", "acme", SOLO],
  });
});

after(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

describe("portuni_create_node: auto read + write scope", () => {
  it("adds the created node to both the read and write set", async () => {
    const scope = new SessionScope("interactive_task");
    const { client } = await connect(scope, identity());

    const result = (await client.callTool({
      name: "portuni_create_node",
      arguments: { type: "project", name: "New Project", organization_id: orgId },
    })) as ToolResult;
    assert.equal(result.isError, undefined);
    const { id } = payloadOf(result) as { id: string };

    assert.equal(scope.has(id), true, "created node enters the read set");
    assert.equal(scope.canWrite(id), true, "created node enters the write set");
    const expansions = scope.expansions();
    const created = expansions.find((e) => e.node_ids.includes(id));
    assert.equal(created?.addedVia, "created");
  });
});

describe("portuni_expand_scope: server-classified reachability", () => {
  it("classifies an edge-reachable node as addedVia edge, even if the agent's reason claims otherwise", async () => {
    const homeId = ulid();
    const neighborId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [homeId, "project", "Home", "home", SOLO],
    });
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [neighborId, "process", "Neighbor", "neighbor", SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [ulid(), homeId, neighborId, "related_to", SOLO],
    });

    const scope = new SessionScope("interactive_task");
    scope.add(homeId);
    const { client } = await connect(scope, identity());

    const result = (await client.callTool({
      name: "portuni_expand_scope",
      arguments: {
        node_ids: [neighborId],
        reason: "user-requested: totally unrelated, definitely not connected",
      },
    })) as ToolResult;
    const payload = payloadOf(result) as { added: string[]; added_via: Record<string, string> };
    assert.deepEqual(payload.added, [neighborId]);
    assert.equal(payload.added_via[neighborId], "edge");
  });

  it("classifies a disconnected node as addedVia disconnected", async () => {
    const farId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [farId, "process", "Far", "far", SOLO],
    });

    const scope = new SessionScope("headless");
    const { client } = await connect(scope, identity({ via: "device_token", headless: true }));

    const result = (await client.callTool({
      name: "portuni_expand_scope",
      arguments: { node_ids: [farId], reason: "headless jump, investigating an incident" },
    })) as ToolResult;
    const payload = payloadOf(result) as { added: string[]; added_via: Record<string, string> };
    assert.deepEqual(payload.added, [farId]);
    assert.equal(payload.added_via[farId], "disconnected");
  });

  it("refuses a hard-floor node for a headless session even with confirmed_hard_floor: true", async () => {
    // meta.scope_sensitive is used here (rather than visibility=private
    // owned by another user) because a private-other node is already hidden
    // by the group-visibility gate that runs before the hard-floor check --
    // scope_sensitive is the hard floor reachable through a visible node.
    const sensitiveId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by, meta) VALUES (?, ?, ?, ?, ?, ?)",
      args: [sensitiveId, "process", "Sensitive", "sensitive-node", SOLO, JSON.stringify({ scope_sensitive: true })],
    });

    const scope = new SessionScope("headless");
    const { client } = await connect(scope, identity({ via: "device_token", headless: true }));

    const result = (await client.callTool({
      name: "portuni_expand_scope",
      arguments: {
        node_ids: [sensitiveId],
        reason: "headless jump",
        confirmed_hard_floor: true,
      },
    })) as ToolResult;
    const payload = payloadOf(result) as {
      added: string[];
      refused_hard_floor: Array<{ node_id: string; permanent: boolean }>;
    };
    assert.deepEqual(payload.added, []);
    assert.equal(payload.refused_hard_floor.length, 1);
    assert.equal(payload.refused_hard_floor[0].node_id, sensitiveId);
    assert.equal(payload.refused_hard_floor[0].permanent, true);
    assert.equal(scope.has(sensitiveId), false);
  });
});

describe("portuni_expand_scope: writable expansion requires elicitation (#206)", () => {
  it("grants write access when the elicitation dialog is accepted", async () => {
    const targetId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [targetId, "process", "Target", "target-accept", SOLO],
    });

    const scope = new SessionScope("interactive_task");
    const { client } = await connect(scope, identity(), fakeElicitor("accept"));

    const result = (await client.callTool({
      name: "portuni_expand_scope",
      arguments: {
        node_ids: [targetId],
        reason: "user-confirmed-in-chat",
        writable: true,
      },
    })) as ToolResult;
    const payload = payloadOf(result) as { added: string[]; writable: string[] };
    assert.deepEqual(payload.added, [targetId]);
    assert.deepEqual(payload.writable, [targetId]);
    assert.equal(scope.canWrite(targetId), true);
  });

  it("refuses the write grant (without self-granting) when the dialog is declined", async () => {
    const targetId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [targetId, "process", "Target", "target-decline", SOLO],
    });

    const scope = new SessionScope("interactive_task");
    const { client } = await connect(scope, identity(), fakeElicitor("decline"));

    const result = (await client.callTool({
      name: "portuni_expand_scope",
      arguments: {
        node_ids: [targetId],
        reason: "user-confirmed-in-chat",
        writable: true,
      },
    })) as ToolResult;
    const payload = payloadOf(result) as {
      added: string[];
      refused_write: Array<{ node_id: string }>;
    };
    assert.deepEqual(payload.added, []);
    assert.equal(payload.refused_write.length, 1);
    assert.equal(payload.refused_write[0].node_id, targetId);
    assert.equal(scope.canWrite(targetId), false);
    assert.equal(scope.has(targetId), false);
  });

  it("refuses the write grant outright when the client has no elicitation capability (no honor-system fallback)", async () => {
    const targetId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [targetId, "process", "Target", "target-unsupported", SOLO],
    });

    const scope = new SessionScope("interactive_task");
    // No elicitor passed at all -- equivalent to a client that never
    // declared the elicitation capability.
    const { client } = await connect(scope, identity());

    const result = (await client.callTool({
      name: "portuni_expand_scope",
      arguments: {
        node_ids: [targetId],
        reason: "user-requested: give me write access",
        writable: true,
      },
    })) as ToolResult;
    const payload = payloadOf(result) as {
      added: string[];
      refused_write: Array<{ node_id: string }>;
    };
    assert.deepEqual(payload.added, []);
    assert.equal(payload.refused_write.length, 1);
    assert.equal(scope.canWrite(targetId), false);
  });
});
