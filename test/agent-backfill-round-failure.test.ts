// #633 review (M2): a failure that every request of the sync agent's
// backfill round would get too -- central's 429, a 401 for the token,
// no network -- ends the round. It never fans out to one GET per mirror
// after a failed batch, and a 429 holds the next round off for at least
// central's Retry-After. A per-request answer (an older central without
// the batch route, a 5xx) still falls back to one GET per mirror.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CentralHttpError, CentralUnreachableError, createHttpCentralClient } from "../apps/server/domain/sync/central/client.js";
import { createCentralBackfillSweep, isCentralRoundFailure, roundFailureOf } from "../apps/server/boot/central-backfill.js";
import { listUserMirrors, registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";

const USER = "01SOLO0000000000000000000";
const MIRRORS = 6;

// Status the fake central answers the batch / each single GET with.
let batchStatus = 200;
let singleStatus = 200;
const requests: string[] = [];
let server: Server;
let baseUrl: string;
let dir: string;

// The body central's limiter sends (http/server.ts) and its header.
function send(res: import("node:http").ServerResponse, status: number, okBody: unknown): void {
  res.statusCode = status;
  if (status === 200) {
    res.end(JSON.stringify(okBody));
  } else if (status === 429) {
    res.setHeader("Retry-After", "14");
    res.end(JSON.stringify({ error: "rate limited", code: "RATE_LIMITED", params: { retryAfterSeconds: 14 } }));
  } else if (status === 404) {
    // An older central without the batch route: no NODE_NOT_FOUND code.
    res.end(JSON.stringify({ error: "Not found" }));
  } else {
    res.end(JSON.stringify({ error: "failed", code: "INTERNAL" }));
  }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-round-failure-"));
  process.env.PORTUNI_WORKSPACE_ROOT = dir;
  resetLocalDbForTests();
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/sync/info-batch") return send(res, batchStatus, { infos: [] });
      const id = /^\/nodes\/([^/]+)\/sync-info$/.exec(req.url ?? "")?.[1] ?? "X";
      send(res, singleStatus, {
        node: { id, type: "project", name: id, sync_key: id.toLowerCase(), org_sync_key: "org" },
        remote: null,
        files: [],
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (let i = 0; i < MIRRORS; i++) {
    const folder = join(dir, `m${i}`);
    await mkdir(folder, { recursive: true });
    await registerMirror(USER, `N${i}`, folder);
  }
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  resetLocalDbForTests();
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
});

function capture() {
  const lines: string[] = [];
  const log = {
    warn: (...a: unknown[]) => void lines.push(a.map(String).join(" ")),
    error: (...a: unknown[]) => void lines.push(a.map(String).join(" ")),
  };
  return { lines, log };
}

const singles = () => requests.filter((r) => r.startsWith("GET /nodes/")).length;

describe("backfill round: a failure that holds for every request stops it", () => {
  // batch status, single status -> per-mirror GETs sent, the one log line.
  const rows: { name: string; batch: number; single: number; maxSingles: number; minSingles: number; line: RegExp | null }[] = [
    { name: "batch 429", batch: 429, single: 200, minSingles: 0, maxSingles: 0, line: /rate limited this device \(retry after 14 s\)/ },
    { name: "batch 401", batch: 401, single: 200, minSingles: 0, maxSingles: 0, line: /refused this device's token \(401\)/ },
    // A 403 names one node or route, so it is not the token's: per mirror.
    { name: "batch 403", batch: 403, single: 200, minSingles: MIRRORS, maxSingles: MIRRORS, line: /sync-info batch failed, asking per mirror/ },
    { name: "batch route missing (older central)", batch: 404, single: 200, minSingles: MIRRORS, maxSingles: MIRRORS, line: /sync-info batch failed, asking per mirror/ },
    { name: "batch 500", batch: 500, single: 200, minSingles: MIRRORS, maxSingles: MIRRORS, line: /sync-info batch failed, asking per mirror/ },
    // Batch fine but omits the nodes; the per-mirror GETs then get 429:
    // the round stops after the requests already in flight (4 workers).
    { name: "per-mirror 429", batch: 200, single: 429, minSingles: 1, maxSingles: 4, line: /rate limited this device/ },
    { name: "per-mirror 401", batch: 200, single: 401, minSingles: 1, maxSingles: 4, line: /refused this device's token/ },
  ];
  for (const row of rows) {
    it(row.name, async () => {
      batchStatus = row.batch;
      singleStatus = row.single;
      const client = createHttpCentralClient({ baseUrl, token: "t", syncInfoTtlMs: 0 });
      const { lines, log } = capture();
      await createCentralBackfillSweep({ client, userId: USER, log })("boot");
      const n = singles();
      assert.ok(n >= row.minSingles && n <= row.maxSingles, `${row.name}: ${n} per-mirror GETs`);
      assert.equal(lines.length, 1, `${row.name}: one line, got ${JSON.stringify(lines)}`);
      if (row.line) assert.match(lines[0], row.line);
      assert.equal((await listUserMirrors(USER)).length, MIRRORS, "every mirror kept");
    });
  }

  it("a 429 holds the next round off for at least Retry-After, then retries", async () => {
    batchStatus = 429;
    singleStatus = 200;
    let t = 1_000_000;
    const client = createHttpCentralClient({ baseUrl, token: "t", syncInfoTtlMs: 0 });
    const { log } = capture();
    const sweep = createCentralBackfillSweep({ client, userId: USER, log, now: () => t });
    await sweep("boot");
    assert.equal(requests.length, 1, "the batch only");
    t += 14_000;
    await sweep("sweep");
    assert.equal(requests.length, 1, "inside Retry-After: nothing sent");
    batchStatus = 200;
    t += 10 * 60_000;
    await sweep("sweep");
    assert.ok(requests.length > 1, "after the backoff the round runs again");
  });
});

describe("roundFailureOf", () => {
  const http = (status: number, params?: Record<string, number>) =>
    new CentralHttpError("x", status, undefined, undefined, params);
  const rows: [string, unknown, ReturnType<typeof roundFailureOf>][] = [
    ["fetch TypeError", new TypeError("fetch failed"), { kind: "unreachable" }],
    ["timeout abort", new DOMException("timed out", "TimeoutError"), { kind: "unreachable" }],
    ["429 with retryAfterSeconds", http(429, { retryAfterSeconds: 14 }), { kind: "rate_limited", retryAfterMs: 14_000 }],
    ["429 without params: the limiter's minute", http(429), { kind: "rate_limited", retryAfterMs: 60_000 }],
    ["401", http(401), { kind: "refused", status: 401 }],
    ["403 names one node or route", http(403), null],
    ["404 NODE_NOT_FOUND is about one node", new CentralHttpError("x", 404, "NODE_NOT_FOUND"), null],
    ["409", http(409), null],
    ["500", http(500), null],
    ["503", http(503), null],
  ];
  for (const [name, e, want] of rows) {
    it(name, () => assert.deepEqual(roundFailureOf(e), want));
  }
});

// The per-file reconcile inside a mirror rethrows only these: a file this
// device cannot read must not end the round as "central unreachable".
describe("isCentralRoundFailure", () => {
  const eacces = Object.assign(new Error("EACCES: permission denied, open '/w/a/x'"), { code: "EACCES" });
  const rows: [string, unknown, boolean][] = [
    ["EACCES on a local file", eacces, false],
    ["file deleted while hashed (ENOENT)", Object.assign(new Error("ENOENT"), { code: "ENOENT" }), false],
    ["a bug: TypeError without a cause", new TypeError("x is undefined"), false],
    // The raw fetch error never reaches here: the client wraps it.
    ["no answer (Node: undici TypeError with cause)", new CentralUnreachableError(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") })), true],
    ["no answer (Bun: plain Error with a code)", new CentralUnreachableError(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })), true],
    ["no answer (timeout)", new CentralUnreachableError(new DOMException("timed out", "TimeoutError")), true],
    ["central 429", new CentralHttpError("x", 429), true],
    ["central 401", new CentralHttpError("x", 401), true],
    ["central 403", new CentralHttpError("x", 403), false],
    ["central 409", new CentralHttpError("x", 409), false],
    ["central 503", new CentralHttpError("x", 503), false],
  ];
  for (const [name, e, want] of rows) {
    it(name, () => assert.equal(isCentralRoundFailure(e), want));
  }
});

describe("the central client wraps a request central never answered", () => {
  it("throws CentralUnreachableError with the original as cause, after its one retry", async () => {
    let calls = 0;
    const bunLike = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
      code: "ConnectionRefused",
    });
    const client = createHttpCentralClient({
      baseUrl: "http://central.invalid",
      token: "t",
      syncInfoTtlMs: 0,
      fetchImpl: (async () => {
        calls++;
        throw bunLike;
      }) as typeof fetch,
    });
    const err = await client.syncInfo("N1").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof CentralUnreachableError);
    assert.equal((err as Error).cause, bunLike);
    assert.equal((err as Error).message, bunLike.message);
    assert.equal(calls, 2);
    assert.equal(isCentralRoundFailure(err), true);
    assert.deepEqual(roundFailureOf(err), { kind: "unreachable" });
  });
});
