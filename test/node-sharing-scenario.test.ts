// Integration scenario for the "business partners" sharing use case (Task 10).
// Exercises the full node_access stack end-to-end through the HTTP router:
// two sibling children of an organization get independent group ACLs, and
// we verify visibility (GET /graph, GET /nodes/:id) for three identities
// (admin, an org-team member, a partners-only member), including the
// override-not-merge inheritance semantics when a child's own ACL is
// cleared and control reverts to the parent organization's ACL.
//
// Methodology stolen wholesale from test/api-access.test.ts /
// test/auth-node-access-integration.test.ts: routeApiRequest driven with a
// lightweight mock req/res and RequestIdentity objects constructed directly
// against an in-memory libSQL DB.

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
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import { createMcpServer } from "../apps/server/mcp/server.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const SOLO = "01SOLO0000000000000000000";

// ---------------------------------------------------------------------------
// DB helpers
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
  opts: { visibility?: string; accessGroup?: string; name?: string; accessMode?: "private" | "request" } = {},
) {
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
          VALUES (?, 'project', ?, 'active', ?, ?, ?)`,
    args: [id, opts.name ?? `node-${id}`, opts.visibility ?? "team", `proj-${id}`, SOLO],
  });
  await db.execute({
    sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
    args: [ulid(), id, parentId, SOLO],
  });
  if (opts.accessGroup) {
    await db.execute({
      sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
            VALUES (?, 'group', ?, ?, ?)`,
      args: [id, opts.accessGroup, opts.accessGroup, SOLO],
    });
  }
  if (opts.accessMode) {
    await db.execute({
      sql: "UPDATE nodes SET access_mode = ? WHERE id = ?",
      args: [opts.accessMode, id],
    });
  }
  return id;
}

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

function makeAdmin(): RequestIdentity {
  return {
    userId: SOLO,
    email: "admin@tempo.ooo",
    name: "Admin",
    globalScope: "admin",
    groups: [],
    groupIds: [],
    via: "env",
  };
}

function makeOrgMember(): RequestIdentity {
  return {
    userId: SOLO,
    email: "orgmember@tempo.ooo",
    name: "Org Member",
    globalScope: "manage",
    groups: [],
    groupIds: ["GID_ORG"],
    via: "env",
  };
}

