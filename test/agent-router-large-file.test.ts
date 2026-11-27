// A team workspace's large-file push end to end (#662): the agent router
// over the real HTTP CentralClient against a fake central server on a
// socket. The fake reads the PUT body as a stream (never collecting it), so
// the test proves the sync agent sends the file as application/octet-stream
// with no base64 and no JSON envelope, and that central's FILE_TOO_LARGE
// lands in the file's status, the Unsynced dialog's /sync/pending, and the
// sync run's errors.
import { useTestBearer, authFetch } from "./helpers/auth.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { createAgentRouter } from "../apps/server/api/agent-router.js";
import { createHttpCentralClient, type CentralClient } from "../apps/server/domain/sync/central/client.js";
import { statusScanCentral, storeFileCentral } from "../apps/server/domain/sync/central/engine-central.js";
import { FileTooLargeError } from "../apps/server/domain/sync/file-size-limit.js";
import { stat } from "node:fs/promises";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetRemoteFileLimitForTests } from "../apps/server/domain/sync/file-size-limit.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { SOLO_USER } from "../apps/server/infra/schema.js";

const NODE_ID = "N000000000000000000000PROJ";
const NODE_ROOT = posix.join("workflow", "projects", "stan-gws");

interface ReceivedPut {
  relPath: string;
  contentType: string | undefined;
  query: URLSearchParams;
  total: number;
  largestRead: number;
  sha: string;
}

// The central server's side of the contract, just enough of it: sync-info,
// register-batch, the remote sweep, and the streamed PUT.
class FakeCentralServer {
  records = new Map<string, { id: string; filename: string; hash: string | null }>();
  puts: ReceivedPut[] = [];
  // central's own PORTUNI_MAX_FILE_BYTES; null = no limit here.
  limit: number | null = null;
  // Whether sync-info carries the limit as max_file_bytes (a current central
  // does; false plays an older one that only says so on a refused push).
  publishLimit = false;
  // When set, a PUT with ifAbsent answers EXISTS with this hash, the way
  // central reports what its stat saw.
  existsWithHash: string | null = null;
  // When true, a PUT with baseCanonicalHash stores the bytes and then
  // answers CONFLICT with their hash: the retry of a push whose first
  // answer was lost after central committed it.
  conflictAfterStore = false;
  server: Server;
  nextId = 1;

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, json }) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(json));
        },
        (err: unknown) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err), code: "INTERNAL_ERROR" }));
        },
      );
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  syncInfo() {
    return {
      node: { id: NODE_ID, name: "Stan GWS", type: "project", sync_key: "stan-gws", org_sync_key: "workflow" },
      remote_name: "test-fs",
      ...(this.publishLimit && this.limit !== null ? { max_file_bytes: this.limit } : {}),
      files: Array.from(this.records.entries()).map(([remotePath, r]) => ({
        id: r.id,
        filename: r.filename,
        status: "wip",
        remote_path: remotePath,
        current_remote_hash: r.hash,
        is_native_format: false,
        mime_type: null,
      })),
    };
  }

  async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
  }

  async handle(req: IncomingMessage): Promise<{ status: number; json: unknown }> {
    const url = new URL(req.url ?? "/", "http://central");
    const p = url.pathname;
    if (p === `/nodes/${NODE_ID}/sync-info` && req.method === "GET") return { status: 200, json: this.syncInfo() };
    if (p === "/sync/info-batch" && req.method === "POST") return { status: 200, json: { infos: [this.syncInfo()] } };
    if (p === `/nodes/${NODE_ID}/sync/remote-sweep`) {
      return { status: 200, json: { adopted: [], deleted_on_remote: [], errors: [], repaired: [], pending_repairs: [] } };
    }
    if (p === `/nodes/${NODE_ID}/files/register-batch` && req.method === "POST") {
      const body = await this.readJson(req);
      const files = (body.relPaths as string[]).map((rel) => {
        const remotePath = posix.join(NODE_ROOT, rel);
        let r = this.records.get(remotePath);
        if (!r) {
          r = { id: `F${this.nextId++}`, filename: rel.split("/").pop()!, hash: null };
          this.records.set(remotePath, r);
        }
        return { id: r.id, filename: r.filename, remote_name: "test-fs", remote_path: remotePath };
      });
      return { status: 201, json: { files } };
    }
    if (p === `/nodes/${NODE_ID}/file` && req.method === "PUT") {
      const relPath = url.searchParams.get("path")!;
      const size = Number(req.headers["content-length"]);
      if (this.limit !== null && size > this.limit) {
        req.resume();
        return {
          status: 413,
          json: { error: "too large", code: "FILE_TOO_LARGE", params: { size, limit: this.limit } },
        };
      }
      if (this.existsWithHash && url.searchParams.get("ifAbsent") === "1") {
        req.resume();
        return {
          status: 409,
          json: { error: "exists", code: "EXISTS", currentVersion: this.existsWithHash, params: { filename: relPath } },
        };
      }
      // Read as a stream: hash and count, never collect.
      const h = createHash("sha256");
      let total = 0;
      let largestRead = 0;
      for await (const c of req) {
        const b = c as Buffer;
        total += b.length;
        largestRead = Math.max(largestRead, b.length);
        h.update(b);
      }
      const sha = h.digest("hex");
      this.puts.push({ relPath, contentType: req.headers["content-type"], query: url.searchParams, total, largestRead, sha });
      const rec = this.records.get(posix.join(NODE_ROOT, relPath));
      if (rec) rec.hash = sha;
      if (this.conflictAfterStore && url.searchParams.get("baseCanonicalHash")) {
        return { status: 409, json: { error: "changed", code: "CONFLICT", currentVersion: sha } };
      }
      return { status: 200, json: { version: sha, canonical_hash: sha } };
    }
    return { status: 404, json: { error: `no route ${req.method} ${p}`, code: "ROUTE_NOT_FOUND" } };
  }
}

