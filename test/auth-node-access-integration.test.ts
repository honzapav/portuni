// Regression tests for group-visibility access-control bypasses.
// Covers: Fix #1 (get_node context edges), Fix #2 (handleUpdateEvent),
// Fix #10 (expand_scope treats hidden as not-found).
//
// Test methodology:
//   - MCP tests: InMemoryTransport + createMcpServer with an outsider identity
//   - REST test:  routeApiRequest with a lightweight mock req/res and an
//                 outsider RequestIdentity constructed directly

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { ulid } from "ulid";
import { createClient as createDbClient, type Client as DbClient } from "@libsql/client";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureSchemaOn } from "../src/infra/schema.js";
import { setDbForTesting } from "../src/infra/db.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { createMcpServer } from "../src/mcp/server.js";
import { routeApiRequest } from "../src/api/router.js";
import type { RequestIdentity } from "../src/auth/request-identity.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const SOLO = "01SOLO0000000000000000000";

// ---------------------------------------------------------------------------
// Shared DB / node helpers
// ---------------------------------------------------------------------------

async function makeTestDb() {
  const db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  return db;
}

async function insertOrg(db: DbClient, name = "TestOrg") {
  const id = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [id, "organization", name, `org-${id}`, SOLO],
  });
  return id;
}

async function insertNode(
  db: DbClient,
  parentId: string,
  opts: { visibility?: string; accessGroup?: string; name?: string } = {},
) {
  const id = ulid();
  const meta = opts.accessGroup ? JSON.stringify({ access_group: opts.accessGroup }) : null;
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, status, visibility, meta, sync_key, created_by)
          VALUES (?, 'project', ?, 'active', ?, ?, ?, ?)`,
    args: [id, opts.name ?? `node-${id}`, opts.visibility ?? "team", meta, `proj-${id}`, SOLO],
  });
  await db.execute({
    sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
    args: [ulid(), id, parentId, SOLO],
  });
  return id;
}

async function insertEvent(db: DbClient, nodeId: string) {
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO events (id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at)
          VALUES (?, ?, 'decision', 'test event', null, 'active', null, null, ?, ?)`,
    args: [id, nodeId, SOLO, new Date().toISOString()],
  });
  return id;
}

// Outsider identity: manage-scope (not admin), different group
function makeOutsider(groups: string[] = ["other@x.com"]): RequestIdentity {
  return {
    userId: SOLO,
    email: "outsider@x.com",
    name: "Outsider",
    globalScope: "manage",
    groups,
    via: "env",
  };
}

// ---------------------------------------------------------------------------
// Minimal mock req/res for routeApiRequest
// ---------------------------------------------------------------------------

interface MockResponse {
  statusCode: number;
  body: string;
}

function makeMockReqRes(
  method: string,
  pathname: string,
  bodyJson?: unknown,
): { req: IncomingMessage; res: ServerResponse; captured: MockResponse } {
  const captured: MockResponse = { statusCode: 0, body: "" };

  const bodyStr = bodyJson !== undefined ? JSON.stringify(bodyJson) : "";
  const req = new Readable({
    read() {
      if (bodyStr) this.push(Buffer.from(bodyStr));
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = method;
  req.url = pathname;
  req.headers = bodyJson !== undefined ? { "content-type": "application/json" } : {};

  const res = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      captured.body += chunk.toString();
      cb();
    },
  }) as unknown as ServerResponse;
  (res as unknown as { writeHead: (code: number, hdrs?: Record<string, string>) => void }).writeHead =
    (code: number) => {
      captured.statusCode = code;
    };
  (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
    if (data) captured.body += data;
  };

  return { req, res, captured };
}

// ---------------------------------------------------------------------------
// Fix #1: portuni_get_node – edges must NOT leak restricted neighbor
// ---------------------------------------------------------------------------

