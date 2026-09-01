// Tests for #205: interactive_chat read scope = permissions, not empty set.
//
// A connector session (claude.ai, Claude Desktop chat) has no anchor and no
// in-memory scope set; guardNodeRead/guardListScope treat it as
// permission-only -- visible means readable, with no edge-reachability or
// expand_scope round trip. See apps/server/mcp/scope.ts (decideRead) and
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Concepts" -- session types table).

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
import { registerEventTools } from "../apps/server/mcp/tools/events.js";
import { registerFileTools } from "../apps/server/mcp/tools/files.js";
import { registerGetNodeTool } from "../apps/server/mcp/tools/get-node.js";
import type { SessionCtx } from "../apps/server/mcp/server.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

const SOLO = "01SOLO0000000000000000000";

function chatIdentity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    userId: SOLO,
    email: "solo@x.com",
    name: "Solo",
    globalScope: "manage",
    groups: [],
    groupIds: [],
    via: "oauth_grant",
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

async function connect(
  scope: SessionScope,
  ident: RequestIdentity,
): Promise<{ client: McpClient; scope: SessionScope }> {
  const projector = createDiskProjector({ userId: ident.userId, scope });
  const ctx: SessionCtx = { scope, identity: ident, projector };
  const server = new McpServer({ name: "chat-scope-test", version: "0.0.1" }, {});
  registerEventTools(server, ctx);
  registerFileTools(server, ctx);
  registerGetNodeTool(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "chat-scope-test-client", version: "0.0.1" }, { capabilities: {} });
  await server.connect(serverT);
  await client.connect(clientT);
  return { client, scope };
}

let workspace: string;
let db: DbClient;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-chat-scope-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);
});

after(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

describe("interactive_chat: portuni_get_node is permission-only", () => {
  it("reads a disconnected, never-in-scope node directly, no scope_expansion_required", async () => {
    const nodeId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [nodeId, "project", "Chat Target", "chat-target", SOLO],
    });

    const scope = new SessionScope("interactive_chat");
    const { client } = await connect(scope, chatIdentity());

    const result = (await client.callTool({
      name: "portuni_get_node",
      arguments: { node_id: nodeId },
    })) as ToolResult;
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const payload = payloadOf(result);
    assert.equal(payload.id, nodeId);
  });

  it("resolves an ambiguous name to visible candidates without a scope set", async () => {
    const idA = ulid();
    const idB = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [idA, "project", "Duplicate", "dup-a", SOLO],
    });
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [idB, "process", "Duplicate", "dup-b", SOLO],
    });

    const scope = new SessionScope("interactive_chat");
    const { client } = await connect(scope, chatIdentity());

    const result = (await client.callTool({
      name: "portuni_get_node",
      arguments: { name: "Duplicate" },
    })) as ToolResult;
    // Both candidates are visible (team, same user): resolves as ambiguous,
    // not as "none in session scope" -- proof the filter is visibility, not
    // the (permanently empty) in-memory scope set.
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /Ambiguous/);
    assert.doesNotMatch(text, /none are in session scope/);
  });
});

describe("interactive_chat: list tools without node_id are permission-only", () => {
  it("portuni_list_events sees events on any visible node, not just the (empty) scope set", async () => {
    const nodeId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [nodeId, "project", "Event Node", "event-node", SOLO],
    });
    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, status, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [ulid(), nodeId, "decision", "Chat-visible event", "active", SOLO],
    });

    const scope = new SessionScope("interactive_chat");
    const { client } = await connect(scope, chatIdentity());

    const result = (await client.callTool({ name: "portuni_list_events", arguments: {} })) as ToolResult;
    assert.equal(result.isError, undefined);
    const events = payloadOf(result) as Array<{ node_id: string }>;
    assert.ok(events.some((e) => e.node_id === nodeId), "expected the event to be listed");
  });

  it("portuni_list_files sees files on any visible node, not just the (empty) scope set", async () => {
    const nodeId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [nodeId, "project", "File Node", "file-node", SOLO],
    });
    await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, status, created_by) VALUES (?, ?, ?, ?, ?)`,
      args: [ulid(), nodeId, "notes.md", "wip", SOLO],
    });

    const scope = new SessionScope("interactive_chat");
    const { client } = await connect(scope, chatIdentity());

    const result = (await client.callTool({ name: "portuni_list_files", arguments: {} })) as ToolResult;
    assert.equal(result.isError, undefined);
    const files = payloadOf(result) as Array<{ node_id: string }>;
    assert.ok(files.some((f) => f.node_id === nodeId), "expected the file to be listed");
  });
});

describe("interactive_task: unaffected by the chat permission-only path", () => {
  it("portuni_list_events without node_id still returns empty on an empty scope set", async () => {
    const nodeId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [nodeId, "project", "Task Node", "task-node", SOLO],
    });
    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, status, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [ulid(), nodeId, "decision", "Not in scope", "active", SOLO],
    });

    const scope = new SessionScope("interactive_task");
    const { client } = await connect(scope, chatIdentity({ via: "device_token" }));

    const result = (await client.callTool({ name: "portuni_list_events", arguments: {} })) as ToolResult;
    assert.equal(result.isError, undefined);
    const events = payloadOf(result) as Array<{ node_id: string }>;
    assert.deepEqual(events, []);
  });
});
