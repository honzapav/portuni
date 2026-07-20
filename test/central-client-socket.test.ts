// GH #80 network pathologies against a REAL HTTP server and the REAL global
// fetch (undici) -- no fetchImpl stub. The stubbed tests in
// central-client.test.ts prove the retry logic; the bug itself lived below
// the stub: requests scheduled onto dead keep-alive sockets that never
// settle. These tests drive the actual TCP stack -- a connection that goes
// silent, a connection killed mid-request -- and assert the client's
// timeout + retry-once turns each into either a success or a bounded
// rejection, never a silent forever-hang.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createHttpCentralClient } from "../apps/server/domain/sync/central/client.js";

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, attempt: number) => void,
): Promise<{ baseUrl: string; attempts: () => number }> {
  let attempt = 0;
  server = createServer((req, res) => {
    attempt += 1;
    handler(req, res, attempt);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return { baseUrl: `http://127.0.0.1:${addr.port}`, attempts: () => attempt };
}

function respondRegistered(res: ServerResponse): void {
  res.writeHead(201, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "F1", filename: "a.md", remote_name: "r", remote_path: "p" }));
}

describe("central client on a real socket (GH #80)", () => {
  it("a server that accepts and never responds yields a bounded rejection, not a hang", async () => {
    const { baseUrl, attempts } = await listen((_req, _res) => {
      /* hold the connection open, write nothing -- the zombie slot */
    });
    const c = createHttpCentralClient({ baseUrl, token: "t", requestTimeoutMs: 250 });
    const t0 = Date.now();
    await assert.rejects(() => c.registerFile("N1", "wip/a.md"));
    const elapsed = Date.now() - t0;
    // Two attempts x 250 ms timeout, plus slack. Without AbortSignal.timeout
    // this promise never settles at all.
    assert.ok(elapsed < 2_500, `rejected after ${elapsed} ms, expected bounded by timeout`);
    assert.equal(attempts(), 2);
  });

  it("a connection killed mid-request is retried on a fresh socket and succeeds", async () => {
    const { baseUrl, attempts } = await listen((req, res, attempt) => {
      if (attempt === 1) {
        req.socket.destroy();
        return;
      }
      respondRegistered(res);
    });
    const c = createHttpCentralClient({ baseUrl, token: "t", requestTimeoutMs: 2_000 });
    const r = await c.registerFile("N1", "wip/a.md");
    assert.equal(r.id, "F1");
    assert.equal(attempts(), 2);
  });

  it("a first attempt that hangs is aborted by the timeout; the retry lands the mutation", async () => {
    const { baseUrl, attempts } = await listen((_req, res, attempt) => {
      if (attempt === 1) return; // silent socket, never answers
      respondRegistered(res);
    });
    const c = createHttpCentralClient({ baseUrl, token: "t", requestTimeoutMs: 250 });
    const t0 = Date.now();
    const r = await c.registerFile("N1", "wip/a.md");
    assert.equal(r.id, "F1");
    assert.equal(attempts(), 2);
    assert.ok(Date.now() - t0 >= 240, "success must have gone through the timeout+retry path");
  });

  it("keep-alive reuse: a request storm over one client all lands (burst does not starve)", async () => {
    // The naturamed failure shape: several registrations within the same
    // second. Every request must reach the server -- none may be silently
    // dropped by connection scheduling.
    const { baseUrl, attempts } = await listen((_req, res) => respondRegistered(res));
    const c = createHttpCentralClient({ baseUrl, token: "t", requestTimeoutMs: 2_000 });
    const results = await Promise.all(
      ["a", "b", "c", "d", "e"].map((n) => c.registerFile("N1", `wip/${n}.md`)),
    );
    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.id === "F1"));
    assert.equal(attempts(), 5);
  });
});
