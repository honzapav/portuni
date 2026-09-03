// A `.showtime` bundle is a zip; Portuni previews it through the rendered
// `preview.html` the bundle carries (Showtime writes it at every save). These
// tests build small zips by hand -- Node has no zip writer -- covering both
// compression methods a bundle may use (stored, deflate).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { FileContentError } from "../apps/server/domain/sync/file-content.js";
import {
  extractZipEntry,
  isShowtimePath,
  readShowtimePreview,
  SHOWTIME_PREVIEW_ENTRY,
} from "../apps/server/domain/sync/showtime-preview.js";

type Entry = { name: string; data: Buffer; deflate?: boolean };

// Minimal zip writer: local headers + central directory + EOCD. CRCs are
// written as zero -- the reader never checks them, and neither does anything
// else in these tests.
export function buildZip(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const method = e.deflate ? 8 : 0;
    const payload = e.deflate ? deflateRawSync(e.data) : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + payload.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const HTML = "<!doctype html><html><body><section>slide</section></body></html>";

describe("isShowtimePath", () => {
  it("matches the extension case-insensitively and nothing else", () => {
    assert.equal(isShowtimePath("outputs/pitch.showtime"), true);
    assert.equal(isShowtimePath("outputs/PITCH.SHOWTIME"), true);
    assert.equal(isShowtimePath("outputs/pitch.showtime.bak"), false);
    assert.equal(isShowtimePath("outputs/showtime"), false);
    assert.equal(isShowtimePath("outputs/pitch.html"), false);
  });
});

describe("extractZipEntry", () => {
  it("returns a stored entry by name", () => {
    const zip = buildZip([
      { name: "deck.md", data: Buffer.from("# deck") },
      { name: SHOWTIME_PREVIEW_ENTRY, data: Buffer.from(HTML) },
    ]);
    assert.equal(extractZipEntry(zip, SHOWTIME_PREVIEW_ENTRY)?.toString("utf8"), HTML);
    assert.equal(extractZipEntry(zip, "deck.md")?.toString("utf8"), "# deck");
  });

  it("inflates a deflated entry", () => {
    const big = HTML.repeat(200);
    const zip = buildZip([{ name: SHOWTIME_PREVIEW_ENTRY, data: Buffer.from(big), deflate: true }]);
    assert.equal(extractZipEntry(zip, SHOWTIME_PREVIEW_ENTRY)?.toString("utf8"), big);
  });

  it("returns null for a name the archive does not hold", () => {
    const zip = buildZip([{ name: "deck.md", data: Buffer.from("# deck") }]);
    assert.equal(extractZipEntry(zip, SHOWTIME_PREVIEW_ENTRY), null);
  });

  it("matches only the top-level entry, not one nested under a directory", () => {
    const zip = buildZip([{ name: `history/1/${SHOWTIME_PREVIEW_ENTRY}`, data: Buffer.from(HTML) }]);
    assert.equal(extractZipEntry(zip, SHOWTIME_PREVIEW_ENTRY), null);
  });

  it("throws on bytes that are not a zip", () => {
    assert.throws(() => extractZipEntry(Buffer.from("not a zip at all, sorry"), SHOWTIME_PREVIEW_ENTRY));
  });

  it("throws on an unsupported compression method", () => {
    const zip = buildZip([{ name: SHOWTIME_PREVIEW_ENTRY, data: Buffer.from(HTML) }]);
    // Patch the method field in both headers to 12 (bzip2).
    zip.writeUInt16LE(12, 8);
    const cdOffset = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt16LE(12, cdOffset + 10);
    assert.throws(() => extractZipEntry(zip, SHOWTIME_PREVIEW_ENTRY), /compression/);
  });
});

describe("readShowtimePreview (local mirror)", () => {
  let workspace: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-showtime-"));
    originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    resetAdapterCacheForTests();
  });

  afterEach(async () => {
    resetLocalDbForTests();
    resetAdapterCacheForTests();
    if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
    else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
    await rm(workspace, { recursive: true, force: true });
  });

  async function mirrorWith(nodeId: string, name: string, bytes: Buffer): Promise<string> {
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "outputs"), { recursive: true });
    await writeFile(join(mirrorRoot, "outputs", name), bytes);
    return join(mirrorRoot, "outputs", name);
  }

  it("returns the bundled preview as HTML content with the bundle's version and path", async () => {
    const { db, nodeId } = await makeSharedDb();
    const zip = buildZip([
      { name: "deck.md", data: Buffer.from("# deck") },
      { name: SHOWTIME_PREVIEW_ENTRY, data: Buffer.from(HTML), deflate: true },
    ]);
    const abs = await mirrorWith(nodeId, "pitch.showtime", zip);

    const r = await readShowtimePreview(db, { userId: "U1", nodeId, relPath: "outputs/pitch.showtime" });
    assert.equal(r.content, HTML);
    assert.equal(r.filename, "pitch.showtime");
    assert.equal(r.mime_type, "text/html");
    assert.equal(r.local_path, abs);
    assert.equal(r.version.length, 64);
  });

  it("throws NO_PREVIEW when the bundle carries no preview.html", async () => {
    const { db, nodeId } = await makeSharedDb();
    await mirrorWith(nodeId, "old.showtime", buildZip([{ name: "deck.md", data: Buffer.from("# deck") }]));
    await assert.rejects(
      () => readShowtimePreview(db, { userId: "U1", nodeId, relPath: "outputs/old.showtime" }),
      (e: unknown) => e instanceof FileContentError && e.code === "NO_PREVIEW",
    );
  });

  it("throws NO_PREVIEW when the file is not a zip", async () => {
    const { db, nodeId } = await makeSharedDb();
    await mirrorWith(nodeId, "broken.showtime", Buffer.from("definitely not a zip"));
    await assert.rejects(
      () => readShowtimePreview(db, { userId: "U1", nodeId, relPath: "outputs/broken.showtime" }),
      (e: unknown) => e instanceof FileContentError && e.code === "NO_PREVIEW" && /zip/.test(e.message),
    );
  });

  it("throws NOT_FOUND for a missing bundle", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    await assert.rejects(
      () => readShowtimePreview(db, { userId: "U1", nodeId, relPath: "outputs/nope.showtime" }),
      (e: unknown) => e instanceof FileContentError && e.code === "NOT_FOUND",
    );
  });

  it("rejects a path that is not a .showtime bundle", async () => {
    const { db, nodeId } = await makeSharedDb();
    await mirrorWith(nodeId, "x.md", Buffer.from("# hi"));
    await assert.rejects(
      () => readShowtimePreview(db, { userId: "U1", nodeId, relPath: "outputs/x.md" }),
      (e: unknown) => e instanceof FileContentError && e.code === "INVALID_PATH",
    );
  });
});

