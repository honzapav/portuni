// Drive uploads over 5 MB go through a resumable session in chunks (#662);
// at or under 5 MB they stay one multipart request. The fake fetch plays
// the session: it records every chunk's Content-Range, answers 308 with the
// Range it holds, and can fail one chunk once to prove the retry resumes
// from what the session reports.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  createDriveAdapter,
  __setDriveFetchForTests,
  MULTIPART_MAX_BYTES,
} from "../apps/server/domain/sync/drive-adapter.js";
import type { RemoteConfig, DeviceTokens } from "../apps/server/domain/sync/types.js";
import { resetSaTokenCacheForTests } from "../apps/server/domain/sync/drive-sa-auth.js";

const { privateKey: pk } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const sa = JSON.stringify({
  type: "service_account",
  client_email: "sa@proj.iam.gserviceaccount.com",
  private_key: pk.export({ type: "pkcs8", format: "pem" }) as string,
  token_uri: "https://oauth2.googleapis.com/token",
});
const remote: RemoteConfig = { name: "dw", type: "gdrive", config: { shared_drive_id: "0AXy" } };
const tokens: DeviceTokens = { dw: { mode: "service_account", service_account_json: sa } };

const SESSION = "https://www.googleapis.com/upload/drive/v3/files?upload_id=S1";
const CHUNK = 1024 * 1024; // test chunk: 4 x 256 KiB

interface Recorded {
  method: string;
  url: string;
  contentRange: string | null;
  bodyLength: number;
  headers: Record<string, string>;
}

// Session fake. `failOnce` names the start offset of a chunk whose first
// attempt fails: "network" throws, "503" answers 503, "partial" keeps only
// half of it and answers 308 with that Range.
function installFake(
  opts: { failOnce?: { at: number; how: "network" | "503" | "partial" }; failStatusQueries?: number } = {},
) {
  let statusFailuresLeft = opts.failStatusQueries ?? 0;
  const calls: Recorded[] = [];
  let received = Buffer.alloc(0);
  let total = -1;
  let failed = false;
  __setDriveFetchForTests(async (url, init) => {
    const u = url.toString();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body as Uint8Array | string | undefined;
    const bodyLength = body === undefined ? 0 : typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
    calls.push({ method: init?.method ?? "GET", url: u, contentRange: headers["content-range"] ?? null, bodyLength, headers });
    if (u.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "A", expires_in: 3600 }), { status: 200 });
    }
    if (u.includes("/files?q=")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
    if (u.includes("uploadType=resumable")) {
      total = Number(headers["x-upload-content-length"]);
      return new Response(null, { status: 200, headers: { location: SESSION } });
    }
    if (u.includes("uploadType=multipart")) {
      return new Response(JSON.stringify({ id: "M1", name: "big.csv", mimeType: "text/csv", size: "1" }), { status: 200 });
    }
    if (u === SESSION) {
      const range = headers["content-range"]!;
      const status = (): Response =>
        received.length === 0
          ? new Response(null, { status: 308 })
          : new Response(null, { status: 308, headers: { range: `bytes=0-${received.length - 1}` } });
      if (range.startsWith("bytes */")) {
        if (statusFailuresLeft > 0) {
          statusFailuresLeft -= 1;
          throw new TypeError("fetch failed");
        }
        return status();
      }
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)!;
      const start = Number(m[1]);
      assert.equal(start, received.length, `chunk must continue at ${received.length}, got ${range}`);
      let chunk = Buffer.from(body as Uint8Array);
      assert.equal(chunk.length, Number(m[2]) - start + 1);
      if (opts.failOnce && !failed && start === opts.failOnce.at) {
        failed = true;
        if (opts.failOnce.how === "network") throw new TypeError("fetch failed");
        if (opts.failOnce.how === "503") return new Response("backend error", { status: 503 });
        chunk = chunk.subarray(0, chunk.length / 2);
      }
      received = Buffer.concat([received, chunk]);
      if (received.length === total) {
        const md5 = createHash("md5").update(received).digest("hex");
        return new Response(
          JSON.stringify({ id: "R1", name: "big.csv", mimeType: "text/csv", size: String(total), md5Checksum: md5 }),
          { status: 200 },
        );
      }
      return status();
    }
    return new Response("{}", { status: 200 });
  });
  return { calls, received: () => received };
}