let workspace: string;
let mirrorRoot: string;
let originalEnv: string | undefined;
let originalToken: string | undefined;
let handle: HttpServerHandle;
let base: string;
let central: FakeCentralServer;
let client: CentralClient;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-agent-large-"));
  mirrorRoot = join(workspace, "workflow", "projects", "stan-gws");
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  originalToken = process.env.PORTUNI_AUTH_TOKEN;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  useTestBearer();
  resetLocalDbForTests();
  resetRemoteFileLimitForTests();

  central = new FakeCentralServer();
  const centralUrl = await central.listen();
  client = createHttpCentralClient({ baseUrl: centralUrl, token: "ptk_test", syncInfoTtlMs: 0 });
  handle = startHttpServer({
    port: 0,
    host: "127.0.0.1",
    registerSigint: false,
    router: createAgentRouter(client),
    mountMcp: false,
  });
  if (!handle.server.listening) await new Promise<void>((r) => handle.server.once("listening", r));
  const addr = handle.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  process.env.PORT = String(addr.port);
  resetGateCachesForTesting();

  for (const s of ["wip", "outputs", "resources"]) await mkdir(join(mirrorRoot, s), { recursive: true });
  await registerMirror(SOLO_USER, NODE_ID, mirrorRoot);
});

afterEach(async () => {
  await handle.shutdown();
  await new Promise<void>((r) => central.server.close(() => r()));
  resetGateCachesForTesting();
  resetLocalDbForTests();
  resetRemoteFileLimitForTests();
  delete process.env.PORTUNI_MAX_FILE_BYTES;
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  if (originalToken === undefined) delete process.env.PORTUNI_AUTH_TOKEN;
  else process.env.PORTUNI_AUTH_TOKEN = originalToken;
  await rm(workspace, { recursive: true, force: true });
});

function bytes(n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 4096) b[i] = (i / 4096) & 0xff;
  return b;
}