function makePartnersMember(): RequestIdentity {
  return {
    userId: SOLO,
    email: "partner@tempo.ooo",
    name: "Partners Member",
    globalScope: "read",
    groups: [],
    groupIds: ["GID_PART"],
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

async function getGraph(identity: RequestIdentity) {
  const { req, res, captured } = makeMockReqRes("GET", "/graph");
  await routeApiRequest(req, res, new URL("http://localhost/graph"), identity);
  assert.equal(captured.statusCode, 200, `expected 200 from GET /graph, got ${captured.statusCode}; body: ${captured.body}`);
  return JSON.parse(captured.body) as {
    nodes: Array<{ id: string; restricted?: true }>;
    edges: Array<{ source_id: string; target_id: string }>;
  };
}

async function patchNode(identity: RequestIdentity, nodeId: string, body: unknown) {
  const { req, res, captured } = makeMockReqRes("PATCH", `/nodes/${nodeId}`, body);
  await routeApiRequest(req, res, new URL(`http://localhost/nodes/${nodeId}`), identity);
  return captured;
}

async function getNode(identity: RequestIdentity, nodeId: string) {
  const { req, res, captured } = makeMockReqRes("GET", `/nodes/${nodeId}`);
  await routeApiRequest(req, res, new URL(`http://localhost/nodes/${nodeId}`), identity);
  return captured;
}

async function putAccess(identity: RequestIdentity, nodeId: string, entries: unknown[]) {
  const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${nodeId}/access`, { entries });
  await routeApiRequest(req, res, new URL(`http://localhost/nodes/${nodeId}/access`), identity);
  return captured;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

describe("business partners sharing scenario", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let businessPartnersId: string;
  let projektAId: string;

  const admin = makeAdmin();
  const orgMember = makeOrgMember();
  const partnersMember = makePartnersMember();

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-node-sharing-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    // 1. admin creates org + children "Business partners" and "Projekt A"
    orgId = await insertOrg(db, "Acme Org");
    businessPartnersId = await insertNode(db, orgId, { name: "Business partners" });
    projektAId = await insertNode(db, orgId, { name: "Projekt A" });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  test("1. admin restricts the org to GID_ORG and Business partners to GID_PART", async () => {
    const orgAccess = await putAccess(admin, orgId, [
      { kind: "group", principal: "GID_ORG", display_email: "org@tempo.ooo" },
    ]);
    assert.equal(orgAccess.statusCode, 200, `expected 200, got ${orgAccess.statusCode}; body: ${orgAccess.body}`);
    const orgParsed = JSON.parse(orgAccess.body);
    assert.equal(orgParsed.restricted, true);
    assert.equal(orgParsed.source_node_id, orgId);

    const partnersAccess = await putAccess(admin, businessPartnersId, [
      { kind: "group", principal: "GID_PART", display_email: "partners@tempo.ooo" },
    ]);
    assert.equal(
      partnersAccess.statusCode,
      200,
      `expected 200, got ${partnersAccess.statusCode}; body: ${partnersAccess.body}`,
    );
    const partnersParsed = JSON.parse(partnersAccess.body);
    assert.equal(partnersParsed.restricted, true);
    assert.equal(partnersParsed.source_node_id, businessPartnersId);
  });

  test("2. org member sees org + Projekt A, not Business partners; direct GET 404s", async () => {
    const graph = await getGraph(orgMember);
    const ids = graph.nodes.map((n) => n.id);
    assert.ok(ids.includes(orgId), "org member should see the org node");
    assert.ok(ids.includes(projektAId), "org member should see Projekt A (inherits org ACL)");
    assert.ok(!ids.includes(businessPartnersId), "org member must NOT see Business partners (own ACL overrides)");

    const direct = await getNode(orgMember, businessPartnersId);
    assert.equal(direct.statusCode, 404, `expected 404, got ${direct.statusCode}; body: ${direct.body}`);
  });

  test("3. partners member sees only Business partners, not Projekt A or org detail", async () => {
    const graph = await getGraph(partnersMember);
    const ids = graph.nodes.map((n) => n.id);
    assert.ok(ids.includes(businessPartnersId), "partners member should see Business partners");
    assert.ok(!ids.includes(projektAId), "partners member must NOT see Projekt A (inherits org's GID_ORG-only ACL)");
    assert.ok(!ids.includes(orgId), "partners member must NOT see the org node itself");

    const orgDetail = await getNode(partnersMember, orgId);
    assert.equal(
      orgDetail.statusCode,
      404,
      `expected 404 for org detail, got ${orgDetail.statusCode}; body: ${orgDetail.body}`,
    );

    const projektDetail = await getNode(partnersMember, projektAId);
    assert.equal(
      projektDetail.statusCode,
      404,
      `expected 404 for Projekt A detail, got ${projektDetail.statusCode}; body: ${projektDetail.body}`,
    );
  });

  test("4. admin sees everything", async () => {
    const graph = await getGraph(admin);
    const ids = graph.nodes.map((n) => n.id);
    assert.ok(ids.includes(orgId), "admin should see org");
    assert.ok(ids.includes(businessPartnersId), "admin should see Business partners");
    assert.ok(ids.includes(projektAId), "admin should see Projekt A");
  });

  test("5. clearing Business partners' own ACL resumes inheritance from the org", async () => {
    const cleared = await putAccess(admin, businessPartnersId, []);
    assert.equal(cleared.statusCode, 200, `expected 200, got ${cleared.statusCode}; body: ${cleared.body}`);
    const clearedParsed = JSON.parse(cleared.body);
    assert.equal(clearedParsed.restricted, true, "Business partners should now inherit the org's restriction");
    assert.equal(clearedParsed.inherited, true);
    assert.equal(clearedParsed.source_node_id, orgId);

    // org member sees it again (inheritance resumed)
    const orgGraph = await getGraph(orgMember);
    assert.ok(
      orgGraph.nodes.map((n) => n.id).includes(businessPartnersId),
      "org member should see Business partners again once it inherits the org's GID_ORG ACL",
    );

    // partners member must NOT see it anymore (no longer has its own GID_PART ACL)
    const partnersGraph = await getGraph(partnersMember);
    assert.ok(
      !partnersGraph.nodes.map((n) => n.id).includes(businessPartnersId),
      "partners member must lose visibility once Business partners inherits the org's GID_ORG-only ACL",
    );
  });
});

// ---------------------------------------------------------------------------
// Finding 1 (final review wave): loadNodeDetail's edge list must not leak
// peer_id/peer_name/peer_type of a restricted neighbor onto an otherwise
// visible node's detail payload.
// ---------------------------------------------------------------------------

describe("Finding 1: GET /nodes/:id edges hide restricted neighbors", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let visibleChildId: string;
  let restrictedChildId: string;

  const admin = makeAdmin();
  const orgMember = makeOrgMember(); // groupIds: ["GID_ORG"] -- not a member of GID_SECRET

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-edge-leak-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    // Org itself is unrestricted so both identities can load its detail;
    // one child is restricted to a group neither identity below belongs to.
    orgId = await insertOrg(db, "EdgeLeakOrg");
    visibleChildId = await insertNode(db, orgId, { name: "VisibleChild" });
    restrictedChildId = await insertNode(db, orgId, {
      visibility: "group",
      accessGroup: "GID_SECRET",
      name: "RestrictedChild",
    });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  test("org member GETs the org: edges include the visible child, NOT the restricted child", async () => {
    const result = await getNode(orgMember, orgId);
    assert.equal(result.statusCode, 200, `expected 200, got ${result.statusCode}; body: ${result.body}`);
    const parsed = JSON.parse(result.body) as {
      edges: Array<{ peer_id: string; peer_name: string; peer_type: string }>;
    };
    const peerIds = parsed.edges.map((e) => e.peer_id);
    assert.ok(peerIds.includes(visibleChildId), "visible child must appear in edges");
    assert.ok(!peerIds.includes(restrictedChildId), "restricted child must NOT appear in edges");
    assert.ok(
      !parsed.edges.some((e) => e.peer_name === "RestrictedChild"),
      "restricted child's name must not leak through edges either",
    );
  });

  test("admin GETs the org: edges include both children", async () => {
    const result = await getNode(admin, orgId);
    assert.equal(result.statusCode, 200, `expected 200, got ${result.statusCode}; body: ${result.body}`);
    const parsed = JSON.parse(result.body) as { edges: Array<{ peer_id: string }> };
    const peerIds = parsed.edges.map((e) => e.peer_id);
    assert.ok(peerIds.includes(visibleChildId), "admin should see visible child in edges");
    assert.ok(peerIds.includes(restrictedChildId), "admin should see restricted child in edges");
  });
});

// ---------------------------------------------------------------------------
// Task 12: peer_restricted edges (mode='request') + mode in the access API.
// ---------------------------------------------------------------------------

type EdgeWithFlag = {
  peer_id: string;
  peer_name: string;
  peer_type: string;
  peer_restricted?: true;
};

describe("Task 12: peer_restricted edges in REST node detail", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let visibleChildId: string;
  let requestChildId: string;
  let privateChildId: string;

  const admin = makeAdmin();
  const orgMember = makeOrgMember(); // groupIds: ["GID_ORG"] -- not a member of GID_SECRET*

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-peer-restricted-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    orgId = await insertOrg(db, "PeerRestrictedOrg");
    visibleChildId = await insertNode(db, orgId, { name: "VisibleChild" });
    requestChildId = await insertNode(db, orgId, {
      visibility: "group",
      accessGroup: "GID_SECRET_REQUEST",
      name: "RequestChild",
      accessMode: "request",
    });
    privateChildId = await insertNode(db, orgId, {
      visibility: "group",
      accessGroup: "GID_SECRET_PRIVATE",
      name: "PrivateChild",
      // accessMode defaults to 'private'
    });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  test("org member: VisibleChild edge plain, RequestChild edge locked with name, PrivateChild edge absent", async () => {
    const result = await getNode(orgMember, orgId);
    assert.equal(result.statusCode, 200, `expected 200, got ${result.statusCode}; body: ${result.body}`);
    const parsed = JSON.parse(result.body) as { edges: EdgeWithFlag[] };

    const visibleEdge = parsed.edges.find((e) => e.peer_id === visibleChildId);
    assert.ok(visibleEdge, "visible child must appear in edges");
    assert.equal(visibleEdge!.peer_restricted, undefined, "visible peer must not carry peer_restricted");

    const requestEdge = parsed.edges.find((e) => e.peer_id === requestChildId);
    assert.ok(requestEdge, "request-mode restricted child must still appear as a locked edge");
    assert.equal(requestEdge!.peer_name, "RequestChild", "locked edge must carry the peer's name");
    assert.equal(requestEdge!.peer_restricted, true, "request-mode peer must carry peer_restricted: true");

    const privateEdge = parsed.edges.find((e) => e.peer_id === privateChildId);
    assert.equal(privateEdge, undefined, "private-mode restricted child must be dropped entirely (wave-1 regression)");
  });

  test("org member: GET RequestChild and PrivateChild directly both 404", async () => {
    const requestDirect = await getNode(orgMember, requestChildId);
    assert.equal(
      requestDirect.statusCode,
      404,
      `expected 404 for request-mode node direct GET, got ${requestDirect.statusCode}; body: ${requestDirect.body}`,
    );
    const privateDirect = await getNode(orgMember, privateChildId);
    assert.equal(
      privateDirect.statusCode,
      404,
      `expected 404 for private-mode node direct GET, got ${privateDirect.statusCode}; body: ${privateDirect.body}`,
    );
  });

  test("org member: /graph omits both RequestChild and PrivateChild", async () => {
    const graph = await getGraph(orgMember);
    const ids = graph.nodes.map((n) => n.id);
    assert.ok(ids.includes(orgId), "org member should see the org");
    assert.ok(ids.includes(visibleChildId), "org member should see VisibleChild");
    assert.ok(!ids.includes(requestChildId), "request-mode node must stay out of /graph");
    assert.ok(!ids.includes(privateChildId), "private-mode node must stay out of /graph");
  });

  test("admin: both restricted children appear in edges with no peer_restricted flag", async () => {
    const result = await getNode(admin, orgId);
    assert.equal(result.statusCode, 200, `expected 200, got ${result.statusCode}; body: ${result.body}`);
    const parsed = JSON.parse(result.body) as { edges: EdgeWithFlag[] };

    const requestEdge = parsed.edges.find((e) => e.peer_id === requestChildId);
    assert.ok(requestEdge, "admin should see RequestChild edge");
    assert.equal(requestEdge!.peer_restricted, undefined, "admin never gets peer_restricted (sees everything plainly)");

    const privateEdge = parsed.edges.find((e) => e.peer_id === privateChildId);
    assert.ok(privateEdge, "admin should see PrivateChild edge");
    assert.equal(privateEdge!.peer_restricted, undefined, "admin never gets peer_restricted");
  });
});