describe("GET/PUT /nodes/:id/file for a .showtime bundle", () => {
  let workspace: string;
  let originalEnv: string | undefined;
  let shared: SharedDb;

  const identity: RequestIdentity = {
    userId: "U1",
    email: "owner@x.com",
    name: "Owner",
    globalScope: "admin",
    groups: [],
    groupIds: [],
    via: "env",
  };

  function mockReqRes(method: string, pathWithQuery: string, bodyJson?: unknown) {
    const captured = { statusCode: 0, body: "" };
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

  async function call(method: string, pathWithQuery: string, bodyJson?: unknown) {
    const { req, res, captured } = mockReqRes(method, pathWithQuery, bodyJson);
    await routeApiRequest(req, res, new URL(`http://localhost${pathWithQuery}`), identity);
    return captured;
  }

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-showtime-rest-"));
    originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    resetAdapterCacheForTests();
    shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "outputs"), { recursive: true });
    await writeFile(
      join(mirrorRoot, "outputs", "pitch.showtime"),
      buildZip([
        { name: "deck.md", data: Buffer.from("# deck") },
        { name: SHOWTIME_PREVIEW_ENTRY, data: Buffer.from(HTML), deflate: true },
      ]),
    );
    await writeFile(
      join(mirrorRoot, "outputs", "old.showtime"),
      buildZip([{ name: "deck.md", data: Buffer.from("# deck") }]),
    );
  });

  afterEach(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    resetAdapterCacheForTests();
    if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
    else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
    await rm(workspace, { recursive: true, force: true });
  });

  it("GET serves the bundled preview as text/html content", async () => {
    const r = await call("GET", `/nodes/${shared.nodeId}/file?path=outputs/pitch.showtime`);
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.content, HTML);
    assert.equal(body.mime_type, "text/html");
    assert.equal(body.filename, "pitch.showtime");
    assert.ok(body.local_path.endsWith("/outputs/pitch.showtime"));
  });

  it("GET answers 422 NO_PREVIEW for a bundle without preview.html", async () => {
    const r = await call("GET", `/nodes/${shared.nodeId}/file?path=outputs/old.showtime`);
    assert.equal(r.statusCode, 422);
    assert.equal(JSON.parse(r.body).code, "NO_PREVIEW");
  });

  it("PUT refuses to write a bundle as text", async () => {
    const r = await call("PUT", `/nodes/${shared.nodeId}/file?path=outputs/pitch.showtime`, {
      content: "<html>edited</html>",
    });
    assert.equal(r.statusCode, 415);
    assert.equal(JSON.parse(r.body).code, "NOT_EDITABLE");
  });
});