describe("Fix #1: get_node context edges hide restricted neighbors", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let visibleId: string;
  let restrictedId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-fix1-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    orgId = await insertOrg(db);
    visibleId = await insertNode(db, orgId, { name: "VisibleNode" });
    restrictedId = await insertNode(db, orgId, { visibility: "group", accessGroup: "secret@x.com", name: "RestrictedNode" });

    // Connect the two nodes with a direct edge so they appear as neighbors
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'related_to', ?)",
      args: [ulid(), visibleId, restrictedId, SOLO],
    });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  test("outsider calling get_node on visible node receives edges without restricted peer", async () => {
    const outsider = makeOutsider(["other@x.com"]);
    const { server, scope } = createMcpServer(outsider);

    // Add both nodes to scope so the scope gate doesn't block; we test the group-visibility gate
    scope.add(orgId);
    scope.add(visibleId);
    scope.add(restrictedId);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new McpClient({ name: "test-fix1", version: "0.0.1" }, { capabilities: {} });
    await server.connect(serverT);
    await mcpClient.connect(clientT);

    const result = await mcpClient.callTool({
      name: "portuni_get_node",
      arguments: { node_id: visibleId },
    });

    await mcpClient.close();

    // Must NOT be an error for the visible node
    assert.notEqual(result.isError, true, "visible node should be returned, not an error");

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const payload = JSON.parse(text) as { edges?: Array<{ peer_id: string; peer_name: string }> };

    // The restricted node's ID and name must NOT appear in the edges list
    const edgeIds = (payload.edges ?? []).map((e) => e.peer_id);
    const edgeNames = (payload.edges ?? []).map((e) => e.peer_name);
    assert.ok(
      !edgeIds.includes(restrictedId),
      `restricted node ID must not appear in edges, got: ${JSON.stringify(edgeIds)}`,
    );
    assert.ok(
      !edgeNames.includes("RestrictedNode"),
      `restricted node name must not appear in edges, got: ${JSON.stringify(edgeNames)}`,
    );
  });

  test("member of the group sees the restricted peer in edges", async () => {
    const member = { ...makeOutsider(), groups: ["secret@x.com"], globalScope: "manage" as const };
    const { server, scope } = createMcpServer(member);

    scope.add(orgId);
    scope.add(visibleId);
    scope.add(restrictedId);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new McpClient({ name: "test-fix1-member", version: "0.0.1" }, { capabilities: {} });
    await server.connect(serverT);
    await mcpClient.connect(clientT);

    const result = await mcpClient.callTool({
      name: "portuni_get_node",
      arguments: { node_id: visibleId },
    });
    await mcpClient.close();

    assert.notEqual(result.isError, true, "visible node should succeed for member");
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const payload = JSON.parse(text) as { edges?: Array<{ peer_id: string }> };
    const edgeIds = (payload.edges ?? []).map((e) => e.peer_id);
    assert.ok(
      edgeIds.includes(restrictedId),
      `group member should see restricted peer in edges, got: ${JSON.stringify(edgeIds)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Fix #2: handleUpdateEvent returns 404 for events on restricted nodes
// ---------------------------------------------------------------------------

describe("Fix #2: handleUpdateEvent 404 for event on restricted node", () => {
  let db: DbClient;
  let workspace: string;
  let restrictedId: string;
  let eventId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-fix2-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    const orgId = await insertOrg(db);
    restrictedId = await insertNode(db, orgId, { visibility: "group", accessGroup: "secret@x.com" });
    eventId = await insertEvent(db, restrictedId);
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  test("outsider PATCH /events/:id returns 404 and event is NOT modified", async () => {
    const outsider = makeOutsider(["other@x.com"]);

    const { req, res, captured } = makeMockReqRes(
      "PATCH",
      `/events/${eventId}`,
      { content: "modified by outsider" },
    );

    const url = new URL(`http://localhost/events/${eventId}`);
    await routeApiRequest(req, res, url, outsider);

    assert.equal(captured.statusCode, 404, `expected 404 but got ${captured.statusCode}; body: ${captured.body}`);

    // Verify the event was NOT modified in the DB
    const row = await db.execute({
      sql: "SELECT content FROM events WHERE id = ?",
      args: [eventId],
    });
    assert.equal(row.rows.length, 1, "event should still exist");
    assert.equal(
      row.rows[0].content as string,
      "test event",
      "event content must not have been changed",
    );
  });

  test("admin identity can update the event successfully", async () => {
    const admin: RequestIdentity = {
      userId: SOLO,
      email: "admin@x.com",
      name: "Admin",
      globalScope: "admin",
      groups: [],
      via: "env",
    };

    const { req, res, captured } = makeMockReqRes(
      "PATCH",
      `/events/${eventId}`,
      { content: "updated by admin" },
    );

    const url = new URL(`http://localhost/events/${eventId}`);
    await routeApiRequest(req, res, url, admin);

    assert.equal(captured.statusCode, 200, `expected 200 but got ${captured.statusCode}; body: ${captured.body}`);

    const row = await db.execute({
      sql: "SELECT content FROM events WHERE id = ?",
      args: [eventId],
    });
    assert.equal(row.rows[0].content as string, "updated by admin");
  });
});

// ---------------------------------------------------------------------------
// Fix #10: portuni_expand_scope treats hidden node as not-found
// ---------------------------------------------------------------------------

