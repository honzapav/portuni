// REST tests for GET/PUT /nodes/:id/access (Task 4). Same methodology as
// auth-node-access-integration.test.ts: routeApiRequest with a lightweight
// mock req/res and RequestIdentity objects constructed directly, so both
// the handler-level visibility guard (404) and the middleware min-scope
// gate (403) are exercised in one pass.

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
import type { IdentityContext } from "../apps/server/auth/request-identity.js";
import type { IdentityAdapter } from "../apps/server/auth/adapter.js";
import {
  setIdentityContextForTesting,
  resetIdentityContextForTesting,
} from "../apps/server/http/middleware.js";
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

function makeManager(): RequestIdentity {
  return {
    userId: SOLO,
    email: "manager@x.com",
    name: "Manager",
    globalScope: "manage",
    groups: ["eng@x.com"],
    groupIds: [],
    via: "env",
  };
}

function makeOutsiderRead(): RequestIdentity {
  return {
    userId: SOLO,
    email: "outsider@x.com",
    name: "Outsider",
    globalScope: "read",
    groups: ["other@x.com"],
    groupIds: [],
    via: "env",
  };
}

function makeManagerWrongGroup(): RequestIdentity {
  return {
    userId: SOLO,
    email: "manager2@x.com",
    name: "Manager2",
    globalScope: "manage",
    groups: ["other@x.com"],
    groupIds: [],
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

// Setup helper for tests that need a node already under some ACL state
// before exercising the behavior under test -- issues the PUT as the
// manager identity and returns the raw captured response so callers can
// still assert on it when the PUT itself is part of what's being tested.
async function putAccessFixture(
  nodeId: string,
  entries: unknown[],
): Promise<MockResponse> {
  const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${nodeId}/access`, { entries });
  await routeApiRequest(req, res, new URL(`http://localhost/nodes/${nodeId}/access`), makeManager());
  return captured;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe("GET/PUT /nodes/:id/access", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let nodeDId: string;
  let aliceId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-api-access-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    orgId = await insertOrg(db, "TestOrg");
    nodeDId = await insertNode(db, orgId, {
      name: "NodeD",
      visibility: "group",
      accessGroup: "restricted-group@x.com",
    });

    aliceId = ulid();
    await db.execute({
      sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
      args: [aliceId, "alice@x.com", "Alice"],
    });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  // Tests 1/3/4/5 used to share a single `nodeAId` fixture mutated in
  // sequence -- test 3 (child inheritance) only passed because test 1 had
  // already restricted the shared parent, and test 5's "unaffected"
  // assertion only held because test 4 had already cleared it back to
  // 'team'. That made the suite pass only in file-declaration order and
  // break under reordering or per-test runs. Each test below now creates
  // its own dedicated node (and sets up whatever ACL precondition it needs
  // itself), so none of them depend on another test having run first.

  // 1. PUT with group+user entries (manage identity) -> 200; visibility='group'; audit row.
  test("1. PUT sets group+user ACL -> 200, visibility=group, audit row logged", async () => {
    const manager = makeManager();
    const node1Id = await insertNode(db, orgId, { name: "Node1" });
    const body = {
      entries: [
        { kind: "group", principal: "eng@x.com", display_email: "eng@x.com" },
        { kind: "user", principal: aliceId },
      ],
    };
    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${node1Id}/access`, body);
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${node1Id}/access`), manager);

    assert.equal(captured.statusCode, 200, `expected 200, got ${captured.statusCode}; body: ${captured.body}`);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.restricted, true);
    assert.equal(parsed.inherited, false);
    assert.equal(parsed.source_node_id, node1Id);
    assert.equal(parsed.entries.length, 2);

    const nodeRow = await db.execute({
      sql: "SELECT visibility FROM nodes WHERE id = ?",
      args: [node1Id],
    });
    assert.equal(nodeRow.rows[0].visibility, "group");

    const auditRows = await db.execute({
      sql: "SELECT action, target_id FROM audit_log WHERE target_id = ? AND action = 'node.access.set'",
      args: [node1Id],
    });
    assert.equal(auditRows.rows.length, 1, "expected exactly one node.access.set audit row");
  });

  // Unified control: authoritative `visibility` in the PUT body owns the
  // whole access state (visibility + entries + access_mode) atomically.
  test("U1. PUT visibility='private' clears entries and sets private", async () => {
    const manager = makeManager();
    const nodeId = await insertNode(db, orgId, { name: "UNode1" });
    // First make it a group node (granted to the manager's group so the
    // manager can still access it to change the sharing).
    await putAccessFixture(nodeId, [
      { kind: "group", principal: "eng@x.com", display_email: "eng@x.com" },
    ]);
    // Now switch to private via the unified control; entries in the body are
    // ignored (forced empty) for a team/private target.
    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${nodeId}/access`, {
      entries: [{ kind: "user", principal: aliceId }],
      visibility: "private",
    });
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${nodeId}/access`), manager);
    assert.equal(captured.statusCode, 200, captured.body);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.restricted, false, "private node has no ACL rows");
    assert.equal(parsed.visibility, "private");
    const nodeRow = await db.execute({ sql: "SELECT visibility, access_mode FROM nodes WHERE id = ?", args: [nodeId] });
    assert.equal(nodeRow.rows[0].visibility, "private");
    assert.equal(nodeRow.rows[0].access_mode, "private");
    const cnt = await db.execute({ sql: "SELECT COUNT(*) AS c FROM node_access WHERE node_id = ?", args: [nodeId] });
    assert.equal(cnt.rows[0].c, 0, "entries must be cleared despite being passed in the body");
  });

  test("U2. PUT visibility='team' clears entries and sets team", async () => {
    const manager = makeManager();
    const nodeId = await insertNode(db, orgId, { name: "UNode2" });
    await putAccessFixture(nodeId, [
      { kind: "group", principal: "eng@x.com", display_email: "eng@x.com" },
    ]);
    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${nodeId}/access`, {
      entries: [],
      visibility: "team",
    });
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${nodeId}/access`), manager);
    assert.equal(captured.statusCode, 200, captured.body);
    assert.equal(JSON.parse(captured.body).visibility, "team");
    const nodeRow = await db.execute({ sql: "SELECT visibility FROM nodes WHERE id = ?", args: [nodeId] });
    assert.equal(nodeRow.rows[0].visibility, "team");
  });

  test("U3. PUT visibility='group' with entries sets group + mode", async () => {
    const manager = makeManager();
    const nodeId = await insertNode(db, orgId, { name: "UNode3" });
    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${nodeId}/access`, {
      entries: [{ kind: "user", principal: aliceId }],
      visibility: "group",
      mode: "request",
    });
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${nodeId}/access`), manager);
    assert.equal(captured.statusCode, 200, captured.body);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.visibility, "group");
    assert.equal(parsed.mode, "request");
    const nodeRow = await db.execute({ sql: "SELECT visibility, access_mode FROM nodes WHERE id = ?", args: [nodeId] });
    assert.equal(nodeRow.rows[0].visibility, "group");
    assert.equal(nodeRow.rows[0].access_mode, "request");
  });

  test("U4. PUT visibility='group' with empty entries -> 400, no mutation", async () => {
    const manager = makeManager();
    const nodeId = await insertNode(db, orgId, { name: "UNode4" });
    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${nodeId}/access`, {
      entries: [],
      visibility: "group",
    });
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${nodeId}/access`), manager);
    assert.equal(captured.statusCode, 400, captured.body);
    assert.match(JSON.parse(captured.body).error, /group visibility requires at least one/);
    const nodeRow = await db.execute({ sql: "SELECT visibility FROM nodes WHERE id = ?", args: [nodeId] });
    assert.equal(nodeRow.rows[0].visibility, "team", "rejected PUT must not mutate visibility");
  });

  // 2. GET returns own list, inherited false, display_name from users JOIN.
  test("2. GET returns own ACL with display data joined from users", async () => {
    const manager = makeManager();
    const node2Id = await insertNode(db, orgId, { name: "Node2" });
    await putAccessFixture(node2Id, [
      { kind: "group", principal: "eng@x.com", display_email: "eng@x.com" },
      { kind: "user", principal: aliceId },
    ]);

    const { req, res, captured } = makeMockReqRes("GET", `/nodes/${node2Id}/access`);
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${node2Id}/access`), manager);

    assert.equal(captured.statusCode, 200, `expected 200, got ${captured.statusCode}; body: ${captured.body}`);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.restricted, true);
    assert.equal(parsed.inherited, false);
    assert.equal(parsed.source_node_id, node2Id);
    assert.equal(parsed.source_node_name, "Node2");

    const userEntry = parsed.entries.find((e: { kind: string }) => e.kind === "user");
    const groupEntry = parsed.entries.find((e: { kind: string }) => e.kind === "group");
    assert.ok(userEntry, "expected a user entry");
    assert.ok(groupEntry, "expected a group entry");
    assert.equal(userEntry.principal, aliceId);
    assert.equal(userEntry.display_name, "Alice");
    assert.equal(userEntry.display_email, "alice@x.com");
    assert.equal(groupEntry.principal, "eng@x.com");
    assert.equal(groupEntry.display_email, "eng@x.com");
    assert.equal(groupEntry.display_name, null);
  });

  // 3. GET on a child without its own ACL returns the inherited chain.
  test("3. GET on child without own ACL returns inherited entries from its own parent", async () => {
    const manager = makeManager();
    const parent3Id = await insertNode(db, orgId, { name: "Parent3" });
    const child3Id = await insertNode(db, parent3Id, { name: "Child3" }); // no own ACL
    await putAccessFixture(parent3Id, [
      { kind: "group", principal: "eng@x.com", display_email: "eng@x.com" },
      { kind: "user", principal: aliceId },
    ]);

    const { req, res, captured } = makeMockReqRes("GET", `/nodes/${child3Id}/access`);
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${child3Id}/access`), manager);

    assert.equal(captured.statusCode, 200, `expected 200, got ${captured.statusCode}; body: ${captured.body}`);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.restricted, true);
    assert.equal(parsed.inherited, true);
    assert.equal(parsed.source_node_id, parent3Id);
    assert.equal(parsed.source_node_name, "Parent3");
    assert.equal(parsed.entries.length, 2);
  });

  // 4. PUT entries:[] -> visibility back to 'team', GET restricted:false.
  test("4. PUT with empty entries clears restriction back to team", async () => {
    const manager = makeManager();
    const node4Id = await insertNode(db, orgId, { name: "Node4" });
    await putAccessFixture(node4Id, [{ kind: "group", principal: "eng@x.com", display_email: "eng@x.com" }]);

    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${node4Id}/access`, { entries: [] });
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${node4Id}/access`), manager);

    assert.equal(captured.statusCode, 200, `expected 200, got ${captured.statusCode}; body: ${captured.body}`);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.restricted, false);

    const nodeRow = await db.execute({
      sql: "SELECT visibility FROM nodes WHERE id = ?",
      args: [node4Id],
    });
    assert.equal(nodeRow.rows[0].visibility, "team");

    const { req: getReq, res: getRes, captured: getCaptured } = makeMockReqRes(
      "GET",
      `/nodes/${node4Id}/access`,
    );
    await routeApiRequest(getReq, getRes, new URL(`http://localhost/nodes/${node4Id}/access`), manager);
    assert.equal(getCaptured.statusCode, 200);
    const getParsed = JSON.parse(getCaptured.body);
    assert.equal(getParsed.restricted, false);
    assert.equal(getParsed.inherited, false);
    assert.equal(getParsed.source_node_id, null);
    assert.equal(getParsed.source_node_name, null);
    assert.equal(getParsed.entries.length, 0);
  });

  // 5. PUT with a user principal that doesn't exist in `users` -> 400.
  test("5. PUT with unknown user id -> 400, no mutation", async () => {
    const manager = makeManager();
    const node5Id = await insertNode(db, orgId, { name: "Node5" });
    const bogusId = "01BOGUSNOTAREALUSERID0000A";
    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${node5Id}/access`, {
      entries: [{ kind: "user", principal: bogusId }],
    });
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${node5Id}/access`), manager);

    assert.equal(captured.statusCode, 400, `expected 400, got ${captured.statusCode}; body: ${captured.body}`);
    assert.match(captured.body, new RegExp(bogusId), "error should list the missing user id");

    const nodeRow = await db.execute({
      sql: "SELECT visibility FROM nodes WHERE id = ?",
      args: [node5Id],
    });
    assert.equal(nodeRow.rows[0].visibility, "team", "visibility must be unaffected by the rejected PUT");

    const accessRows = await db.execute({
      sql: "SELECT COUNT(*) AS cnt FROM node_access WHERE node_id = ?",
      args: [node5Id],
    });
    assert.equal(accessRows.rows[0].cnt, 0, "node_access must be unaffected by the rejected PUT");
  });

  // Task 14 point 1: duplicate (kind, principal) pairs in one PUT payload
  // used to hit the node_access PK inside the batch INSERT and 500; now
  // rejected up front with a 400 listing the offending pair(s).
  test("8. PUT with duplicate (kind, principal) entries -> 400, no mutation", async () => {
    const manager = makeManager();
    const node8Id = await insertNode(db, orgId, { name: "Node8" });
    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${node8Id}/access`, {
      entries: [
        { kind: "group", principal: "eng@x.com", display_email: "eng@x.com" },
        { kind: "group", principal: "eng@x.com", display_email: "eng@x.com" },
      ],
    });
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${node8Id}/access`), manager);

    assert.equal(captured.statusCode, 400, `expected 400, got ${captured.statusCode}; body: ${captured.body}`);
    assert.match(captured.body, /group:eng@x\.com/, "error should list the duplicate pair");

    const nodeRow = await db.execute({
      sql: "SELECT visibility FROM nodes WHERE id = ?",
      args: [node8Id],
    });
    assert.equal(nodeRow.rows[0].visibility, "team", "rejected PUT must not mutate visibility");

    const accessRows = await db.execute({
      sql: "SELECT COUNT(*) AS cnt FROM node_access WHERE node_id = ?",
      args: [node8Id],
    });
    assert.equal(accessRows.rows[0].cnt, 0, "rejected PUT must not write any node_access rows");
  });

  // Task 14 point 1: a duplicate user entry (same principal twice) must
  // also be rejected, not just duplicate groups.
  test("9. PUT with duplicate user entries -> 400", async () => {
    const manager = makeManager();
    const node9Id = await insertNode(db, orgId, { name: "Node9" });
    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${node9Id}/access`, {
      entries: [
        { kind: "user", principal: aliceId },
        { kind: "user", principal: aliceId },
      ],
    });
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${node9Id}/access`), manager);

    assert.equal(captured.statusCode, 400, `expected 400, got ${captured.statusCode}; body: ${captured.body}`);
    assert.match(captured.body, new RegExp(`user:${aliceId}`));
  });

  // Task 14 point 2: pin the private-preservation behavior. Restricting
  // (non-empty entries) always moves visibility to 'group', regardless of
  // the prior value -- including 'private'. Clearing only reverts to
  // 'team' when the node was 'group' at the time of the PUT; it never
  // clobbers a 'private' node that was never put under ACL restriction.
  test("10. PUT non-empty entries on a 'private' node moves it to 'group'", async () => {
    const privateNodeId = await insertNode(db, orgId, { name: "PrivateNode10", visibility: "private" });

    const restricted = await putAccessFixture(privateNodeId, [
      { kind: "group", principal: "eng@x.com", display_email: "eng@x.com" },
    ]);
    assert.equal(restricted.statusCode, 200);
    const afterRestrict = await db.execute({
      sql: "SELECT visibility FROM nodes WHERE id = ?",
      args: [privateNodeId],
    });
    assert.equal(afterRestrict.rows[0].visibility, "group", "non-empty entries always set 'group', even from 'private'");

    // Clearing afterwards reverts to 'team' (the node is currently 'group',
    // not 'private', so the wasGroup branch fires) -- NOT back to 'private'.
    const cleared = await putAccessFixture(privateNodeId, []);
    assert.equal(cleared.statusCode, 200);
    const afterClear = await db.execute({
      sql: "SELECT visibility FROM nodes WHERE id = ?",
      args: [privateNodeId],
    });
    assert.equal(
      afterClear.rows[0].visibility,
      "team",
      "clearing a node that was 'group' reverts to 'team', never back to its pre-restriction 'private'",
    );
  });

  test("11. PUT entries:[] on a 'private' node that was never restricted leaves visibility unchanged", async () => {
    const privateNodeId = await insertNode(db, orgId, { name: "PrivateNode11", visibility: "private" });

    const cleared = await putAccessFixture(privateNodeId, []);
    assert.equal(cleared.statusCode, 200, `expected 200, got ${cleared.statusCode}; body: ${cleared.body}`);
    const parsed = JSON.parse(cleared.body);
    assert.equal(parsed.restricted, false);

    const nodeRow = await db.execute({
      sql: "SELECT visibility FROM nodes WHERE id = ?",
      args: [privateNodeId],
    });
    assert.equal(
      nodeRow.rows[0].visibility,
      "private",
      "PUT [] on a node that was never restricted (not 'group') must not clobber 'private'",
    );
  });

  // 6. Non-member (read identity, outside the group) -> GET 404, PUT 403.
  test("6. non-member GET restricted node -> 404; PUT -> 403 (min-scope)", async () => {
    const outsider = makeOutsiderRead();

    const { req: getReq, res: getRes, captured: getCaptured } = makeMockReqRes(
      "GET",
      `/nodes/${nodeDId}/access`,
    );
    await routeApiRequest(getReq, getRes, new URL(`http://localhost/nodes/${nodeDId}/access`), outsider);
    assert.equal(getCaptured.statusCode, 404, `expected 404, got ${getCaptured.statusCode}; body: ${getCaptured.body}`);

    const { req: putReq, res: putRes, captured: putCaptured } = makeMockReqRes(
      "PUT",
      `/nodes/${nodeDId}/access`,
      { entries: [] },
    );
    await routeApiRequest(putReq, putRes, new URL(`http://localhost/nodes/${nodeDId}/access`), outsider);
    assert.equal(putCaptured.statusCode, 403, `expected 403, got ${putCaptured.statusCode}; body: ${putCaptured.body}`);
  });

  // 7. PUT on a node the caller (manage scope, but wrong group) cannot see -> 404.
  test("7. PUT on a node the caller cannot see -> 404 (handler-level guard)", async () => {
    const manager2 = makeManagerWrongGroup();
    const { req, res, captured } = makeMockReqRes("PUT", `/nodes/${nodeDId}/access`, { entries: [] });
    await routeApiRequest(req, res, new URL(`http://localhost/nodes/${nodeDId}/access`), manager2);
    assert.equal(captured.statusCode, 404, `expected 404, got ${captured.statusCode}; body: ${captured.body}`);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/groups (Task 5): domain groups picker for the sharing UI.
// ---------------------------------------------------------------------------

describe("GET /auth/groups", () => {
  let db: DbClient;
  let workspace: string;

  const fakeGroups = [
    { id: "1", email: "eng-team@x.com", name: "Engineering Team" },
    { id: "2", email: "sales@x.com", name: "Sales" },
    { id: "3", email: "eng-leads@x.com", name: "Engineering Leads" },
  ];

  function makeCtxWithAdapter(adapter: IdentityAdapter): IdentityContext {
    return {
      db,
      mode: "google",
      jwtSecret: "test-secret-at-least-32-characters-long",
      adapter,
      soloUserId: SOLO,
    };
  }

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-api-auth-groups-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    db = await makeTestDb();
    setDbForTesting(db);
  });

  after(async () => {
    resetIdentityContextForTesting();
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  test("1. fake adapter with listDomainGroups: query filters to matching groups", async () => {
    const fakeAdapter: IdentityAdapter = {
      verify: async () => ({ email: "manager@x.com", name: "Manager", sub: "env:manager@x.com" }),
      resolveAccess: async () => ({ globalScope: "manage", groups: [], groupIds: [] }),
      listDomainGroups: async (query) => {
        const q = query.toLowerCase().trim();
        return fakeGroups.filter(
          (g) => g.email.includes(q) || g.name.toLowerCase().includes(q),
        );
      },
    };
    setIdentityContextForTesting(makeCtxWithAdapter(fakeAdapter));

    const manager: RequestIdentity = {
      userId: SOLO,
      email: "manager@x.com",
      name: "Manager",
      globalScope: "manage",
      groups: [],
      groupIds: [],
      via: "env",
    };
    const { req, res, captured } = makeMockReqRes("GET", "/auth/groups?query=eng");
    await routeApiRequest(req, res, new URL("http://localhost/auth/groups?query=eng"), manager);

    assert.equal(captured.statusCode, 200, `expected 200, got ${captured.statusCode}; body: ${captured.body}`);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.groups.length, 2);
    assert.deepEqual(
      parsed.groups.map((g: { id: string }) => g.id).sort(),
      ["1", "3"],
    );
  });

  test("2. env adapter without listDomainGroups -> 501 google_mode_only", async () => {
    const envLikeAdapter: IdentityAdapter = {
      verify: async () => ({ email: "manager@x.com", name: "Manager", sub: "env:manager@x.com" }),
      resolveAccess: async () => ({ globalScope: "manage", groups: [], groupIds: [] }),
    };
    setIdentityContextForTesting(makeCtxWithAdapter(envLikeAdapter));

    const manager: RequestIdentity = {
      userId: SOLO,
      email: "manager@x.com",
      name: "Manager",
      globalScope: "manage",
      groups: [],
      groupIds: [],
      via: "env",
    };
    const { req, res, captured } = makeMockReqRes("GET", "/auth/groups");
    await routeApiRequest(req, res, new URL("http://localhost/auth/groups"), manager);

    assert.equal(captured.statusCode, 501, `expected 501, got ${captured.statusCode}; body: ${captured.body}`);
    assert.deepEqual(JSON.parse(captured.body), { error: "google_mode_only" });
  });

  test("3. read-scope identity -> 403 (min-scope gate, never reaches handler)", async () => {
    const fakeAdapter: IdentityAdapter = {
      verify: async () => ({ email: "reader@x.com", name: "Reader", sub: "env:reader@x.com" }),
      resolveAccess: async () => ({ globalScope: "read", groups: [], groupIds: [] }),
      listDomainGroups: async () => fakeGroups,
    };
    setIdentityContextForTesting(makeCtxWithAdapter(fakeAdapter));

    const reader: RequestIdentity = {
      userId: SOLO,
      email: "reader@x.com",
      name: "Reader",
      globalScope: "read",
      groups: [],
      groupIds: [],
      via: "env",
    };
    const { req, res, captured } = makeMockReqRes("GET", "/auth/groups");
    await routeApiRequest(req, res, new URL("http://localhost/auth/groups"), reader);

    assert.equal(captured.statusCode, 403, `expected 403, got ${captured.statusCode}; body: ${captured.body}`);
  });
});
