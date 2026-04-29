// Smoke test for the MCP layer. Wires a Portuni McpServer to an
// in-memory transport pair and drives it from a real Client. Catches
// drift between MCP tool registrations and the underlying domain
// functions (Zod schemas, tool names, response shapes).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient as createDbClient, type Client as DbClient } from "@libsql/client";
import { ulid } from "ulid";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureSchemaOn } from "../src/infra/schema.js";
import { setDbForTesting } from "../src/infra/db.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { createMcpServer } from "../src/mcp/server.js";

let workspace: string;
let db: DbClient;
let mcpClient: Client;
let orgId: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-mcp-smoke-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();

  db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);

  orgId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [orgId, "organization", "Acme", "acme", "01SOLO0000000000000000000"],
  });

  const { server } = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client(
    { name: "portuni-smoke-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
});

after(async () => {
  await mcpClient.close();
  setDbForTesting(null);
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

describe("MCP smoke", () => {
  it("listTools returns the registered Portuni tools", async () => {
    const result = await mcpClient.listTools();
    const toolNames = result.tools.map((t) => t.name);
    assert.ok(
      toolNames.includes("portuni_create_node"),
      `expected portuni_create_node in ${toolNames.join(", ")}`,
    );
    assert.ok(toolNames.includes("portuni_list_nodes"));
    assert.ok(toolNames.includes("portuni_get_node"));
  });

  it("portuni_create_node enforces the org-invariant via Zod / domain", async () => {
    // Missing organization_id for a non-org type — domain returns isError.
    const orphan = await mcpClient.callTool({
      name: "portuni_create_node",
      arguments: { type: "project", name: "Orphan via MCP" },
    });
    assert.equal(orphan.isError, true);
    const orphanText = (
      orphan.content as Array<{ type: string; text: string }>
    )[0].text;
    assert.match(orphanText, /organization_id is required/);

    // Happy path: project with org_id.
    const created = await mcpClient.callTool({
      name: "portuni_create_node",
      arguments: {
        type: "project",
        name: "Ship via MCP",
        organization_id: orgId,
      },
    });
    assert.notEqual(created.isError, true);
    const createdPayload = JSON.parse(
      (created.content as Array<{ type: string; text: string }>)[0].text,
    );
    assert.equal(createdPayload.type, "project");
    assert.equal(createdPayload.belongs_to, orgId);
  });
});
