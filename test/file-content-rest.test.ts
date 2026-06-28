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
import { ulid } from "ulid";
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

async function remotePathFor(relPath: string): Promise<string> {
  const info = await resolveNodeInfo(shared.db, shared.nodeId);
  const segs = relPath.split("/");
  return buildRemotePath({
    ...info,
    section: segs[0] as Section,
    subpath: segs.length > 2 ? segs.slice(1, -1).join("/") : null,
    filename: segs[segs.length - 1],
  });
}

async function insertFileRow(relPath: string): Promise<string> {
  const id = ulid();
  await shared.db.execute({
    sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, current_remote_hash, is_native_format, created_by)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    args: [id, shared.nodeId, relPath.split("/").pop()!, "test-fs", await remotePathFor(relPath), "h", "U1"],
  });
  return id;
}

describe("B3 lifecycle over the server (central, no mirror)", () => {
  it("POST /nodes/:id/files creates a file adapter-direct", async () => {
    const r = await call("POST", `/nodes/${shared.nodeId}/files`, admin(), {
      filename: "made.md",
      content: "# made\n",
    });
    assert.equal(r.statusCode, 201, r.body);
    const payload = JSON.parse(r.body) as { id: string; relative_path: string };
    assert.equal(payload.relative_path, "wip/made.md");
    const adapter = await getAdapter(shared.db, "test-fs");
    assert.equal((await adapter.get(await remotePathFor("wip/made.md"))).toString("utf8"), "# made\n");
    const row = await shared.db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [payload.id] });
    assert.equal(row.rows.length, 1);
  });

  it("POST .../files/:fileId/rename renames adapter-direct", async () => {
    await seedRemote("wip/old.md", "body");
    const fileId = await insertFileRow("wip/old.md");
    const r = await call("POST", `/nodes/${shared.nodeId}/files/${fileId}/rename`, admin(), {
      new_filename: "renamed.md",
    });
    assert.equal(r.statusCode, 200, r.body);
    const adapter = await getAdapter(shared.db, "test-fs");
    assert.equal((await adapter.get(await remotePathFor("wip/renamed.md"))).toString("utf8"), "body");
  });

  it("DELETE .../files/:fileId?confirmed=true deletes adapter-direct", async () => {
    await seedRemote("wip/gone.md", "body");
    const fileId = await insertFileRow("wip/gone.md");
    const r = await call("DELETE", `/nodes/${shared.nodeId}/files/${fileId}?confirmed=true`, admin());
    assert.equal(r.statusCode, 200, r.body);
    const adapter = await getAdapter(shared.db, "test-fs");
    assert.equal(await adapter.stat(await remotePathFor("wip/gone.md")), null);
    const row = await shared.db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [fileId] });
    assert.equal(row.rows.length, 0);
  });

  it("DELETE without confirmed returns a confirm-first preview, nothing removed", async () => {
    await seedRemote("wip/keep.md", "body");
    const fileId = await insertFileRow("wip/keep.md");
    const r = await call("DELETE", `/nodes/${shared.nodeId}/files/${fileId}`, admin());
    assert.equal(r.statusCode, 200, r.body);
    const payload = JSON.parse(r.body) as { requires_confirmation?: boolean };
    assert.equal(payload.requires_confirmation, true);
    const adapter = await getAdapter(shared.db, "test-fs");
    assert.ok(await adapter.stat(await remotePathFor("wip/keep.md")));
  });

  it("POST /nodes/:id/files returns 404 for a node the identity cannot see", async () => {
    await shared.db.execute({
      sql: "UPDATE nodes SET visibility = 'group', meta = ? WHERE id = ?",
      args: [JSON.stringify({ access_group: "secret@x.com" }), shared.nodeId],
    });
    const r = await call("POST", `/nodes/${shared.nodeId}/files`, outsider(), {
      filename: "x.md",
      content: "x",
    });
    assert.equal(r.statusCode, 404, r.body);
  });
});