describe("Task 12: mode in GET/PUT /nodes/:id/access", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let parentId: string;
  let childId: string;

  const admin = makeAdmin();

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-access-mode-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    orgId = await insertOrg(db, "ModeOrg");
    parentId = await insertNode(db, orgId, { name: "ModeParent" });
    childId = await insertNode(db, parentId, { name: "ModeChild" }); // no own ACL -- inherits
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  test("PUT with mode 'request' persists; GET on the node and on an inheriting child both report mode 'request'", async () => {
    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${parentId}/access`, {
      entries: [{ kind: "group", principal: "GID_MODE", display_email: "mode@x.com" }],
      mode: "request",
    });
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${parentId}/access`), admin);
    assert.equal(captured.statusCode, 200, `expected 200, got ${captured.statusCode}; body: ${captured.body}`);
    const putParsed = JSON.parse(captured.body);
    assert.equal(putParsed.mode, "request");

    const { req: getReq, res: getRes, captured: getCaptured } = makeMockReqRes(
      "GET",
      `/nodes/${parentId}/access`,
    );
    await routeApiRequest(getReq, getRes, new URL(`http://localhost/nodes/${parentId}/access`), admin);
    assert.equal(getCaptured.statusCode, 200);
    const getParsed = JSON.parse(getCaptured.body);
    assert.equal(getParsed.mode, "request");

    const { req: childReq, res: childRes, captured: childCaptured } = makeMockReqRes(
      "GET",
      `/nodes/${childId}/access`,
    );
    await routeApiRequest(childReq, childRes, new URL(`http://localhost/nodes/${childId}/access`), admin);
    assert.equal(childCaptured.statusCode, 200);
    const childParsed = JSON.parse(childCaptured.body);
    assert.equal(childParsed.inherited, true);
    assert.equal(childParsed.mode, "request", "inheriting child must report the authoritative ancestor's mode");
  });

  test("PUT with non-empty entries and no mode defaults to 'private'", async () => {
    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${parentId}/access`, {
      entries: [{ kind: "group", principal: "GID_MODE2", display_email: "mode2@x.com" }],
    });
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${parentId}/access`), admin);
    assert.equal(captured.statusCode, 200, `expected 200, got ${captured.statusCode}; body: ${captured.body}`);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.mode, "private");

    const nodeRow = await db.execute({
      sql: "SELECT access_mode FROM nodes WHERE id = ?",
      args: [parentId],
    });
    assert.equal(nodeRow.rows[0].access_mode, "private");
  });

  test("PUT entries:[] resets access_mode column back to 'private' and mode reports null", async () => {
    // First set it to 'request' again so the reset is a real transition.
    await putAccess(admin, parentId, [{ kind: "group", principal: "GID_MODE3", display_email: "mode3@x.com" }]);
    await db.execute({ sql: "UPDATE nodes SET access_mode = 'request' WHERE id = ?", args: [parentId] });

    const cleared = await putAccess(admin, parentId, []);
    assert.equal(cleared.statusCode, 200, `expected 200, got ${cleared.statusCode}; body: ${cleared.body}`);
    const clearedParsed = JSON.parse(cleared.body);
    assert.equal(clearedParsed.restricted, false);
    assert.equal(clearedParsed.mode, null, "unrestricted node reports mode: null");

    const nodeRow = await db.execute({
      sql: "SELECT access_mode FROM nodes WHERE id = ?",
      args: [parentId],
    });
    assert.equal(
      nodeRow.rows[0].access_mode,
      "private",
      "clearing entries must reset access_mode so a stale 'request' never lingers",
    );
  });
});

