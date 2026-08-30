// REST tests for the access-request flow (POST /nodes/:id/access/request,
// GET /access/requests, GET /nodes/:id/access/requests, POST
// /access/requests/:id/approve|deny). Same methodology as
// api-access.test.ts: routeApiRequest with a lightweight mock req/res and
// RequestIdentity objects constructed directly, so the handler-level
// visibility guards (404/409) and the middleware min-scope gate (403) are
// exercised in one pass.

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
import { classifyNodeVisibility } from "../apps/server/auth/node-access.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const SOLO = "01SOLO0000000000000000000";
const MANAGER_GROUP = "GID_MANAGERS";
const OTHER_GROUP = "GID_OTHERS";

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
  opts: {
    visibility?: string;
    accessGroup?: string;
    accessMode?: "private" | "request";
    name?: string;
  } = {},
) {
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, status, visibility, access_mode, sync_key, created_by)
          VALUES (?, 'project', ?, 'active', ?, ?, ?, ?)`,
    args: [
      id,
      opts.name ?? `node-${id}`,
      opts.visibility ?? "team",
      opts.accessMode ?? "private",
      `proj-${id}`,
      SOLO,
    ],
  });
  await db.execute({
    sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
    args: [ulid(), id, parentId, SOLO],
  });
  if (opts.accessGroup) {
    await db.execute({
      sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
            VALUES (?, 'group', ?, ?, ?)`,
      args: [id, opts.accessGroup, `${opts.accessGroup.toLowerCase()}@x.com`, SOLO],
    });
  }
  return id;
}

async function insertUser(db: DbClient, email: string, name: string) {
  const id = ulid();
  await db.execute({
    sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
    args: [id, email, name],
  });
  return id;
}

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

function makeRequester(userId: string, scope: RequestIdentity["globalScope"] = "read"): RequestIdentity {
  return {
    userId,
    email: "alice@x.com",
    name: "Alice",
    globalScope: scope,
    groups: [],
    groupIds: [],
    via: "env",
  };
}

// Manager in MANAGER_GROUP: sees nodes restricted to that group, not the
// ones restricted to OTHER_GROUP.
function makeManager(): RequestIdentity {
  return {
    userId: SOLO,
    email: "manager@x.com",
    name: "Manager",
    globalScope: "manage",
    groups: [],
    groupIds: [MANAGER_GROUP],
    via: "env",
  };
}