describe("Fix #10: expand_scope treats restricted node as not-found", () => {
  let db: DbClient;
  let workspace: string;
  let restrictedId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-fix10-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    const orgId = await insertOrg(db);
    restrictedId = await insertNode(db, orgId, { visibility: "group", accessGroup: "secret@x.com" });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  test("outsider expand_scope on restricted node gets it in unknown (not accepted)", async () => {
    const outsider = makeOutsider(["other@x.com"]);
    const { server, scope } = createMcpServer(outsider);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new McpClient({ name: "test-fix10", version: "0.0.1" }, { capabilities: {} });
    await server.connect(serverT);
    await mcpClient.connect(clientT);

    const result = await mcpClient.callTool({
      name: "portuni_expand_scope",
      arguments: {
        node_ids: [restrictedId],
        reason: "adversarial probe",
      },
    });

    await mcpClient.close();

    // The call itself should NOT be an error — expand_scope returns structured JSON
    // even for rejected requests. But the restricted ID must appear in `unknown`, not `added`.
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const payload = JSON.parse(text) as {
      added: string[];
      unknown: string[];
      refused_hard_floor?: unknown[];
    };

    assert.ok(
      !payload.added.includes(restrictedId),
      `restricted ID must NOT be in 'added', got added=${JSON.stringify(payload.added)}`,
    );
    assert.ok(
      payload.unknown.includes(restrictedId),
      `restricted ID must be in 'unknown' (same as nonexistent), got unknown=${JSON.stringify(payload.unknown)}`,
    );

    // Scope must NOT contain the restricted node
    assert.ok(
      !scope.has(restrictedId),
      "scope must not contain the restricted node after failed expand_scope",
    );
  });

  test("member of the group can expand_scope to the restricted node", async () => {
    const member: RequestIdentity = {
      userId: SOLO,
      email: "member@x.com",
      name: "Member",
      globalScope: "manage",
      groups: ["secret@x.com"],
      via: "env",
    };
    const { server, scope } = createMcpServer(member);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new McpClient({ name: "test-fix10-member", version: "0.0.1" }, { capabilities: {} });
    await server.connect(serverT);
    await mcpClient.connect(clientT);

    const result = await mcpClient.callTool({
      name: "portuni_expand_scope",
      arguments: {
        node_ids: [restrictedId],
        reason: "member explicit expansion",
      },
    });

    await mcpClient.close();

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const payload = JSON.parse(text) as { added: string[]; unknown: string[] };

    assert.ok(
      payload.added.includes(restrictedId),
      `group member should have the node in 'added', got added=${JSON.stringify(payload.added)}`,
    );
    assert.ok(
      scope.has(restrictedId),
      "scope must contain the restricted node after successful expand_scope",
    );
  });
});

// ---------------------------------------------------------------------------
// Data source/tool/responsibility write-path guards
// ---------------------------------------------------------------------------

describe("Write-path guards: data_sources, tools, responsibilities", () => {
  let db: DbClient;
  let workspace: string;
  let visibleNodeId: string;
  let restrictedNodeId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-write-guards-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    const orgId = await insertOrg(db);
    visibleNodeId = await insertNode(db, orgId, { name: "VisibleNode" });
    restrictedNodeId = await insertNode(db, orgId, {
      visibility: "group",
      accessGroup: "restricted@x.com",
      name: "RestrictedNode",
    });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  test("outsider MCP portuni_add_data_source on restricted node returns not-found error, DB row NOT created", async () => {
    const outsider = makeOutsider(["other@x.com"]);
    const { server, scope } = createMcpServer(outsider);

    scope.add(restrictedNodeId);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new McpClient(
      { name: "test-write-guard-ds", version: "0.0.1" },
      { capabilities: {} },
    );
    await server.connect(serverT);
    await mcpClient.connect(clientT);

    const result = await mcpClient.callTool({
      name: "portuni_add_data_source",
      arguments: {
        node_id: restrictedNodeId,
        name: "Attempted Data Source",
        description: "Should not be created",
      },
    });

    await mcpClient.close();

    // Must be an error with "not found" message
    assert.equal(result.isError, true, "outsider should get an error");
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.ok(
      text.includes("not found"),
      `error message should mention "not found", got: ${text}`,
    );

    // Verify DB row was NOT created
    const rows = await db.execute({
      sql: "SELECT COUNT(*) as cnt FROM data_sources WHERE node_id = ?",
      args: [restrictedNodeId],
    });
    assert.equal(
      rows.rows[0].cnt as number,
      0,
      "no data source should have been created on the restricted node",
    );
  });

  test("member MCP portuni_add_data_source on restricted node succeeds and creates DB row", async () => {
    const member: RequestIdentity = {
      userId: SOLO,
      email: "member@x.com",
      name: "Member",
      globalScope: "manage",
      groups: ["restricted@x.com"],
      via: "env",
    };
    const { server, scope } = createMcpServer(member);

    scope.add(restrictedNodeId);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new McpClient(
      { name: "test-write-guard-ds-member", version: "0.0.1" },
      { capabilities: {} },
    );
    await server.connect(serverT);
    await mcpClient.connect(clientT);

    const result = await mcpClient.callTool({
      name: "portuni_add_data_source",
      arguments: {
        node_id: restrictedNodeId,
        name: "CRM Airtable",
        description: "Sales data",
      },
    });

    await mcpClient.close();

    // Must succeed (no error)
    assert.notEqual(result.isError, true, "member should be able to add data source");

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const payload = JSON.parse(text) as { node_id?: string; name?: string };

    assert.equal(payload.node_id, restrictedNodeId, "returned row should have correct node_id");
    assert.equal(payload.name, "CRM Airtable", "returned row should have correct name");

    // Verify DB row was created
    const rows = await db.execute({
      sql: "SELECT id, name FROM data_sources WHERE node_id = ?",
      args: [restrictedNodeId],
    });
    assert.equal(rows.rows.length, 1, "exactly one data source should exist on restricted node");
    assert.equal(rows.rows[0].name as string, "CRM Airtable", "data source name should match");
  });
});
