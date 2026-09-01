// REST write-gate coverage for issue #203 finding 1: the "graph plane"
// mutation endpoints (nodes/edges/events/responsibilities/data-sources/
// tools) must route through the same domain-layer write scope check MCP
// tools already apply, so an agent identity (device_token, oauth_grant)
// cannot bypass a session's write scope by hitting REST directly, while
// the desktop UI (env, session_jwt) stays exempt as designed.
//
// Same methodology as api-access.test.ts: routeApiRequest with a minimal
// mock req/res and RequestIdentity objects constructed directly, with
// globalScope: "admin" so the pre-existing min-scope gate and node
// visibility never interfere with what's under test here.

import { describe, it, before, after } from "node:test";
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

function makeIdentity(via: RequestIdentity["via"]): RequestIdentity {
  return {
    userId: SOLO,
    email: "caller@x.com",
    name: "Caller",
    globalScope: "admin",
    groups: [],
    groupIds: [],
    via,
  };
}

const uiIdentity = makeIdentity("env");
const centralUiIdentity = makeIdentity("session_jwt");
const deviceTokenIdentity = makeIdentity("device_token");
const oauthGrantIdentity = makeIdentity("oauth_grant");

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
  method: string,
  pathname: string,
  identity: RequestIdentity,
  bodyJson?: unknown,
): Promise<MockResponse> {
  const { req, res, captured } = makeMockReqRes(method, pathname, bodyJson);
  await routeApiRequest(req, res, new URL(`http://localhost${pathname}`), identity);
  return captured;
}