describe("Task 12: MCP get_node/context edges carry peer_restricted for mode='request'", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let visibleId: string;
  let requestId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-mcp-peer-restricted-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    orgId = await insertOrg(db, "McpPeerRestrictedOrg");
    visibleId = await insertNode(db, orgId, { name: "McpVisible" });
    requestId = await insertNode(db, orgId, {
      visibility: "group",
      accessGroup: "GID_MCP_SECRET",
      name: "McpRequestChild",
      accessMode: "request",
    });

    // Direct edge between the two so they show up as neighbors of each other.
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'related_to', ?)",
      args: [ulid(), visibleId, requestId, SOLO],
    });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  function makeOutsider(): RequestIdentity {
    return {
      userId: SOLO,
      email: "mcp-outsider@x.com",
      name: "McpOutsider",
      globalScope: "manage",
      groups: [],
      groupIds: ["GID_NOT_SECRET"],
      via: "env",
    };
  }

  test("portuni_get_node on the visible neighbor shows the request-mode peer locked with name + peer_restricted", async () => {
    const outsider = makeOutsider();
    const { server, scope } = createMcpServer(outsider);
    scope.add(orgId);
    scope.add(visibleId);
    scope.add(requestId);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new McpClient({ name: "test-task12-get-node", version: "0.0.1" }, { capabilities: {} });
    await server.connect(serverT);
    await mcpClient.connect(clientT);

    const result = await mcpClient.callTool({
      name: "portuni_get_node",
      arguments: { node_id: visibleId },
    });
    await mcpClient.close();

    assert.notEqual(result.isError, true, "visible node should succeed");
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const payload = JSON.parse(text) as { edges?: EdgeWithFlag[] };
    const requestEdge = payload.edges?.find((e) => e.peer_id === requestId);
    assert.ok(requestEdge, "request-mode peer must still appear in get_node edges");
    assert.equal(requestEdge!.peer_name, "McpRequestChild");
    assert.equal(requestEdge!.peer_restricted, true);
  });

  test("portuni_get_context on the visible neighbor: root edges show the request-mode peer locked", async () => {
    const outsider = makeOutsider();
    const { server, scope } = createMcpServer(outsider);
    scope.add(orgId);
    scope.add(visibleId);
    scope.add(requestId);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new McpClient({ name: "test-task12-get-context", version: "0.0.1" }, { capabilities: {} });
    await server.connect(serverT);
    await mcpClient.connect(clientT);

    const result = await mcpClient.callTool({
      name: "portuni_get_context",
      arguments: { node_id: visibleId, depth: 1 },
    });
    await mcpClient.close();

    assert.notEqual(result.isError, true, "get_context on visible node should succeed");
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const payload = JSON.parse(text) as Array<{ id: string; edges?: EdgeWithFlag[]; depth: number }>;
    const root = payload.find((n) => n.depth === 0);
    assert.ok(root, "root node must be present");

    // The request-mode child must NOT appear as its own connected node...
    assert.ok(
      !payload.some((n) => n.id === requestId),
      "request-mode node must not appear as a connected node in the traversal itself",
    );
    // ...but must still surface as a locked edge off the visible root.
    const requestEdge = root!.edges?.find((e) => e.peer_id === requestId);
    assert.ok(requestEdge, "request-mode peer must appear as a locked edge on the visible root");
    assert.equal(requestEdge!.peer_restricted, true);
  });
});