describe("sync agent large-file push (#662)", () => {
  it("sends the file as a streamed octet-stream body and central receives it whole", async () => {
    const data = bytes(24 * 1024 * 1024 + 17);
    await writeFile(join(mirrorRoot, "wip", "big.csv"), data);
    const run = await authFetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    assert.equal(run.status, 200);
    const r = (await run.json()) as { adopted: unknown[]; errors: unknown[] };
    assert.deepEqual(r.errors, []);
    assert.equal(r.adopted.length, 1);

    assert.equal(central.puts.length, 1);
    const put = central.puts[0];
    assert.equal(put.relPath, "wip/big.csv");
    assert.equal(put.contentType, "application/octet-stream");
    assert.equal(put.query.get("ifAbsent"), "1");
    assert.equal(put.total, data.length, "the raw bytes, not base64 (which would be a third larger)");
    assert.equal(put.sha, createHash("sha256").update(data).digest("hex"));
    assert.ok(put.largestRead < data.length, "central read the body in pieces");

    const st = await authFetch(`${base}/nodes/${NODE_ID}/sync-status`);
    const s = (await st.json()) as { files: Array<{ sync_class: string }> };
    assert.deepEqual(s.files.map((f) => f.sync_class), ["clean"]);
  });

  it("central's FILE_TOO_LARGE shows in the sync run, /sync/pending and the status scan", async () => {
    central.limit = 1024 * 1024;
    const size = 2 * 1024 * 1024;
    await writeFile(join(mirrorRoot, "wip", "big.csv"), bytes(size));
    await writeFile(join(mirrorRoot, "wip", "small.md"), "fits");

    const run = await authFetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    const r = (await run.json()) as { adopted: Array<{ filename: string }>; errors: Array<{ filename: string; error: string }> };
    assert.deepEqual(r.adopted.map((a) => a.filename), ["small.md"]);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].filename, "big.csv");
    assert.match(r.errors[0].error, /FILE_TOO_LARGE|413/);

    const pending = await authFetch(`${base}/sync/pending`);
    const body = (await pending.json()) as {
      total: number;
      nodes: Array<{
        push: number;
        errors?: Array<{ file_id: string | null; filename: string; code: string; params: Record<string, number> }>;
      }>;
    };
    assert.equal(body.total, 1, "still unsynced work");
    const errs = body.nodes[0].errors ?? [];
    assert.equal(errs.length, 1);
    const { file_id, ...rest } = errs[0];
    assert.ok(file_id, "a registered record");
    assert.deepEqual(rest, { filename: "big.csv", code: "FILE_TOO_LARGE", params: { size, limit: 1024 * 1024 } });

    // portuni_status reads this scan: the entry carries the error.
    const scan = await statusScanCentral(client, { userId: SOLO_USER, nodeId: NODE_ID });
    const big = scan.push_candidates.find((e) => e.filename === "big.csv");
    assert.deepEqual(big?.error, { code: "FILE_TOO_LARGE", params: { size, limit: 1024 * 1024 } });

    // The next run does not send it to central again.
    const putsBefore = central.puts.length;
    await authFetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    assert.equal(central.puts.length, putsBefore);
  });

  it("the device's own limit refuses the file before anything is sent", async () => {
    process.env.PORTUNI_MAX_FILE_BYTES = "1000";
    await writeFile(join(mirrorRoot, "wip", "big.csv"), bytes(1001));
    const pending = await authFetch(`${base}/sync/pending`);
    const body = (await pending.json()) as { nodes: Array<{ errors?: Array<{ file_id: string | null; code: string; params: unknown }> }> };
    assert.deepEqual(body.nodes[0].errors, [
      { file_id: null, filename: "big.csv", code: "FILE_TOO_LARGE", params: { size: 1001, limit: 1000 } },
    ]);
    const run = await authFetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    const r = (await run.json()) as { errors: Array<{ error: string }> };
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].error, /1001 bytes, over the 1000-byte limit/);
    assert.equal(central.puts.length, 0);
  });

  it("central's published limit applies on the device before any push", async () => {
    central.limit = 1000;
    central.publishLimit = true;
    await writeFile(join(mirrorRoot, "wip", "big.csv"), bytes(1001));
    const pending = await authFetch(`${base}/sync/pending`);
    const body = (await pending.json()) as { nodes: Array<{ errors?: Array<{ code: string; params: unknown }> }> };
    assert.deepEqual(body.nodes[0].errors?.map((e) => [e.code, e.params]), [["FILE_TOO_LARGE", { size: 1001, limit: 1000 }]]);
    const run = await authFetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    const r = (await run.json()) as { errors: unknown[] };
    assert.equal(r.errors.length, 1);
    assert.equal(central.puts.length, 0);
    assert.equal(central.records.size, 0, "no record on central for a file that cannot be pushed");
  });

  it("an EXISTS answer with the remote's hash adopts identical bytes without downloading them", async () => {
    const data = bytes(3 * 1024 * 1024);
    central.existsWithHash = createHash("md5").update(data).digest("hex");
    await writeFile(join(mirrorRoot, "wip", "big.csv"), data);
    const run = await authFetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    const r = (await run.json()) as { adopted: unknown[]; errors: unknown[]; conflicts: unknown[] };
    // The fake serves no GET /file: a download would have failed the push.
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.adopted.length, 1);
  });

  it("a CONFLICT that reports this push's own bytes is a landed push, not a conflict", async () => {
    const file = join(mirrorRoot, "wip", "big.csv");
    await writeFile(file, bytes(6 * 1024 * 1024));
    await authFetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    await writeFile(file, bytes(7 * 1024 * 1024));
    central.conflictAfterStore = true;
    const run = await authFetch(`${base}/nodes/${NODE_ID}/sync`, { method: "POST" });
    const r = (await run.json()) as { errors: unknown[]; conflicts: unknown[] };
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.errors, []);
    const st = await authFetch(`${base}/nodes/${NODE_ID}/sync-status`);
    const s = (await st.json()) as { files: Array<{ sync_class: string }> };
    assert.deepEqual(s.files.map((f) => f.sync_class), ["clean"]);
  });

  it("portuni_store refuses an over-limit file before copying it into the mirror or registering it", async () => {
    process.env.PORTUNI_MAX_FILE_BYTES = "1000";
    const outside = join(workspace, "outside.csv");
    await writeFile(outside, bytes(1001));
    await assert.rejects(
      storeFileCentral(client, { userId: SOLO_USER, nodeId: NODE_ID, localPath: outside }),
      (e: unknown) => e instanceof FileTooLargeError && e.params.size === 1001 && e.params.limit === 1000,
    );
    assert.equal(central.records.size, 0);
    await assert.rejects(stat(join(mirrorRoot, "wip", "outside.csv")), /ENOENT/);
  });
});
