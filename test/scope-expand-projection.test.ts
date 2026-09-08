// #252: portuni_expand_scope projects each accepted node onto disk (when it
// has a local mirror on this device) instead of leaving `projected` always
// empty, and portuni_get_node exposes readable_path -- the actual disk path
// to read from, distinct from local_mirror (registration metadata only).

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { createDiskProjector } from "../apps/server/mcp/disk-projection.js";
import { registerScopeTools } from "../apps/server/mcp/tools/scope.js";
import { registerGetNodeTool } from "../apps/server/mcp/tools/get-node.js";
import type { SessionCtx } from "../apps/server/mcp/server.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

const SOLO = "01SOLO0000000000000000000";

function identity(): RequestIdentity {
  return {
    userId: SOLO,
    email: "solo@x.com",
    name: "Solo",
    globalScope: "manage",
    groups: [],
    groupIds: [],
    via: "env",
  };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function payloadOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

async function connect(scope: SessionScope): Promise<McpClient> {
  const projector = createDiskProjector({ userId: SOLO, scope });
  const ctx: SessionCtx = { scope, identity: identity(), projector };
  const server = new McpServer({ name: "scope-expand-projection-test", version: "0.0.1" }, {});
  registerScopeTools(server, ctx);
  registerGetNodeTool(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "scope-expand-projection-test-client", version: "0.0.1" }, { capabilities: {} });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

let workspace: string;
let db: DbClient;
let homeId: string;
let homeMirror: string;
let originalPortuniRoot: string | undefined;

before(async () => {
  db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);
});

after(async () => {
  setDbForTesting(null);
});

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-scope-expand-proj-"));
  originalPortuniRoot = process.env.PORTUNI_ROOT;
  process.env.PORTUNI_ROOT = workspace;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();

  homeId = ulid();
  homeMirror = join(workspace, "home");
  await mkdir(join(homeMirror, "wip"), { recursive: true });
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [homeId, "project", "Home", "home-" + homeId, SOLO],
  });
  await registerMirror(SOLO, homeId, homeMirror);
});

afterEach(async () => {
  if (originalPortuniRoot === undefined) delete process.env.PORTUNI_ROOT;
  else process.env.PORTUNI_ROOT = originalPortuniRoot;
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

describe("portuni_expand_scope: disk projection (#252)", () => {
  it("projects an accepted node that has a local mirror on this device", async () => {
    const targetId = ulid();
    const targetMirror = join(workspace, "target");
    await mkdir(join(targetMirror, "wip"), { recursive: true });
    await writeFile(join(targetMirror, "wip", "x.md"), "hi\n");
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [targetId, "process", "Target", "target-" + targetId, SOLO],
    });
    await registerMirror(SOLO, targetId, targetMirror);

    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = homeId;
    scope.projectionSessionId = "SESS";
    scope.addSeed(homeId);
    const client = await connect(scope);

    const result = (await client.callTool({
      name: "portuni_expand_scope",
      arguments: { node_ids: [targetId], reason: "user-requested: test" },
    })) as ToolResult;
    const payload = payloadOf(result) as {
      projected: Record<string, string>;
      not_projected: Record<string, string>;
    };
    assert.ok(payload.projected[targetId], "target has an entry in projected");
    assert.match(payload.projected[targetId], /SESS/);
    assert.deepEqual(payload.not_projected, {});
  });

  it("reports not_projected with a reason for an accepted node with no local mirror", async () => {
    const targetId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [targetId, "process", "NoMirror", "no-mirror-" + targetId, SOLO],
    });

    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = homeId;
    scope.projectionSessionId = "SESS";
    scope.addSeed(homeId);
    const client = await connect(scope);

    const result = (await client.callTool({
      name: "portuni_expand_scope",
      arguments: { node_ids: [targetId], reason: "user-requested: test" },
    })) as ToolResult;
    const payload = payloadOf(result) as {
      projected: Record<string, string>;
      not_projected: Record<string, string>;
    };
    assert.deepEqual(payload.projected, {});
    assert.equal(payload.not_projected[targetId], "no_mirror");
  });
});

describe("portuni_get_node: readable_path (#252)", () => {
  it("is the real mirror for the home node", async () => {
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = homeId;
    scope.projectionSessionId = "SESS";
    scope.addSeed(homeId);
    const client = await connect(scope);

    const result = (await client.callTool({
      name: "portuni_get_node",
      arguments: { node_id: homeId },
    })) as ToolResult;
    const node = payloadOf(result) as { readable_path: string | null };
    assert.equal(node.readable_path, homeMirror);
  });

  it("is this session's projection dir for an ad-hoc in-scope node with a local mirror", async () => {
    const targetId = ulid();
    const targetMirror = join(workspace, "target2");
    await mkdir(join(targetMirror, "wip"), { recursive: true });
    await writeFile(join(targetMirror, "wip", "y.md"), "hey\n");
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
      args: [targetId, "process", "Target2", "target2-" + targetId, SOLO],
    });
    await registerMirror(SOLO, targetId, targetMirror);

    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = homeId;
    scope.projectionSessionId = "SESS";
    scope.addSeed(homeId);
    scope.add(targetId);
    const client = await connect(scope);

    const result = (await client.callTool({
      name: "portuni_get_node",
      arguments: { node_id: targetId },
    })) as ToolResult;
    const node = payloadOf(result) as { readable_path: string | null; local_mirror: { local_path: string } };
    assert.match(node.readable_path ?? "", /SESS/);
    // local_mirror stays the raw registration path -- distinct from readable_path.
    assert.equal(node.local_mirror.local_path, targetMirror);
  });
});