// ---------------------------------------------------------------------------
// Task 14 point 8: GET /graph marks visible-but-ACL'd nodes restricted:true.
// ---------------------------------------------------------------------------

describe("Task 14 point 8: graph restricted flag", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let plainChildId: string;
  let sharedChildId: string;

  const admin = makeAdmin();

  function makeGroupMember(): RequestIdentity {
    return {
      userId: SOLO,
      email: "member@tempo.ooo",
      name: "Group Member",
      globalScope: "manage",
      groups: [],
      groupIds: ["GID_GRAPH_RESTRICTED"],
      via: "env",
    };
  }

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-graph-restricted-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    orgId = await insertOrg(db, "GraphRestrictedOrg");
    plainChildId = await insertNode(db, orgId, { name: "PlainChild" });
    sharedChildId = await insertNode(db, orgId, {
      name: "SharedChild",
      visibility: "group",
      accessGroup: "GID_GRAPH_RESTRICTED",
    });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  test("admin: org and PlainChild carry no restricted flag; SharedChild carries restricted:true", async () => {
    const graph = await getGraph(admin);
    const org = graph.nodes.find((n) => n.id === orgId);
    const plain = graph.nodes.find((n) => n.id === plainChildId);
    const shared = graph.nodes.find((n) => n.id === sharedChildId);
    assert.ok(org, "org must be present");
    assert.ok(plain, "PlainChild must be present");
    assert.ok(shared, "SharedChild must be present (admin sees everything)");
    assert.equal(org!.restricted, undefined, "unrestricted org must not carry restricted");
    assert.equal(plain!.restricted, undefined, "unrestricted child must not carry restricted");
    assert.equal(shared!.restricted, true, "ACL'd node must carry restricted:true even for admin");
  });

  test("group member: sees SharedChild with restricted:true", async () => {
    const member = makeGroupMember();
    const graph = await getGraph(member);
    const shared = graph.nodes.find((n) => n.id === sharedChildId);
    assert.ok(shared, "member of GID_GRAPH_RESTRICTED must see SharedChild");
    assert.equal(shared!.restricted, true);
  });
});

