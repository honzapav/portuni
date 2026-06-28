// REST-level coverage for Phase B file content over the server.
// Verifies that, with no local mirror, GET/PUT /nodes/:id/file are served
// from the routed remote (central path), and that node-access enforcement
// hides restricted nodes the same way graph routes do.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests, getAdapter } from "../apps/server/domain/sync/adapter-cache.js";
import { resolveNodeInfo } from "../apps/server/domain/sync/node-info.js";
import { buildRemotePath, type Section } from "../apps/server/domain/sync/remote-path.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

let shared: SharedDb;
let workspace: string;
let originalEnv: string | undefined;

function admin(): RequestIdentity {
  return { userId: "U1", email: "owner@x.com", name: "Owner", globalScope: "admin", groups: [], via: "env" };
}

function outsider(): RequestIdentity {
  return {
    userId: "U1",
    email: "outsider@x.com",
    name: "Outsider",
    globalScope: "manage",
    groups: ["other@x.com"],
    via: "env",
  };
}

interface MockResponse {
  statusCode: number;
  body: string;
}

function makeMockReqRes(
  method: string,
  pathWithQuery: string,
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
  req.url = pathWithQuery;
  req.headers = bodyJson !== undefined ? { "content-type": "application/json" } : {};

  const res = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      captured.body += chunk.toString();
      cb();
    },
  }) as unknown as ServerResponse;
  (res as unknown as { writeHead: (code: number) => void }).writeHead = (code: number) => {
    captured.statusCode = code;
  };
  (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
    if (data) captured.body += data;
  };
  return { req, res, captured };
}

async function call(method: string, pathWithQuery: string, identity: RequestIdentity, bodyJson?: unknown) {
  const { req, res, captured } = makeMockReqRes(method, pathWithQuery, bodyJson);
  const url = new URL(`http://localhost${pathWithQuery}`);
  await routeApiRequest(req, res, url, identity);
  return captured;
}

async function seedRemote(relPath: string, content: string): Promise<void> {
  const info = await resolveNodeInfo(shared.db, shared.nodeId);
  const segs = relPath.split("/");
  const remotePath = buildRemotePath({
    ...info,
    section: segs[0] as Section,
    subpath: segs.length > 2 ? segs.slice(1, -1).join("/") : null,
    filename: segs[segs.length - 1],
  });
  const adapter = await getAdapter(shared.db, "test-fs");
  await adapter.put(remotePath, Buffer.from(content, "utf8"));
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-filecontent-rest-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  shared = await makeSharedDb();
  setDbForTesting(shared.db);
});

afterEach(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("GET /nodes/:id/file (central, no mirror)", () => {
  it("serves remote bytes when the node has no local mirror", async () => {
    await seedRemote("wip/x.md", "# remote hi\n");
    const r = await call("GET", `/nodes/${shared.nodeId}/file?path=wip/x.md`, admin());
    assert.equal(r.statusCode, 200, r.body);
    const payload = JSON.parse(r.body) as { content: string; version: string };
    assert.equal(payload.content, "# remote hi\n");
    assert.equal(payload.version.length, 64);
  });

  it("returns 404 for a node the identity cannot see (group visibility)", async () => {
    await seedRemote("wip/x.md", "secret\n");
    await shared.db.execute({
      sql: "UPDATE nodes SET visibility = 'group', meta = ? WHERE id = ?",
      args: [JSON.stringify({ access_group: "secret@x.com" }), shared.nodeId],
    });
    const r = await call("GET", `/nodes/${shared.nodeId}/file?path=wip/x.md`, outsider());
    assert.equal(r.statusCode, 404, r.body);
  });
});

describe("PUT /nodes/:id/file (central, no mirror)", () => {
  it("writes bytes to the remote when the node has no local mirror", async () => {
    await seedRemote("wip/x.md", "v1");
    const r = await call("PUT", `/nodes/${shared.nodeId}/file?path=wip/x.md`, admin(), { content: "v2" });
    assert.equal(r.statusCode, 200, r.body);
    const payload = JSON.parse(r.body) as { version: string };
    assert.equal(payload.version.length, 64);

    const info = await resolveNodeInfo(shared.db, shared.nodeId);
    const remotePath = buildRemotePath({ ...info, section: "wip", subpath: null, filename: "x.md" });
    const adapter = await getAdapter(shared.db, "test-fs");
    assert.equal((await adapter.get(remotePath)).toString("utf8"), "v2");
  });

  it("returns 404 for a node the identity cannot see (group visibility)", async () => {
    await seedRemote("wip/x.md", "v1");
    await shared.db.execute({
      sql: "UPDATE nodes SET visibility = 'group', meta = ? WHERE id = ?",
      args: [JSON.stringify({ access_group: "secret@x.com" }), shared.nodeId],
    });
    const r = await call("PUT", `/nodes/${shared.nodeId}/file?path=wip/x.md`, outsider(), { content: "hax" });
    assert.equal(r.statusCode, 404, r.body);
  });
});
