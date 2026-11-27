// REST-level coverage for Phase B file content over the server.
// Verifies that, with no local mirror, GET/PUT /nodes/:id/file are served
// from the routed remote (central path), and that node-access enforcement
// hides restricted nodes the same way graph routes do.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests, getAdapter, setAdapterForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { createHash } from "node:crypto";
import type { FileAdapter, FileRef } from "../apps/server/domain/sync/types.js";
import { resolveNodeInfo } from "../apps/server/domain/sync/node-info.js";
import { buildRemotePath, type Section } from "../apps/server/domain/sync/remote-path.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import { useRemoteCapableEnv } from "./helpers/remote-capable-env.js";

useRemoteCapableEnv();

let shared: SharedDb;
let workspace: string;
let originalEnv: string | undefined;

function admin(): RequestIdentity {
  return {
    userId: "U1",
    email: "owner@x.com",
    name: "Owner",
    globalScope: "admin",
    groups: [],
    groupIds: [],
    via: "env",
  };
}

function outsider(): RequestIdentity {
  return {
    userId: "U1",
    email: "outsider@x.com",
    name: "Outsider",
    globalScope: "manage",
    groups: ["other@x.com"],
    groupIds: [],
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

// The web HTML preview's read of a stylesheet, font or image from the
// document's folder (apps/web/src/lib/html-preview-assets.ts).
describe("GET /nodes/:id/file?as=preview-asset", () => {
  const font = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0xff]);

  it("reads a binary asset from the remote when the node has no mirror", async () => {
    const info = await resolveNodeInfo(shared.db, shared.nodeId);
    const remotePath = buildRemotePath({ ...info, section: "wip", subpath: "fonts", filename: "a.woff2" });
    await (await getAdapter(shared.db, "test-fs")).put(remotePath, font);
    const r = await call("GET", `/nodes/${shared.nodeId}/file?path=wip/fonts/a.woff2&as=preview-asset`, admin());
    assert.equal(r.statusCode, 200, r.body);
    const payload = JSON.parse(r.body) as { content_base64: string; mime_type: string };
    assert.deepEqual(Buffer.from(payload.content_base64, "base64"), font);
    assert.equal(payload.mime_type, "font/woff2");
  });

  it("reads a binary asset from the local mirror", async () => {
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip", "fonts"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "fonts", "a.woff2"), font);
    const r = await call("GET", `/nodes/${shared.nodeId}/file?path=wip/fonts/a.woff2&as=preview-asset`, admin());
    assert.equal(r.statusCode, 200, r.body);
    const payload = JSON.parse(r.body) as { content_base64: string; mime_type: string };
    assert.deepEqual(Buffer.from(payload.content_base64, "base64"), font);
  });

  it("refuses a type outside the allowlist and a path out of the mirror", async () => {
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "app.js"), "alert(1)");
    for (const path of ["wip/app.js", "wip/.env", "wip/../../x.png"]) {
      const r = await call(
        "GET",
        `/nodes/${shared.nodeId}/file?path=${encodeURIComponent(path)}&as=preview-asset`,
        admin(),
      );
      assert.equal(r.statusCode, 400, `${path}: ${r.body}`);
    }
  });

  it("returns 404 for a node the identity cannot see (group visibility)", async () => {
    await shared.db.execute({
      sql: "UPDATE nodes SET visibility = 'group', meta = ? WHERE id = ?",
      args: [JSON.stringify({ access_group: "secret@x.com" }), shared.nodeId],
    });
    const r = await call("GET", `/nodes/${shared.nodeId}/file?path=wip/a.png&as=preview-asset`, outsider());
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

// The sync agent's byte push (#662): the file as an application/octet-stream
// body, streamed to the adapter as it arrives.
describe("PUT /nodes/:id/file streamed (application/octet-stream)", () => {
  const PIECE = 64 * 1024;

  // A request body of `size` deterministic bytes, produced on demand so the
  // test never holds it either.
  function streamedReq(pathWithQuery: string, size: number, contentLength: string | null = String(size)) {
    let sent = 0;
    const req = new Readable({
      read() {
        if (sent >= size) {
          this.push(null);
          return;
        }
        const n = Math.min(PIECE, size - sent);
        const b = Buffer.alloc(n, sent / PIECE % 251);
        sent += n;
        this.push(b);
      },
    }) as unknown as IncomingMessage;
    req.method = "PUT";
    req.url = pathWithQuery;
    req.headers = {
      "content-type": "application/octet-stream",
      ...(contentLength !== null ? { "content-length": contentLength } : {}),
    };
    return { req, readSoFar: () => sent };
  }

  function expectedSha(size: number): string {
    const h = createHash("sha256");
    for (let at = 0; at < size; at += PIECE) h.update(Buffer.alloc(Math.min(PIECE, size - at), at / PIECE % 251));
    return h.digest("hex");
  }

  // An adapter with putStream that hashes what it reads and remembers the
  // largest piece it was ever handed: the whole body never arrives as one.
  function streamingAdapter() {
    const seen = { total: 0, largestPiece: 0, putCalls: 0, sha: "" };
    const adapter: FileAdapter = {
      async put() {
        seen.putCalls += 1;
        throw new Error("put must not be used for a streamed body");
      },
      async putStream(path, source, opts): Promise<FileRef> {
        const h = createHash("sha256");
        for await (const piece of source) {
          seen.total += piece.byteLength;
          seen.largestPiece = Math.max(seen.largestPiece, piece.byteLength);
          h.update(piece);
        }
        seen.sha = h.digest("hex");
        return { path, hash: null, size: opts.size, modified_at: new Date(), is_native_format: false };
      },
      async get() {
        throw new Error("no get");
      },
      async stat() {
        return null;
      },
      async list() {
        return [];
      },
      async delete() {
        /* not used */
      },
      async rename() {
        /* not used */
      },
      async url() {
        return "";
      },
    };
    return { adapter, seen };
  }

  async function send(req: IncomingMessage) {
    const { res, captured } = makeMockReqRes("PUT", req.url!);
    await routeApiRequest(req, res, new URL(`http://localhost${req.url}`), admin());
    return captured;
  }

  it("accepts a body over 160 MB without collecting it into one buffer", async () => {
    const { adapter, seen } = streamingAdapter();
    setAdapterForTests("test-fs", adapter);
    const size = 170 * 1024 * 1024 + 123;
    const { req } = streamedReq(`/nodes/${shared.nodeId}/file?path=wip/big.csv&ifAbsent=1`, size);
    const r = await send(req);
    assert.equal(r.statusCode, 200, r.body);
    const payload = JSON.parse(r.body) as { version: string; canonical_hash: string };
    assert.equal(seen.total, size);
    assert.equal(seen.putCalls, 0);
    assert.ok(seen.largestPiece <= PIECE, `largest piece ${seen.largestPiece}`);
    const sha = expectedSha(size);
    assert.equal(seen.sha, sha);
    assert.equal(payload.version, sha);
    // No hash from the adapter: the canonical hash is the streamed sha256.
    assert.equal(payload.canonical_hash, sha);
  });

  it("writes through put on an adapter without putStream", async () => {
    const { req } = streamedReq(`/nodes/${shared.nodeId}/file?path=wip/s.bin`, 300_000);
    const r = await send(req);
    assert.equal(r.statusCode, 200, r.body);
    const adapter = await getAdapter(shared.db, "test-fs");
    const got = await adapter.get(await remotePathFor("wip/s.bin"));
    assert.equal(got.length, 300_000);
    assert.equal(JSON.parse(r.body).version, expectedSha(300_000));
  });

  it("answers FILE_TOO_LARGE with size and limit before reading the body", async () => {
    const prev = process.env.PORTUNI_MAX_FILE_BYTES;
    process.env.PORTUNI_MAX_FILE_BYTES = String(1024 * 1024);
    try {
      const { adapter, seen } = streamingAdapter();
      setAdapterForTests("test-fs", adapter);
      const size = 1024 * 1024 + 1;
      const { req, readSoFar } = streamedReq(`/nodes/${shared.nodeId}/file?path=wip/big.csv`, size);
      const r = await send(req);
      assert.equal(r.statusCode, 413, r.body);
      const body = JSON.parse(r.body) as { code: string; params: { size: number; limit: number } };
      assert.equal(body.code, "FILE_TOO_LARGE");
      assert.deepEqual(body.params, { size, limit: 1024 * 1024 });
      assert.equal(seen.total, 0);
      assert.ok(readSoFar() < size, "the body was not read to the end");
    } finally {
      if (prev === undefined) delete process.env.PORTUNI_MAX_FILE_BYTES;
      else process.env.PORTUNI_MAX_FILE_BYTES = prev;
    }
  });

  it("the JSON content_base64 variant is held to the same limit", async () => {
    const prev = process.env.PORTUNI_MAX_FILE_BYTES;
    process.env.PORTUNI_MAX_FILE_BYTES = "10";
    try {
      const r = await call("PUT", `/nodes/${shared.nodeId}/file?path=wip/b.bin`, admin(), {
        content_base64: Buffer.alloc(11).toString("base64"),
      });
      assert.equal(r.statusCode, 413, r.body);
      assert.equal(JSON.parse(r.body).code, "FILE_TOO_LARGE");
    } finally {
      if (prev === undefined) delete process.env.PORTUNI_MAX_FILE_BYTES;
      else process.env.PORTUNI_MAX_FILE_BYTES = prev;
    }
  });

  it("needs a Content-Length", async () => {
    const { req } = streamedReq(`/nodes/${shared.nodeId}/file?path=wip/x.bin`, 10, null);
    const r = await send(req);
    assert.equal(r.statusCode, 411, r.body);
  });

  it("carries the preconditions in the query: ifAbsent refuses an existing object", async () => {
    await seedRemote("wip/x.md", "v1");
    const { req } = streamedReq(`/nodes/${shared.nodeId}/file?path=wip/x.md&ifAbsent=1`, 10);
    const r = await send(req);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(JSON.parse(r.body).code, "EXISTS");
  });

  it("a body that ends before its Content-Length is not written", async () => {
    const { req } = streamedReq(`/nodes/${shared.nodeId}/file?path=wip/short.bin`, 1000, "2000");
    const r = await send(req);
    assert.equal(r.statusCode, 500, r.body);
    const adapter = await getAdapter(shared.db, "test-fs");
    assert.equal(await adapter.stat(await remotePathFor("wip/short.bin")), null);
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
