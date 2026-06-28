// Global role enforcement: TOOL_MIN_SCOPE completeness, minScopeForRoute
// correctness, scopeAtLeast integration, and MCP integration test with a
// lower-scope identity.
//
// REST gate is tested via gateRoute() (extracted unit function) rather than
// a full HTTP server spin-up: env mode always yields admin so a real HTTP
// call would never hit the gate. The gateRoute function lives in
// src/auth/min-scopes.ts and is a pure function, making it straightforward
// to unit-test without HTTP machinery.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient as createDbClient, type Client as DbClient } from "@libsql/client";
import { ulid } from "ulid";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_MIN_SCOPE, minScopeForRoute, gateRoute } from "../apps/server/auth/min-scopes.js";
import { scopeAtLeast } from "../apps/server/auth/roles.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { createMcpServer } from "../apps/server/mcp/server.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

// ---------------------------------------------------------------------------
// Unit tests — no server needed
// ---------------------------------------------------------------------------

describe("TOOL_MIN_SCOPE map", () => {
  it("every registered MCP tool has an explicit min scope", () => {
    assert.equal(Object.keys(TOOL_MIN_SCOPE).length, 46);
    assert.equal(TOOL_MIN_SCOPE.portuni_get_node, "read");
    assert.equal(TOOL_MIN_SCOPE.portuni_log, "write");
    assert.equal(TOOL_MIN_SCOPE.portuni_create_node, "manage");
    assert.equal(TOOL_MIN_SCOPE.portuni_delete_node, "admin");
  });

  it("portuni_resolve is write (event state mutation)", () => {
    assert.equal(TOOL_MIN_SCOPE.portuni_resolve, "write");
  });
});

describe("minScopeForRoute", () => {
  it("maps GET /graph -> read", () => {
    assert.equal(minScopeForRoute("GET", "/graph"), "read");
  });

  it("maps POST /events -> write", () => {
    assert.equal(minScopeForRoute("POST", "/events"), "write");
  });

  it("maps POST /nodes -> manage", () => {
    assert.equal(minScopeForRoute("POST", "/nodes"), "manage");
  });

  it("maps DELETE /nodes/:id -> admin", () => {
    assert.equal(minScopeForRoute("DELETE", "/nodes/01ABC"), "admin");
  });

  it("maps GET /me -> read", () => {
    assert.equal(minScopeForRoute("GET", "/me"), "read");
  });

  it("maps unknown route -> admin (fail-closed)", () => {
    assert.equal(minScopeForRoute("GET", "/unknown-future-route"), "admin");
  });

  it("maps GET /health -> read", () => {
    assert.equal(minScopeForRoute("GET", "/health"), "read");
  });

  it("maps POST /auth/login -> read", () => {
    assert.equal(minScopeForRoute("POST", "/auth/login"), "read");
  });

  it("maps DELETE /actors/:id -> admin", () => {
    assert.equal(minScopeForRoute("DELETE", "/actors/01XYZ"), "admin");
  });

  it("maps PATCH /nodes/:id -> manage", () => {
    assert.equal(minScopeForRoute("PATCH", "/nodes/01ABC"), "manage");
  });
});

describe("scopeAtLeast drives allow/deny", () => {
  it("write < manage (portuni_create_node) -> false", () => {
    assert.equal(scopeAtLeast("write", TOOL_MIN_SCOPE.portuni_create_node), false);
  });

  it("manage >= manage (portuni_create_node) -> true", () => {
    assert.equal(scopeAtLeast("manage", TOOL_MIN_SCOPE.portuni_create_node), true);
  });

  it("read < write (portuni_log) -> false", () => {
    assert.equal(scopeAtLeast("read", TOOL_MIN_SCOPE.portuni_log), false);
  });

  it("admin >= admin (portuni_delete_node) -> true", () => {
    assert.equal(scopeAtLeast("admin", TOOL_MIN_SCOPE.portuni_delete_node), true);
  });
});

describe("gateRoute (REST gate unit test)", () => {
  it("read identity denied POST /nodes (requires manage)", () => {
    const r = gateRoute({ globalScope: "read" }, "POST", "/nodes");
    assert.equal(r.allowed, false);
    assert.equal(r.required, "manage");
  });

  it("manage identity allowed POST /nodes", () => {
    const r = gateRoute({ globalScope: "manage" }, "POST", "/nodes");
    assert.equal(r.allowed, true);
  });

  it("write identity denied DELETE /nodes/:id (requires admin)", () => {
    const r = gateRoute({ globalScope: "write" }, "DELETE", "/nodes/01ABC");
    assert.equal(r.allowed, false);
    assert.equal(r.required, "admin");
  });

  it("read identity allowed GET /graph", () => {
    const r = gateRoute({ globalScope: "read" }, "GET", "/graph");
    assert.equal(r.allowed, true);
  });

  it("read identity allowed POST /auth/login", () => {
    const r = gateRoute({ globalScope: "read" }, "POST", "/auth/login");
    assert.equal(r.allowed, true);
  });

  it("any identity denied unknown future route (fail-closed -> admin)", () => {
    const r = gateRoute({ globalScope: "manage" }, "GET", "/secret-admin-panel");
    assert.equal(r.allowed, false);
    assert.equal(r.required, "admin");
  });

  it("read identity cannot mint or revoke device tokens", () => {
    assert.equal(gateRoute({ globalScope: "read" }, "POST", "/device-tokens").allowed, false);
    assert.equal(gateRoute({ globalScope: "read" }, "DELETE", "/device-tokens/01ABC").allowed, false);
    assert.equal(gateRoute({ globalScope: "read" }, "GET", "/device-tokens").allowed, true);
    assert.equal(gateRoute({ globalScope: "read" }, "POST", "/auth/login").allowed, true);
  });
});

// ---------------------------------------------------------------------------
// MCP integration test with lower-scope identity
// ---------------------------------------------------------------------------

let workspace: string;
let db: DbClient;
let readClient: Client;
let orgId: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-auth-enforce-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();

  db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);

  orgId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [orgId, "organization", "TestOrg", "test-org", "01SOLO0000000000000000000"],
  });

  // Build a server with globalScope: "read"
  const readIdentity: RequestIdentity = {
    userId: "01READ0000000000000000001",
    email: "reader@example.com",
    name: "Reader",
    globalScope: "read",
    groups: [],
    via: "session_jwt",
  };

  const { server } = createMcpServer(readIdentity);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  readClient = new Client(
    { name: "portuni-auth-enforce-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await readClient.connect(clientTransport);
});

after(async () => {
  await readClient.close();
  setDbForTesting(null);
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

describe("MCP gate with read-scope identity", () => {
  it("portuni_create_node (manage) is forbidden for read identity", async () => {
    const result = await readClient.callTool({
      name: "portuni_create_node",
      arguments: { type: "project", name: "Forbidden", organization_id: orgId },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { error: string; required_scope: string };
    assert.equal(parsed.error, "forbidden");
    assert.equal(parsed.required_scope, "manage");
  });

  it("portuni_list_nodes (read) is allowed for read identity", async () => {
    const result = await readClient.callTool({
      name: "portuni_list_nodes",
      arguments: {},
    });
    assert.notEqual(result.isError, true);
  });
});
