import { test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
import {
  effectiveAccessGroup,
  canSeeNode,
  filterVisibleNodeIds,
} from "../apps/server/auth/node-access.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient as createDbClient } from "@libsql/client";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { createMcpServer } from "../apps/server/mcp/server.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

const SOLO = "01SOLO0000000000000000000";

async function addNode(db: ReturnType<typeof createDbClient>, parentId: string, visibility: string, accessGroup?: string) {
  const id = ulid();
  const meta = accessGroup ? JSON.stringify({ access_group: accessGroup }) : null;
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, status, visibility, meta, sync_key, created_by)
          VALUES (?, 'project', 'n', 'active', ?, ?, ?, ?)`,
    args: [id, visibility, meta, `project:n-${id}`, SOLO],
  });
  await db.execute({
    sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by)
          VALUES (?, ?, ?, 'belongs_to', ?)`,
    args: [ulid(), id, parentId, SOLO],
  });
  return id;
}

test("group node yields its own access group", async () => {
  const { db, orgId } = await makeSharedDb();
  const a = await addNode(db, orgId, "group", "apollo@x.com");
  assert.equal(await effectiveAccessGroup(db, a), "apollo@x.com");
});

test("child inherits nearest restricted ancestor via belongs_to", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group", "apollo@x.com");
  const child = await addNode(db, restricted, "team");
  assert.equal(await effectiveAccessGroup(db, child), "apollo@x.com");
});

test("unrestricted chain yields null", async () => {
  const { db, orgId, nodeId } = await makeSharedDb();
  assert.equal(await effectiveAccessGroup(db, nodeId), null);
  assert.equal(await effectiveAccessGroup(db, orgId), null);
});

test("canSeeNode: members and admins see, others do not", () => {
  const member = { globalScope: "write" as const, groups: ["apollo@x.com"] };
  const outsider = { globalScope: "manage" as const, groups: ["other@x.com"] };
  const admin = { globalScope: "admin" as const, groups: [] };
  assert.equal(canSeeNode(member, "apollo@x.com"), true);
  assert.equal(canSeeNode(outsider, "apollo@x.com"), false);
  assert.equal(canSeeNode(admin, "apollo@x.com"), true);
  assert.equal(canSeeNode(outsider, null), true, "unrestricted node");
});

// --- Integration tests ---

test("filterVisibleNodeIds: member sees restricted, outsider does not, both see unrestricted", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group", "apollo@x.com");
  const child = await addNode(db, restricted, "team");
  const sibling = await addNode(db, orgId, "team");

  const member = { globalScope: "write" as const, groups: ["apollo@x.com"] };
  const outsider = { globalScope: "manage" as const, groups: ["other@x.com"] };

  const memberVisible = await filterVisibleNodeIds(db, member, [restricted, child, sibling]);
  assert.ok(memberVisible.has(restricted), "member sees restricted");
  assert.ok(memberVisible.has(child), "member sees child of restricted");
  assert.ok(memberVisible.has(sibling), "member sees sibling");

  const outsiderVisible = await filterVisibleNodeIds(db, outsider, [restricted, child, sibling]);
  assert.ok(!outsiderVisible.has(restricted), "outsider cannot see restricted");
  assert.ok(!outsiderVisible.has(child), "outsider cannot see child");
  assert.ok(outsiderVisible.has(sibling), "outsider still sees unrestricted sibling");
});

// --- MCP end-to-end: portuni_get_node on restricted node from outsider returns not-found, not elicit ---

test("portuni_get_node: outsider gets not-found for group-restricted node", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "portuni-node-access-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();

  const db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);

  const orgId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [orgId, "organization", "TestOrg", "testorg", SOLO],
  });

  // Create a group-restricted node belonging to the org
  const restrictedId = await addNode(db, orgId, "group", "apollo@x.com");

  const outsiderIdentity: RequestIdentity = {
    userId: SOLO,
    email: "outsider@x.com",
    name: "Outsider",
    globalScope: "manage",
    groups: ["other@x.com"],
    via: "env",
  };

  const { server, scope } = createMcpServer(outsiderIdentity);

  // Seed the restricted node into scope so the scope gate allows the read
  // (we want to test the group-visibility gate, not the scope gate)
  scope.add(orgId);
  scope.add(restrictedId);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new McpClient(
    { name: "test-node-access-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const result = await mcpClient.callTool({
    name: "portuni_get_node",
    arguments: { node_id: restrictedId },
  });

  await mcpClient.close();
  setDbForTesting(null);
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });

  // Must be an error (not-found equivalent), NOT a scope_expansion_required elicit
  assert.equal(result.isError, true, "should be an error");
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assert.ok(!text.includes("scope_expansion_required"), "must not elicit — that would leak existence");
  assert.ok(
    text.includes("not found") || text.includes("not_found"),
    `expected not-found, got: ${text}`,
  );
});