describe("REST write gate: graph-plane mutations", () => {
  let db: DbClient;
  let workspace: string;
  let orgId: string;
  let nodeId: string;
  let respId: string;
  let dsId: string;
  let toolId: string;
  let eventId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-api-write-gate-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = createDbClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    setDbForTesting(db);

    orgId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'organization', 'Acme', 'acme', ?)",
      args: [orgId, SOLO],
    });
    nodeId = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
            VALUES (?, 'project', 'Proj', 'active', 'team', 'proj', ?)`,
      args: [nodeId, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), nodeId, orgId, SOLO],
    });

    respId = ulid();
    await db.execute({
      sql: "INSERT INTO responsibilities (id, node_id, title) VALUES (?, ?, 'Responsibility')",
      args: [respId, nodeId],
    });
    dsId = ulid();
    await db.execute({
      sql: "INSERT INTO data_sources (id, node_id, name) VALUES (?, ?, 'DS')",
      args: [dsId, nodeId],
    });
    toolId = ulid();
    await db.execute({
      sql: "INSERT INTO tools (id, node_id, name) VALUES (?, ?, 'Tool')",
      args: [toolId, nodeId],
    });
    eventId = ulid();
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, status, created_by, created_at, logged_at)
            VALUES (?, ?, 'note', 'hello', 'active', ?, ?, ?)`,
      args: [eventId, nodeId, SOLO, now, now],
    });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  // path/body are thunks, not values: the case table below is built once
  // when describe() registers its subtests (before the `before()` hook that
  // assigns nodeId/respId/... has run), so any fixture id has to be read
  // lazily, at test-run time, or it captures `undefined`.
  const cases: Array<{
    label: string;
    method: string;
    path: () => string;
    body: () => unknown;
  }> = [
    { label: "PATCH /nodes/:id", method: "PATCH", path: () => `/nodes/${nodeId}`, body: () => ({ name: "Renamed" }) },
    { label: "POST /events", method: "POST", path: () => "/events", body: () => ({ node_id: nodeId, type: "note", content: "hi" }) },
    { label: "PATCH /events/:id", method: "PATCH", path: () => `/events/${eventId}`, body: () => ({ content: "edited" }) },
    { label: "POST /responsibilities", method: "POST", path: () => "/responsibilities", body: () => ({ node_id: nodeId, title: "Resp2" }) },
    { label: "PATCH /responsibilities/:id", method: "PATCH", path: () => `/responsibilities/${respId}`, body: () => ({ description: "y" }) },
    { label: "POST /data-sources", method: "POST", path: () => "/data-sources", body: () => ({ node_id: nodeId, name: "DS2" }) },
    { label: "PATCH /data-sources/:id", method: "PATCH", path: () => `/data-sources/${dsId}`, body: () => ({ name: "DS3" }) },
    { label: "POST /tools", method: "POST", path: () => "/tools", body: () => ({ node_id: nodeId, name: "Tool2" }) },
    { label: "PATCH /tools/:id", method: "PATCH", path: () => `/tools/${toolId}`, body: () => ({ name: "Tool3" }) },
  ];

  for (const c of cases) {
    it(`${c.label}: device_token (agent) identity is refused`, async () => {
      const r = await call(c.method, c.path(), deviceTokenIdentity, c.body());
      assert.equal(r.statusCode, 403, r.body);
      const parsed = JSON.parse(r.body);
      assert.match(parsed.error, /write_refused|write_expansion_required/);
    });

    it(`${c.label}: oauth_grant (chat connector) identity is refused`, async () => {
      const r = await call(c.method, c.path(), oauthGrantIdentity, c.body());
      assert.equal(r.statusCode, 403, r.body);
    });

    it(`${c.label}: env (desktop UI) identity is unaffected`, async () => {
      const r = await call(c.method, c.path(), uiIdentity, c.body());
      assert.ok(r.statusCode < 300, `expected success, got ${r.statusCode}: ${r.body}`);
    });

    it(`${c.label}: session_jwt (central-mode UI) identity is unaffected`, async () => {
      const r = await call(c.method, c.path(), centralUiIdentity, c.body());
      assert.ok(r.statusCode < 300, `expected success, got ${r.statusCode}: ${r.body}`);
    });
  }

  it("POST /edges: device_token identity is refused", async () => {
    const otherNode = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
            VALUES (?, 'project', 'Proj2', 'active', 'team', 'proj2', ?)`,
      args: [otherNode, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), otherNode, orgId, SOLO],
    });
    const r = await call("POST", "/edges", deviceTokenIdentity, {
      source_id: nodeId,
      target_id: otherNode,
      relation: "related_to",
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("POST /edges: env identity is unaffected", async () => {
    const otherNode = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
            VALUES (?, 'project', 'Proj3', 'active', 'team', 'proj3', ?)`,
      args: [otherNode, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), otherNode, orgId, SOLO],
    });
    const r = await call("POST", "/edges", uiIdentity, {
      source_id: nodeId,
      target_id: otherNode,
      relation: "related_to",
    });
    assert.ok(r.statusCode < 300, `expected success, got ${r.statusCode}: ${r.body}`);
  });

  it("actors REST stays ungated (global registry, not node-scoped -- matches the MCP tool exemption)", async () => {
    const r = await call("POST", "/actors", deviceTokenIdentity, {
      type: "person",
      name: "Someone",
    });
    assert.ok(r.statusCode < 300, `expected success, got ${r.statusCode}: ${r.body}`);
  });

  it("POST /nodes/:id/move: device_token identity is refused", async () => {
    const otherOrg = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'organization', 'Other', 'other', ?)",
      args: [otherOrg, SOLO],
    });
    const r = await call("POST", `/nodes/${nodeId}/move`, deviceTokenIdentity, {
      new_org_id: otherOrg,
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("POST /nodes/:id/mirror: device_token identity is refused", async () => {
    const r = await call("POST", `/nodes/${nodeId}/mirror`, deviceTokenIdentity);
    assert.equal(r.statusCode, 403, r.body);
  });

  it("POST /nodes/:id/files (create): device_token identity is refused before reaching the mirrorless remote-create path", async () => {
    const r = await call("POST", `/nodes/${nodeId}/files`, deviceTokenIdentity, {
      filename: "note.md",
      section: "wip",
      content: "hi",
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("POST /nodes/:id/files/:fileId/rename: device_token identity is refused", async () => {
    const r = await call("POST", `/nodes/${nodeId}/files/${ulid()}/rename`, deviceTokenIdentity, {
      new_filename: "renamed.md",
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("POST /nodes/:id/file (PUT content) stays ungated for device_token: it is the central-mode sync agent's own channel", async () => {
    // No mirror registered in this test DB, so this hits writeFileContentRemote
    // and fails for its own domain reasons (no routed remote) -- the point is
    // it is NOT refused by the write gate (403), unlike the endpoints above.
    const r = await call("PUT", `/nodes/${nodeId}/file?path=wip/x.md`, deviceTokenIdentity, {
      content: "hi",
    });
    assert.notEqual(r.statusCode, 403, r.body);
  });
});
