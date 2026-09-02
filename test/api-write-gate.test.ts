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
import { createSession, upsertSessionScopeRead, setSessionScopeWritable } from "../apps/server/domain/sessions.js";

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

// #213: env-mode's blanket write exemption now requires this header to
// prove the request came through a trusted proxy (Tauri host / Vite dev
// proxy), not a spawned agent terminal holding the same bearer token.
// Configured once for the whole file -- every `uiIdentity` call below that
// wants "the desktop UI, proxied" behavior passes WEBVIEW_PROXY_HEADERS;
// calls that omit it are exercising the no-proof/fail-closed path on
// purpose (see "REST write gate: env-mode webview-proxy marker (#213)").
const WEBVIEW_PROXY_SECRET = "test-webview-proxy-secret";
process.env.PORTUNI_WEBVIEW_PROXY_SECRET = WEBVIEW_PROXY_SECRET;
const WEBVIEW_PROXY_HEADERS = { "x-portuni-webview-proxy": WEBVIEW_PROXY_SECRET };

interface MockResponse {
  statusCode: number;
  body: string;
}

function makeMockReqRes(
  method: string,
  pathname: string,
  bodyJson?: unknown,
  extraHeaders?: Record<string, string>,
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
  req.headers = {
    ...(bodyJson !== undefined ? { "content-type": "application/json" } : {}),
    ...extraHeaders,
  };

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
  extraHeaders?: Record<string, string>,
): Promise<MockResponse> {
  const { req, res, captured } = makeMockReqRes(method, pathname, bodyJson, extraHeaders);
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

    it(`${c.label}: env (desktop UI) identity is unaffected when proxy-marked (#213)`, async () => {
      const r = await call(c.method, c.path(), uiIdentity, c.body(), WEBVIEW_PROXY_HEADERS);
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

  it("POST /edges: env identity is unaffected when proxy-marked (#213)", async () => {
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
    const r = await call(
      "POST",
      "/edges",
      uiIdentity,
      { source_id: nodeId, target_id: otherNode, relation: "related_to" },
      WEBVIEW_PROXY_HEADERS,
    );
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

  it("PUT /nodes/:id/access: device_token identity is refused (#210)", async () => {
    const r = await call("PUT", `/nodes/${nodeId}/access`, deviceTokenIdentity, { entries: [] });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("PUT /nodes/:id/access: env identity is unaffected when proxy-marked (#210, #213)", async () => {
    const r = await call("PUT", `/nodes/${nodeId}/access`, uiIdentity, { entries: [] }, WEBVIEW_PROXY_HEADERS);
    assert.ok(r.statusCode < 300, `expected success, got ${r.statusCode}: ${r.body}`);
  });

  it("POST /positions: out-of-write-scope entries are silently dropped for device_token, not 403'd (#210)", async () => {
    const r = await call("POST", "/positions", deviceTokenIdentity, {
      updates: [{ id: nodeId, x: 1, y: 2 }],
    });
    assert.ok(r.statusCode < 300, `expected success, got ${r.statusCode}: ${r.body}`);
    assert.deepEqual(JSON.parse(r.body), { updated: 0 });
  });

  it("POST /positions: env identity is unaffected when proxy-marked (#210, #213)", async () => {
    const r = await call(
      "POST",
      "/positions",
      uiIdentity,
      { updates: [{ id: nodeId, x: 3, y: 4 }] },
      WEBVIEW_PROXY_HEADERS,
    );
    assert.ok(r.statusCode < 300, `expected success, got ${r.statusCode}: ${r.body}`);
    assert.deepEqual(JSON.parse(r.body), { updated: 1 });
  });
});

// #210 point 2 / #213: env auth mode resolves every request to the same
// unscoped solo identity regardless of caller (auth/env-adapter.ts), which
// used to make the REST write gate a no-op for anything reaching the
// loopback port with the shared token -- not just the desktop webview's
// Tauri-proxied calls, but a spawned agent terminal too (it holds the same
// bearer token and can export X-Portuni-Spawn-Id itself). The
// X-Portuni-Spawn-Id header (already minted for MCP connections, see
// domain/write-scope.ts) scopes a request to that session's actual write
// set. The blanket "env" exemption itself now requires proof it came
// through a trusted proxy: a valid X-Portuni-Webview-Proxy header, checked
// against PORTUNI_WEBVIEW_PROXY_SECRET (set once for this file, see
// WEBVIEW_PROXY_SECRET above). A request with neither a resolvable spawn id
// nor a proven proxy marker is refused outright -- no fallback, no
// elicitation channel over REST.
describe("REST write gate: env-mode spawn-id scoping (#210 point 2)", () => {
  let db: DbClient;
  let workspace: string;
  let homeNodeId: string;
  let otherNodeId: string;
  let expandedNodeId: string;
  let sessionId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-api-write-gate-spawn-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = createDbClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    setDbForTesting(db);

    homeNodeId = ulid();
    otherNodeId = ulid();
    expandedNodeId = ulid();
    for (const [id, name] of [
      [homeNodeId, "Home"],
      [otherNodeId, "Other"],
      [expandedNodeId, "Expanded"],
    ] as const) {
      await db.execute({
        sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
              VALUES (?, 'project', ?, 'active', 'team', ?, ?)`,
        args: [id, name, id, SOLO],
      });
    }

    const session = await createSession(db, SOLO, { node_id: homeNodeId, session_type: "interactive_task" });
    sessionId = session.id;
    await upsertSessionScopeRead(db, sessionId, expandedNodeId, "elicited", "test");
    await setSessionScopeWritable(db, sessionId, expandedNodeId);
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  it("no X-Portuni-Spawn-Id header and no proxy marker: env identity is refused (#213)", async () => {
    const r = await call("PATCH", `/nodes/${otherNodeId}`, uiIdentity, { name: "Renamed" });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("X-Portuni-Webview-Proxy names the configured secret: env identity is exempt, no spawn id needed (#213)", async () => {
    const r = await call("PATCH", `/nodes/${otherNodeId}`, uiIdentity, { name: "Renamed" }, WEBVIEW_PROXY_HEADERS);
    assert.ok(r.statusCode < 300, `expected success, got ${r.statusCode}: ${r.body}`);
  });

  it("X-Portuni-Webview-Proxy with the wrong value: env identity is refused, not exempt (#213)", async () => {
    const r = await call("PATCH", `/nodes/${otherNodeId}`, uiIdentity, { name: "Renamed" }, {
      "x-portuni-webview-proxy": "not-the-secret",
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("X-Portuni-Spawn-Id names a running session: write to its home node is allowed", async () => {
    const r = await call("PATCH", `/nodes/${homeNodeId}`, uiIdentity, { name: "Renamed" }, {
      "x-portuni-spawn-id": sessionId,
    });
    assert.ok(r.statusCode < 300, `expected success, got ${r.statusCode}: ${r.body}`);
  });

  it("X-Portuni-Spawn-Id names a running session: write to a session-writable node is allowed", async () => {
    const r = await call("PATCH", `/nodes/${expandedNodeId}`, uiIdentity, { name: "Renamed" }, {
      "x-portuni-spawn-id": sessionId,
    });
    assert.ok(r.statusCode < 300, `expected success, got ${r.statusCode}: ${r.body}`);
  });

  it("X-Portuni-Spawn-Id names a running session: write outside its scope is refused", async () => {
    const r = await call("PATCH", `/nodes/${otherNodeId}`, uiIdentity, { name: "Renamed" }, {
      "x-portuni-spawn-id": sessionId,
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("X-Portuni-Spawn-Id names an unknown session: fails closed, does not fall back to the blanket exemption (#213)", async () => {
    const r = await call("PATCH", `/nodes/${otherNodeId}`, uiIdentity, { name: "Renamed" }, {
      "x-portuni-spawn-id": ulid(),
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("X-Portuni-Spawn-Id names an unknown session even with a valid proxy marker: still fails closed (#213)", async () => {
    const r = await call("PATCH", `/nodes/${otherNodeId}`, uiIdentity, { name: "Renamed" }, {
      "x-portuni-spawn-id": ulid(),
      ...WEBVIEW_PROXY_HEADERS,
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("session_jwt (central-mode UI) identity is unaffected: no marker needed, unlike env (#213)", async () => {
    const r = await call("PATCH", `/nodes/${otherNodeId}`, centralUiIdentity, { name: "Renamed" });
    assert.ok(r.statusCode < 300, `expected success, got ${r.statusCode}: ${r.body}`);
  });
});

// #212: the file-plane routes (PUT file, register(-batch), move, delete,
// sync, remote-sweep) stay ungated for CentralClient's own bare device
// token (teammate sync, asserted above at "PUT /nodes/:id/file (PUT
// content) stays ungated for device_token"), but must refuse a HEADLESS
// device token writing outside its bound session's home node -- headless
// has no elicitation channel, so it is refused outright, never merely
// deferred.
describe("REST write gate: headless device-token file-plane gating (#212)", () => {
  let db: DbClient;
  let workspace: string;
  let homeNodeId: string;
  let otherNodeId: string;
  let headlessSessionId: string;

  const headlessIdentity: RequestIdentity = { ...deviceTokenIdentity, headless: true };

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-api-write-gate-headless-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = createDbClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    setDbForTesting(db);

    homeNodeId = ulid();
    otherNodeId = ulid();
    for (const [id, name] of [
      [homeNodeId, "Home"],
      [otherNodeId, "Other"],
    ] as const) {
      await db.execute({
        sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
              VALUES (?, 'project', ?, 'active', 'team', ?, ?)`,
        args: [id, name, id, SOLO],
      });
    }

    const session = await createSession(db, SOLO, { node_id: homeNodeId, session_type: "headless" });
    headlessSessionId = session.id;
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  it("PUT /nodes/:id/file: headless device token with no bound-session header is refused", async () => {
    const r = await call("PUT", `/nodes/${homeNodeId}/file?path=wip/x.md`, headlessIdentity, { content: "hi" });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("PUT /nodes/:id/file: headless device token naming its own home-node session is not refused", async () => {
    const r = await call(
      "PUT",
      `/nodes/${homeNodeId}/file?path=wip/x.md`,
      headlessIdentity,
      { content: "hi" },
      { "x-portuni-spawn-id": headlessSessionId },
    );
    assert.notEqual(r.statusCode, 403, r.body);
  });

  it("PUT /nodes/:id/file: headless session writing outside its home node is refused", async () => {
    const r = await call(
      "PUT",
      `/nodes/${otherNodeId}/file?path=wip/x.md`,
      headlessIdentity,
      { content: "hi" },
      { "x-portuni-spawn-id": headlessSessionId },
    );
    assert.equal(r.statusCode, 403, r.body);
  });

  it("PUT /nodes/:id/file: a plain (non-headless) device token is unaffected", async () => {
    const r = await call("PUT", `/nodes/${otherNodeId}/file?path=wip/x.md`, deviceTokenIdentity, { content: "hi" });
    assert.notEqual(r.statusCode, 403, r.body);
  });

  it("POST /nodes/:id/files/register: headless device token with no bound session is refused", async () => {
    const r = await call("POST", `/nodes/${homeNodeId}/files/register`, headlessIdentity, { relPath: "wip/x.md" });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("POST /nodes/:id/files/register-batch: headless device token with no bound session is refused", async () => {
    const r = await call("POST", `/nodes/${homeNodeId}/files/register-batch`, headlessIdentity, {
      relPaths: ["wip/x.md"],
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("POST /nodes/:id/files/:fileId/move: headless device token with no bound session is refused (source)", async () => {
    const r = await call("POST", `/nodes/${homeNodeId}/files/${ulid()}/move`, headlessIdentity, {
      new_filename: "renamed.md",
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  it("POST /nodes/:id/files/:fileId/move: bound-session move into a foreign new_node_id is refused", async () => {
    const r = await call(
      "POST",
      `/nodes/${homeNodeId}/files/${ulid()}/move`,
      headlessIdentity,
      { new_node_id: otherNodeId },
      { "x-portuni-spawn-id": headlessSessionId },
    );
    assert.equal(r.statusCode, 403, r.body);
  });

  it("DELETE /nodes/:id/files/:fileId: headless device token with no bound session is refused", async () => {
    const r = await call("DELETE", `/nodes/${homeNodeId}/files/${ulid()}`, headlessIdentity);
    assert.equal(r.statusCode, 403, r.body);
  });

  it("DELETE /nodes/:id/files/:fileId: a plain (non-headless) device token is unaffected", async () => {
    const r = await call("DELETE", `/nodes/${otherNodeId}/files/${ulid()}`, deviceTokenIdentity);
    assert.notEqual(r.statusCode, 403, r.body);
  });

  it("POST /nodes/:id/sync: headless device token with no bound session is refused", async () => {
    const r = await call("POST", `/nodes/${homeNodeId}/sync`, headlessIdentity);
    assert.equal(r.statusCode, 403, r.body);
  });

  it("POST /nodes/:id/sync/remote-sweep: headless device token with no bound session is refused", async () => {
    const r = await call("POST", `/nodes/${homeNodeId}/sync/remote-sweep`, headlessIdentity);
    assert.equal(r.statusCode, 403, r.body);
  });

  it("POST /nodes/:id/sync: a plain (non-headless) device token is unaffected", async () => {
    const r = await call("POST", `/nodes/${otherNodeId}/sync`, deviceTokenIdentity);
    assert.notEqual(r.statusCode, 403, r.body);
  });
});