// ---------------------------------------------------------------------------
// Task 14 point 6: visibility='group' cannot be set through plain node
// update -- it is derived exclusively from PUT /nodes/:id/access.
// ---------------------------------------------------------------------------

describe("Task 14 point 6: manual visibility='group' rejected", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let nodeId: string;

  const admin = makeAdmin();

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-visibility-guard-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    orgId = await insertOrg(db, "VisibilityGuardOrg");
    nodeId = await insertNode(db, orgId, { name: "GuardedNode" });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  test("REST PATCH /nodes/:id with visibility='group' -> 400", async () => {
    const result = await patchNode(admin, nodeId, { visibility: "group" });
    assert.equal(result.statusCode, 400, `expected 400, got ${result.statusCode}; body: ${result.body}`);
    assert.match(JSON.parse(result.body).error, /managed via the sharing ACL/);

    const nodeRow = await db.execute({ sql: "SELECT visibility FROM nodes WHERE id = ?", args: [nodeId] });
    assert.equal(nodeRow.rows[0].visibility, "team", "rejected PATCH must not mutate visibility");
  });

  test("MCP portuni_update_node with visibility='group' -> tool error", async () => {
    const { server, scope } = createMcpServer(admin);
    scope.add(orgId);
    scope.add(nodeId);

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new McpClient({ name: "test-task14-visibility-guard", version: "0.0.1" }, { capabilities: {} });
    await server.connect(serverT);
    await mcpClient.connect(clientT);

    const result = await mcpClient.callTool({
      name: "portuni_update_node",
      arguments: { node_id: nodeId, visibility: "group" },
    });
    await mcpClient.close();

    assert.equal(result.isError, true, "expected an MCP tool error");
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    assert.match(text, /managed via the sharing ACL/);

    const nodeRow = await db.execute({ sql: "SELECT visibility FROM nodes WHERE id = ?", args: [nodeId] });
    assert.equal(nodeRow.rows[0].visibility, "team", "rejected MCP update must not mutate visibility");
  });
});
