// Hardening tests for the raw HTTP layer: a malformed Host header must not
// crash the process (new URL("...", "http://[") throws before any gate),
// and shutdown must not hang on idle keep-alive connections.

process.env.PORT = "14920";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { createClient } from "@libsql/client";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";

const PORT = 14920;
const BASE = `http://127.0.0.1:${PORT}`;

let handle: HttpServerHandle;

before(async () => {
  resetGateCachesForTesting();
  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);
  handle = startHttpServer({ port: PORT, host: "127.0.0.1", registerSigint: false });
  await new Promise((r) => setImmediate(r));
});

after(async () => {
  await handle.shutdown();
  setDbForTesting(null);
});

function rawRequest(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(PORT, "127.0.0.1", () => {
      sock.write(payload);
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
    });
    sock.on("end", () => resolve(buf));
    sock.on("error", reject);
    sock.setTimeout(3000, () => {
      sock.destroy();
      resolve(buf);
    });
  });
}

describe("http hardening", () => {
  it("survives a Host header that breaks URL parsing", async () => {
    const res = await rawRequest("GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n");
    assert.match(res, /HTTP\/1\.1 (400|403)/, `expected a clean reject, got: ${res.slice(0, 120)}`);
    // The process is still alive and serving.
    const health = await fetch(`${BASE}/health`);
    assert.equal(health.status, 200);
  });

  it("shutdown completes despite an idle keep-alive connection", async () => {
    // Park an idle keep-alive socket on the server.
    const sock = connect(PORT, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      sock.on("connect", () => {
        sock.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1:14920\r\nConnection: keep-alive\r\n\r\n");
      });
      sock.once("data", () => resolve());
      sock.on("error", reject);
    });

    const result = await Promise.race([
      handle.shutdown().then(() => "done"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 5000)),
    ]);
    sock.destroy();
    assert.equal(result, "done", "shutdown must not wait forever on idle keep-alive sockets");
  });
});
