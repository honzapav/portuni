// Regression test: MCP request identity flows through to audit_log and
// created_by columns. Must PASS before the SOLO_USER refactor (env mode
// identity has userId = SOLO_USER) and remain green after it.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient as createDbClient, type Client as DbClient } from "@libsql/client";
import { ulid } from "ulid";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { createMcpServer, buildDefaultEnvIdentity } from "../apps/server/mcp/server.js";

const SOLO_USER_ID = "01SOLO0000000000000000000";

let workspace: string;
let db: DbClient;
let mcpClient: Client;
let orgId: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-mcp-identity-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();

  db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);

  orgId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [orgId, "organization", "Acme", "acme", SOLO_USER_ID],
  });

  const { server } = createMcpServer(buildDefaultEnvIdentity());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client(
    { name: "portuni-identity-test-client", version: "0.0.1" },
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

describe("MCP identity attribution", () => {
  it("portuni_create_node stamps SOLO_USER on audit_log and nodes.created_by", async () => {
    const result = await mcpClient.callTool({
      name: "portuni_create_node",
      arguments: {
        type: "project",
        name: "Attribution Test Project",
        organization_id: orgId,
      },
    });

    assert.notEqual(result.isError, true, "portuni_create_node should succeed");
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    const nodeId: string = payload.id;
    assert.ok(nodeId, "response should contain a node id");

    // (a) nodes.created_by must be SOLO_USER
    const nodeRow = await db.execute({
      sql: "SELECT created_by FROM nodes WHERE id = ?",
      args: [nodeId],
    });
    assert.equal(nodeRow.rows.length, 1, "node should exist in DB");
    assert.equal(
      nodeRow.rows[0].created_by,
      SOLO_USER_ID,
      "nodes.created_by should be SOLO_USER",
    );

    // (b) audit_log row for create_node must have user_id = SOLO_USER
    const auditRow = await db.execute({
      sql: "SELECT user_id FROM audit_log WHERE target_id = ? AND action = 'create_node'",
      args: [nodeId],
    });
    assert.equal(auditRow.rows.length, 1, "audit_log should have one create_node row");
    assert.equal(
      auditRow.rows[0].user_id,
      SOLO_USER_ID,
      "audit_log.user_id should be SOLO_USER",
    );
  });
});
