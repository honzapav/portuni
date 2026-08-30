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
    assert.equal(Object.keys(TOOL_MIN_SCOPE).length, 47);
    assert.equal(TOOL_MIN_SCOPE.portuni_get_node, "read");
    assert.equal(TOOL_MIN_SCOPE.portuni_read_file, "read");
    assert.equal(TOOL_MIN_SCOPE.portuni_log, "write");
    assert.equal(TOOL_MIN_SCOPE.portuni_create_node, "write");
    assert.equal(TOOL_MIN_SCOPE.portuni_update_node, "write");
    assert.equal(TOOL_MIN_SCOPE.portuni_move_node, "manage");
    assert.equal(TOOL_MIN_SCOPE.portuni_delete_node, "admin");
  });

  // Everyday editing is write; a read-only account (in the domain but in no
  // group) must not be able to create or edit anything.
  it("editing tools are write, placement is manage, infrastructure is admin", () => {
    for (const tool of [
      "portuni_create_node",
      "portuni_update_node",
      "portuni_connect",
      "portuni_disconnect",
      "portuni_create_actor",
      "portuni_update_actor",
      "portuni_create_responsibility",
      "portuni_update_responsibility",
      "portuni_assign_responsibility",
      "portuni_unassign_responsibility",
      "portuni_add_data_source",
      "portuni_remove_data_source",
      "portuni_add_tool",
      "portuni_remove_tool",
    ]) {
      assert.equal(TOOL_MIN_SCOPE[tool], "write", tool);
    }
    assert.equal(TOOL_MIN_SCOPE.portuni_move_node, "manage");
    assert.equal(TOOL_MIN_SCOPE.portuni_setup_remote, "admin");
    assert.equal(TOOL_MIN_SCOPE.portuni_set_routing_policy, "admin");
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

  it("maps POST /nodes -> write (a read-only account cannot create nodes)", () => {
    assert.equal(minScopeForRoute("POST", "/nodes"), "write");
  });

  it("maps everyday editing routes -> write", () => {
    for (const [method, path] of [
      ["PATCH", "/nodes/01ABC"],
      ["POST", "/edges"],
      ["DELETE", "/edges/01ABC"],
      ["POST", "/actors"],
      ["PATCH", "/actors/01ABC"],
      ["POST", "/responsibilities"],
      ["PATCH", "/responsibilities/01ABC"],
      ["POST", "/responsibilities/01ABC/assignments"],
      ["DELETE", "/responsibilities/01ABC/assignments/01DEF"],
      ["POST", "/data-sources"],
      ["PATCH", "/data-sources/01ABC"],
      ["POST", "/tools"],
      ["PATCH", "/tools/01ABC"],
      ["GET", "/users"],
    ] as const) {
      assert.equal(minScopeForRoute(method, path), "write", `${method} ${path}`);
    }
  });

  it("maps placement and sharing routes -> manage", () => {
    for (const [method, path] of [
      ["POST", "/nodes/01ABC/move"],
      ["PUT", "/nodes/01ABC/access"],
      ["GET", "/auth/groups"],
      ["GET", "/auth/users"],
      ["POST", "/positions"],
    ] as const) {
      assert.equal(minScopeForRoute(method, path), "manage", `${method} ${path}`);
    }
  });

  it("maps DELETE /nodes/:id -> admin", () => {
    assert.equal(minScopeForRoute("DELETE", "/nodes/01ABC"), "admin");
  });

  it("maps GET /me -> read", () => {
    assert.equal(minScopeForRoute("GET", "/me"), "read");
  });

  // Task 14 point 9: GET /users only backs the write-gated actor
  // owner-picker (see the comment in min-scopes.ts) -- same tier as /actors
  // so the full workspace user directory isn't exposed more broadly than
  // the one flow that can act on it.
  it("maps GET /users -> write", () => {
    assert.equal(minScopeForRoute("GET", "/users"), "write");
  });

  it("maps all /sync/drive/* routes -> admin (infrastructure)", () => {
    for (const [method, path] of [
      ["POST", "/sync/drive/connect"],
      ["GET", "/sync/drive/targets"],
      ["POST", "/sync/drive/target"],
      ["GET", "/sync/drive/status"],
      ["POST", "/sync/drive/test"],
      ["POST", "/sync/drive/disconnect"],
    ] as const) {
      assert.equal(minScopeForRoute(method, path), "admin", `${method} ${path}`);
    }
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

  // Locks the min-scopes.ts entry added alongside GET /auth/desktop-config.
  // Without it, the route falls through to the fail-closed "admin" default
  // (see the "maps unknown route" test below) and the google-mode
  // AUTH_PUBLIC_PATHS placeholder identity — which carries "read" — would
  // be 403'd by routeApiRequest's scope gate before ever reaching the
  // handler, silently breaking the endpoint in its actual target mode
  // (env-mode tests can't catch this: the solo identity there is always
  // "admin", so admin >= admin passes regardless of this line).
  it("maps GET /auth/desktop-config -> read", () => {
    assert.equal(minScopeForRoute("GET", "/auth/desktop-config"), "read");
  });

  it("maps DELETE /actors/:id -> admin", () => {
    assert.equal(minScopeForRoute("DELETE", "/actors/01XYZ"), "admin");
  });

  it("maps POST /nodes/:id/move -> manage", () => {
    assert.equal(minScopeForRoute("POST", "/nodes/01ABC/move"), "manage");
  });

  // The remote sweep is a STEP of the teammate (central-mode) sync run, not
  // a configuration action: the agent calls it before its own scan, and
  // every other call that run makes is read/write (sync-info, files/register,
  // GET/PUT /nodes/:id/file). Gating it at "manage" 403s a write-scope
  // teammate and takes the whole "Synchronizovat" run down with it.
  it("maps POST /nodes/:id/sync/remote-sweep -> write (same tier as the rest of the agent sync run)", () => {
    assert.equal(minScopeForRoute("POST", "/nodes/01ABC/sync/remote-sweep"), "write");
  });
});

describe("scopeAtLeast drives allow/deny", () => {
  it("write < manage (portuni_move_node) -> false", () => {
    assert.equal(scopeAtLeast("write", TOOL_MIN_SCOPE.portuni_move_node), false);
  });

  it("write >= write (portuni_update_node) -> true", () => {
    assert.equal(scopeAtLeast("write", TOOL_MIN_SCOPE.portuni_update_node), true);
  });

  it("read < write (portuni_create_node) -> false", () => {
    assert.equal(scopeAtLeast("read", TOOL_MIN_SCOPE.portuni_create_node), false);
  });

  it("read < write (portuni_log) -> false", () => {
    assert.equal(scopeAtLeast("read", TOOL_MIN_SCOPE.portuni_log), false);
  });

  it("admin >= admin (portuni_delete_node) -> true", () => {
    assert.equal(scopeAtLeast("admin", TOOL_MIN_SCOPE.portuni_delete_node), true);
  });
});

describe("gateRoute (REST gate unit test)", () => {
  it("read identity denied PATCH /nodes/:id (requires write)", () => {
    const r = gateRoute({ globalScope: "read" }, "PATCH", "/nodes/01ABC");
    assert.equal(r.allowed, false);
    assert.equal(r.required, "write");
  });

  it("read identity denied POST /nodes, write identity allowed", () => {
    const r = gateRoute({ globalScope: "read" }, "POST", "/nodes");
    assert.equal(r.allowed, false);
    assert.equal(r.required, "write");
    assert.equal(gateRoute({ globalScope: "write" }, "POST", "/nodes").allowed, true);
  });

  it("write identity denied POST /nodes/:id/move (requires manage)", () => {
    const r = gateRoute({ globalScope: "write" }, "POST", "/nodes/01ABC/move");
    assert.equal(r.allowed, false);
    assert.equal(r.required, "manage");
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

  // created_by on nodes is a FK into users -- the read identity below must
  // exist as a row for portuni_create_node to succeed.
  await db.execute({
    sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
    args: ["01READ0000000000000000001", "reader@example.com", "Reader"],
  });

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
    groupIds: [],
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
  it("portuni_update_node (write) is forbidden for read identity", async () => {
    const result = await readClient.callTool({
      name: "portuni_update_node",
      arguments: { node_id: orgId, name: "Forbidden" },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { error: string; required_scope: string };
    assert.equal(parsed.error, "forbidden");
    assert.equal(parsed.required_scope, "write");
  });

  it("portuni_create_node (write) is forbidden for read identity", async () => {
    const result = await readClient.callTool({
      name: "portuni_create_node",
      arguments: { type: "project", name: "Forbidden", organization_id: orgId },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { error: string; required_scope: string };
    assert.equal(parsed.error, "forbidden");
    assert.equal(parsed.required_scope, "write");
  });

  it("portuni_list_nodes (read) is allowed for read identity", async () => {
    const result = await readClient.callTool({
      name: "portuni_list_nodes",
      arguments: {},
    });
    assert.notEqual(result.isError, true);
  });
});