function makeAdmin(): RequestIdentity {
  return { ...makeManager(), email: "admin@x.com", name: "Admin", globalScope: "admin", groupIds: [] };
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

async function call(
  identity: RequestIdentity,
  method: string,
  path: string,
  body?: unknown,
): Promise<MockResponse> {
  const { req, res, captured } = makeMockReqRes(method, path, body);
  await routeApiRequest(req, res, new URL(`http://localhost${path}`), identity);
  return captured;
}

async function requestAccess(identity: RequestIdentity, nodeId: string, message?: string) {
  return call(identity, "POST", `/nodes/${nodeId}/access/request`, message === undefined ? {} : { message });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe("access requests", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let aliceId: string;
  let bobId: string;
  // Restricted to MANAGER_GROUP, mode=request: alice can ask, manager sees it.
  let requestNodeId: string;
  // Restricted to OTHER_GROUP, mode=request: alice can ask, manager cannot see it.
  let foreignNodeId: string;
  // Restricted to MANAGER_GROUP, mode=private: alice gets nothing.
  let privateNodeId: string;
  // Unrestricted: nothing to request.
  let openNodeId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-api-access-requests-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    orgId = await insertOrg(db);
    aliceId = await insertUser(db, "alice@x.com", "Alice");
    bobId = await insertUser(db, "bob@x.com", "Bob");
    requestNodeId = await insertNode(db, orgId, {
      name: "RequestNode",
      visibility: "group",
      accessGroup: MANAGER_GROUP,
      accessMode: "request",
    });
    foreignNodeId = await insertNode(db, orgId, {
      name: "ForeignNode",
      visibility: "group",
      accessGroup: OTHER_GROUP,
      accessMode: "request",
    });
    privateNodeId = await insertNode(db, orgId, {
      name: "PrivateNode",
      visibility: "group",
      accessGroup: MANAGER_GROUP,
      accessMode: "private",
    });
    openNodeId = await insertNode(db, orgId, { name: "OpenNode" });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  // --- POST /nodes/:id/access/request -------------------------------------

  test("hidden (private-mode) node -> 404, missing node -> 404", async () => {
    const alice = makeRequester(aliceId);
    const hidden = await requestAccess(alice, privateNodeId);
    assert.equal(hidden.statusCode, 404, hidden.body);
    const missing = await requestAccess(alice, ulid());
    assert.equal(missing.statusCode, 404, missing.body);
    const rows = await db.execute("SELECT count(*) AS c FROM access_requests");
    assert.equal(Number(rows.rows[0].c), 0, "no request row may be created");
  });

  test("visible node -> 409 already_visible", async () => {
    const r = await requestAccess(makeRequester(aliceId), openNodeId);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(JSON.parse(r.body).error, "already_visible");
  });

  test("request-mode node -> 201 pending with audit row; duplicate -> 409 already_pending", async () => {
    const alice = makeRequester(aliceId);
    const first = await requestAccess(alice, requestNodeId, "Potřebuji to k projektu");
    assert.equal(first.statusCode, 201, first.body);
    const parsed = JSON.parse(first.body) as { id: string; status: string };
    assert.equal(parsed.status, "pending");
    assert.equal(parsed.id.length, 26);

    const row = await db.execute({
      sql: "SELECT node_id, user_id, message, status FROM access_requests WHERE id = ?",
      args: [parsed.id],
    });
    assert.equal(row.rows[0].node_id, requestNodeId);
    assert.equal(row.rows[0].user_id, aliceId);
    assert.equal(row.rows[0].message, "Potřebuji to k projektu");
    assert.equal(row.rows[0].status, "pending");

    const audit = await db.execute({
      sql: "SELECT user_id FROM audit_log WHERE action = 'node.access.request' AND target_id = ?",
      args: [requestNodeId],
    });
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].user_id, aliceId);

    const dup = await requestAccess(alice, requestNodeId);
    assert.equal(dup.statusCode, 409, dup.body);
    const dupBody = JSON.parse(dup.body) as { error: string; id: string };
    assert.equal(dupBody.error, "already_pending");
    assert.equal(dupBody.id, parsed.id);
  });

  test("empty body and no message are accepted", async () => {
    const r = await call(makeRequester(bobId), "POST", `/nodes/${requestNodeId}/access/request`);
    assert.equal(r.statusCode, 201, r.body);
    const row = await db.execute({
      sql: "SELECT message FROM access_requests WHERE node_id = ? AND user_id = ?",
      args: [requestNodeId, bobId],
    });
    assert.equal(row.rows[0].message, null);
  });

  // --- Listing --------------------------------------------------------------

  test("GET /access/requests is filtered to nodes the manager can see", async () => {
    const alice = makeRequester(aliceId);
    const foreign = await requestAccess(alice, foreignNodeId);
    assert.equal(foreign.statusCode, 201, foreign.body);

    const asManager = await call(makeManager(), "GET", "/access/requests?status=pending");
    assert.equal(asManager.statusCode, 200, asManager.body);
    const list = JSON.parse(asManager.body).requests as Array<{ node_id: string; user_email: string; node_name: string }>;
    assert.ok(list.every((r) => r.node_id !== foreignNodeId), "foreign node's request must not leak");
    assert.ok(!asManager.body.includes(foreignNodeId), "foreign node id must not appear at all");
    assert.equal(list.filter((r) => r.node_id === requestNodeId).length, 2, "alice + bob on RequestNode");
    const aliceRow = list.find((r) => r.user_email === "alice@x.com");
    assert.equal(aliceRow?.node_name, "RequestNode");

    const asAdmin = await call(makeAdmin(), "GET", "/access/requests");
    const adminList = JSON.parse(asAdmin.body).requests as Array<{ node_id: string }>;
    assert.ok(adminList.some((r) => r.node_id === foreignNodeId), "admin sees every request");

    const count = await call(makeManager(), "GET", "/access/requests/count");
    assert.equal(count.statusCode, 200, count.body);
    assert.equal(JSON.parse(count.body).pending, 2);

    const bad = await call(makeManager(), "GET", "/access/requests?status=junk");
    assert.equal(bad.statusCode, 400);
  });

  test("GET /nodes/:id/access/requests lists pending for a visible node, 404 for a hidden one", async () => {
    const ok = await call(makeManager(), "GET", `/nodes/${requestNodeId}/access/requests`);
    assert.equal(ok.statusCode, 200, ok.body);
    const list = JSON.parse(ok.body).requests as Array<{ user_id: string; status: string }>;
    assert.equal(list.length, 2);
    assert.ok(list.every((r) => r.status === "pending"));

    const hidden = await call(makeManager(), "GET", `/nodes/${foreignNodeId}/access/requests`);
    assert.equal(hidden.statusCode, 404, hidden.body);
  });

  // --- Approve / deny --------------------------------------------------------

  test("approve grants a user entry on the node; requester becomes visible", async () => {
    const before = await classifyNodeVisibility(db, makeRequester(aliceId), [requestNodeId]);
    assert.equal(before.get(requestNodeId), "request");

    const pending = await db.execute({
      sql: "SELECT id FROM access_requests WHERE node_id = ? AND user_id = ? AND status = 'pending'",
      args: [requestNodeId, aliceId],
    });
    const requestId = String(pending.rows[0].id);

    const r = await call(makeManager(), "POST", `/access/requests/${requestId}/approve`);
    assert.equal(r.statusCode, 200, r.body);
    const body = JSON.parse(r.body) as { status: string; resolved_by: string | null; resolved_at: string | null };
    assert.equal(body.status, "approved");
    assert.equal(body.resolved_by, SOLO);
    assert.ok(body.resolved_at);

    const grant = await db.execute({
      sql: "SELECT added_by FROM node_access WHERE node_id = ? AND kind = 'user' AND principal = ?",
      args: [requestNodeId, aliceId],
    });
    assert.equal(grant.rows.length, 1, "user grant must be written on the node");
    assert.equal(grant.rows[0].added_by, SOLO);

    // Original group grant survives -- approval adds, never replaces.
    const groupGrant = await db.execute({
      sql: "SELECT 1 FROM node_access WHERE node_id = ? AND kind = 'group' AND principal = ?",
      args: [requestNodeId, MANAGER_GROUP],
    });
    assert.equal(groupGrant.rows.length, 1);

    const after = await classifyNodeVisibility(db, makeRequester(aliceId), [requestNodeId]);
    assert.equal(after.get(requestNodeId), "visible");

    const audit = await db.execute({
      sql: "SELECT detail FROM audit_log WHERE action = 'node.access.request.approve' AND target_id = ?",
      args: [requestNodeId],
    });
    assert.equal(audit.rows.length, 1);
    assert.equal(JSON.parse(String(audit.rows[0].detail)).request_id, requestId);

    // Resolved: approving again is a 409, and a fresh request is now 409 already_visible.
    const again = await call(makeManager(), "POST", `/access/requests/${requestId}/approve`);
    assert.equal(again.statusCode, 409);
    assert.equal(JSON.parse(again.body).error, "already_resolved");
    const fresh = await requestAccess(makeRequester(aliceId), requestNodeId);
    assert.equal(fresh.statusCode, 409);
    assert.equal(JSON.parse(fresh.body).error, "already_visible");
  });

  test("deny marks the request without granting anything", async () => {
    const pending = await db.execute({
      sql: "SELECT id FROM access_requests WHERE node_id = ? AND user_id = ? AND status = 'pending'",
      args: [requestNodeId, bobId],
    });
    const requestId = String(pending.rows[0].id);

    const r = await call(makeManager(), "POST", `/access/requests/${requestId}/deny`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(JSON.parse(r.body).status, "denied");

    const grant = await db.execute({
      sql: "SELECT 1 FROM node_access WHERE node_id = ? AND kind = 'user' AND principal = ?",
      args: [requestNodeId, bobId],
    });
    assert.equal(grant.rows.length, 0);
    const cls = await classifyNodeVisibility(db, makeRequester(bobId), [requestNodeId]);
    assert.equal(cls.get(requestNodeId), "request");

    const audit = await db.execute({
      sql: "SELECT 1 FROM audit_log WHERE action = 'node.access.request.deny' AND target_id = ?",
      args: [requestNodeId],
    });
    assert.equal(audit.rows.length, 1);

    // Denied is history, not a block: bob may ask again.
    const retry = await requestAccess(makeRequester(bobId), requestNodeId);
    assert.equal(retry.statusCode, 201, retry.body);
  });

  test("approve on a node with inherited restriction writes the grant on the source node", async () => {
    const parentId = await insertNode(db, orgId, {
      name: "RestrictedParent",
      visibility: "group",
      accessGroup: MANAGER_GROUP,
      accessMode: "request",
    });
    const childId = await insertNode(db, parentId, { name: "InheritingChild" });

    const alice = makeRequester(aliceId);
    const cls = await classifyNodeVisibility(db, alice, [childId, parentId]);
    assert.equal(cls.get(childId), "request", "child inherits request mode");

    const created = await requestAccess(alice, childId);
    assert.equal(created.statusCode, 201, created.body);
    const requestId = (JSON.parse(created.body) as { id: string }).id;

    const r = await call(makeManager(), "POST", `/access/requests/${requestId}/approve`);
    assert.equal(r.statusCode, 200, r.body);

    const onChild = await db.execute({
      sql: "SELECT 1 FROM node_access WHERE node_id = ?",
      args: [childId],
    });
    assert.equal(onChild.rows.length, 0, "child must not get its own override");
    const onParent = await db.execute({
      sql: "SELECT 1 FROM node_access WHERE node_id = ? AND kind = 'user' AND principal = ?",
      args: [parentId, aliceId],
    });
    assert.equal(onParent.rows.length, 1, "grant must land on the source node");

    const after = await classifyNodeVisibility(db, alice, [childId, parentId]);
    assert.equal(after.get(childId), "visible");
    assert.equal(after.get(parentId), "visible");

    const audit = await db.execute({
      sql: "SELECT detail FROM audit_log WHERE action = 'node.access.request.approve' AND target_id = ?",
      args: [childId],
    });
    assert.equal(JSON.parse(String(audit.rows[0].detail)).granted_on, parentId);
  });

  test("manager cannot resolve or read a request on a node hidden from them", async () => {
    const pending = await db.execute({
      sql: "SELECT id FROM access_requests WHERE node_id = ? AND status = 'pending'",
      args: [foreignNodeId],
    });
    const requestId = String(pending.rows[0].id);
    const approve = await call(makeManager(), "POST", `/access/requests/${requestId}/approve`);
    assert.equal(approve.statusCode, 404, approve.body);
    const deny = await call(makeManager(), "POST", `/access/requests/${requestId}/deny`);
    assert.equal(deny.statusCode, 404, deny.body);
    const still = await db.execute({
      sql: "SELECT status FROM access_requests WHERE id = ?",
      args: [requestId],
    });
    assert.equal(still.rows[0].status, "pending");

    const missing = await call(makeAdmin(), "POST", `/access/requests/${ulid()}/approve`);
    assert.equal(missing.statusCode, 404);
  });

  // --- Min-scope gates ---------------------------------------------------------

  test("read scope may request but not list/resolve; write scope is gated the same", async () => {
    const reader = makeRequester(aliceId, "read");
    for (const [method, path] of [
      ["GET", "/access/requests"],
      ["GET", "/access/requests/count"],
      ["GET", `/nodes/${requestNodeId}/access/requests`],
      ["POST", `/access/requests/${ulid()}/approve`],
      ["POST", `/access/requests/${ulid()}/deny`],
    ] as const) {
      const r = await call(reader, method, path);
      assert.equal(r.statusCode, 403, `${method} ${path}: ${r.body}`);
      assert.equal(JSON.parse(r.body).required_scope, "manage");
    }
    const writer = makeRequester(aliceId, "write");
    const r = await call(writer, "GET", "/access/requests");
    assert.equal(r.statusCode, 403);
  });
});
