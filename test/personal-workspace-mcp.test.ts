// #575: a personal workspace has no remote (#310), so its MCP server
// registers nothing that pushes, pulls or configures one, its brief and
// portuni://sync-model never offer a remote operation, and portuni_status
// speaks only the local classes. A team workspace's server is unchanged.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, buildDefaultEnvIdentity } from "../apps/server/mcp/server.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { buildSoftHint } from "../apps/server/domain/write-scope.js";
import { makeSharedDb } from "./helpers/shared-db.js";

const REMOTE_TOOLS = [
  "portuni_store",
  "portuni_pull",
  "portuni_setup_remote",
  "portuni_set_routing_policy",
  "portuni_list_remotes",
  "portuni_snapshot",
];

async function connect(): Promise<McpClient> {
  const { server } = createMcpServer(buildDefaultEnvIdentity());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "personal-ws-test", version: "0.0.1" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

afterEach(() => {
  delete process.env.PORTUNI_AUTH_MODE;
  setDbForTesting(null);
});

describe("MCP server in a personal workspace", () => {
  it("registers no remote tool and no Drive setup prompt", async () => {
    const client = await connect();
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      for (const name of REMOTE_TOOLS) assert.ok(!tools.includes(name), `${name} must not be registered`);
      assert.ok(tools.includes("portuni_status"));
      // The Drive setup prompt is the only prompt, so a personal
      // workspace's server offers no prompts capability at all.
      assert.equal(client.getServerCapabilities()?.prompts, undefined);
    } finally {
      await client.close();
    }
  });

  it("never mentions uploading in its brief or sync model", async () => {
    const client = await connect();
    try {
      const brief = client.getInstructions() ?? "";
      assert.ok(!brief.includes("portuni_store"), brief);
      assert.match(brief, /personal workspace/);
      const res = await client.readResource({ uri: "portuni://sync-model" });
      const text = (res.contents[0] as { text: string }).text;
      for (const name of REMOTE_TOOLS) assert.ok(!text.includes(name), `sync model must not offer ${name}`);
      assert.ok(!/Drive/.test(text));
    } finally {
      await client.close();
    }
  });

  it("portuni_status takes no remote and answers only the local classes", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const client = await connect();
    try {
      const status = (await client.listTools()).tools.find((t) => t.name === "portuni_status");
      assert.ok(status);
      const props = (status.inputSchema as { properties: Record<string, unknown> }).properties;
      assert.ok(!("remote_name" in props));
      const result = await client.callTool({ name: "portuni_status", arguments: { node_id: shared.nodeId } });
      assert.notEqual(result.isError, true);
      const body = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["clean", "counts", "deleted_local", "new_local", "truncated"]);
      assert.deepEqual(Object.keys(body.counts as object).sort(), ["clean", "deleted_local", "new_local"]);
    } finally {
      await client.close();
    }
  });
});

describe("MCP server in a team workspace (central server)", () => {
  it("still registers every remote tool, the prompt and the remote brief", async () => {
    process.env.PORTUNI_AUTH_MODE = "google";
    const client = await connect();
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      for (const name of REMOTE_TOOLS) assert.ok(tools.includes(name), `${name} must be registered`);
      const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
      assert.ok(prompts.includes("setup-drive-remote"));
      assert.match(client.getInstructions() ?? "", /portuni_store uploads/);
      const res = await client.readResource({ uri: "portuni://sync-model" });
      assert.match((res.contents[0] as { text: string }).text, /portuni_store/);
    } finally {
      await client.close();
    }
  });
});

describe("PORTUNI_SCOPE.md hint", () => {
  it("offers no remote operation in a personal workspace", () => {
    const hint = buildSoftHint({ currentMirror: "/r/a", portuniRoot: "/r", personalWorkspace: true });
    assert.ok(!hint.includes("portuni_store"));
    assert.ok(!hint.includes("portuni_adopt_files"));
    assert.match(hint, /no remote/);
  });

  it("keeps the remote paragraph in a team workspace", () => {
    const hint = buildSoftHint({ currentMirror: "/r/a", portuniRoot: "/r" });
    assert.match(hint, /portuni_store/);
  });
});