function bytes(n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

function chunkRanges(calls: Recorded[]): string[] {
  return calls.filter((c) => c.url === SESSION).map((c) => c.contentRange!);
}

describe("Drive adapter uploads (#662)", () => {
  beforeEach(() => resetSaTokenCacheForTests());

  it("a file of exactly 5 MB stays one multipart request", async () => {
    const { calls } = installFake();
    const adapter = createDriveAdapter(remote, tokens, { uploadChunkBytes: CHUNK, uploadRetryDelayMs: 0 });
    await adapter.put("big.csv", bytes(MULTIPART_MAX_BYTES), { mimeType: "text/csv" });
    assert.ok(calls.some((c) => c.url.includes("uploadType=multipart")));
    assert.ok(!calls.some((c) => c.url.includes("uploadType=resumable")));
  });

  it("over 5 MB opens a resumable session and sends the chunks in order", async () => {
    const { calls, received } = installFake();
    const adapter = createDriveAdapter(remote, tokens, { uploadChunkBytes: CHUNK, uploadRetryDelayMs: 0 });
    const data = bytes(MULTIPART_MAX_BYTES + 300_000);
    const ref = await adapter.put("big.csv", data, { mimeType: "text/csv" });

    const init = calls.find((c) => c.url.includes("uploadType=resumable"))!;
    assert.ok(init, "expected a resumable session start");
    assert.equal(init.method, "POST");
    assert.ok(init.url.includes("supportsAllDrives=true"));
    assert.equal(init.headers["x-upload-content-length"], String(data.length));
    assert.equal(init.headers["x-upload-content-type"], "text/csv");
    assert.ok(!calls.some((c) => c.url.includes("uploadType=multipart")));

    const total = data.length;
    const expected: string[] = [];
    for (let s = 0; s < total; s += CHUNK) expected.push(`bytes ${s}-${Math.min(s + CHUNK, total) - 1}/${total}`);
    assert.deepEqual(chunkRanges(calls), expected);
    assert.ok(received().equals(data));
    assert.equal(ref.hash, createHash("md5").update(data).digest("hex"));
    assert.equal(ref.remote_file_id, "R1");
  });

  for (const how of ["network", "503", "partial"] as const) {
    it(`retries one chunk after a ${how} failure and resumes from the session's Range`, async () => {
      const { calls, received } = installFake({ failOnce: { at: 2 * CHUNK, how } });
      const adapter = createDriveAdapter(remote, tokens, { uploadChunkBytes: CHUNK, uploadRetryDelayMs: 0 });
      const data = bytes(6 * CHUNK + 1234);
      await adapter.put("big.csv", data);
      const total = data.length;
      const ranges = chunkRanges(calls);
      const third = `bytes ${2 * CHUNK}-${3 * CHUNK - 1}/${total}`;
      if (how === "partial") {
        // The session kept half: the rest of the same chunk goes next, no status query.
        assert.deepEqual(ranges.slice(2, 4), [third, `bytes ${2.5 * CHUNK}-${3 * CHUNK - 1}/${total}`]);
      } else {
        // The failed attempt, the status query, then the whole chunk again.
        assert.deepEqual(ranges.slice(2, 5), [third, `bytes */${total}`, third]);
      }
      assert.equal(ranges[ranges.length - 1], `bytes ${6 * CHUNK}-${total - 1}/${total}`);
      assert.ok(received().equals(data));
    });
  }

  it("a status query that fails too costs one attempt, not the upload", async () => {
    const { calls, received } = installFake({ failOnce: { at: CHUNK, how: "network" }, failStatusQueries: 1 });
    const adapter = createDriveAdapter(remote, tokens, { uploadChunkBytes: CHUNK, uploadRetryDelayMs: 0 });
    const data = bytes(6 * CHUNK);
    await adapter.put("big.csv", data);
    const total = data.length;
    const second = `bytes ${CHUNK}-${2 * CHUNK - 1}/${total}`;
    // The failed chunk, a status query that fails, a second one that answers, the chunk again.
    assert.deepEqual(chunkRanges(calls).slice(1, 5), [second, `bytes */${total}`, `bytes */${total}`, second]);
    assert.ok(received().equals(data));
  });

  it("an expired session (404 on the status query) ends the upload", async () => {
    let n = 0;
    __setDriveFetchForTests(async (url, init) => {
      const u = url.toString();
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "A", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("/files?q=")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
      if (u.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { location: SESSION } });
      n += 1;
      const range = new Headers(init?.headers).get("content-range") ?? "";
      if (range.startsWith("bytes */")) return new Response("gone", { status: 404 });
      return new Response("backend error", { status: 503 });
    });
    const adapter = createDriveAdapter(remote, tokens, { uploadChunkBytes: CHUNK, uploadRetryDelayMs: 0 });
    await assert.rejects(adapter.put("big.csv", bytes(6 * CHUNK)), /resumable status\): 404/);
    assert.equal(n, 2, "one chunk attempt, one status query");
  });

  it("putStream re-slices an arbitrary stream into chunks", async () => {
    const { calls, received } = installFake();
    const adapter = createDriveAdapter(remote, tokens, { uploadChunkBytes: CHUNK, uploadRetryDelayMs: 0 });
    const data = bytes(7 * CHUNK + 5);
    async function* pieces() {
      for (let i = 0; i < data.length; i += 100_003) yield data.subarray(i, i + 100_003);
    }
    await adapter.putStream!("big.csv", pieces(), { size: data.length });
    assert.equal(chunkRanges(calls).length, 8);
    assert.ok(received().equals(data));
  });

  it("putStream refuses a stream that ends before its declared size", async () => {
    installFake();
    const adapter = createDriveAdapter(remote, tokens, { uploadChunkBytes: CHUNK, uploadRetryDelayMs: 0 });
    const data = bytes(6 * CHUNK + 10);
    await assert.rejects(
      adapter.putStream!("big.csv", [data], { size: data.length + 1 }),
      /stream ended at/,
    );
  });
});
