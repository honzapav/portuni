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
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
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
  opts: { visibility?: string; accessGroup?: string; name?: string } = {},
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
  return JSON.parse(captured.body) as { nodes: Array<{ id: string }>; edges: Array<{ source_id: string; target_id: string }> };
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
