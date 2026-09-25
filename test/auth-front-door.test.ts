// #521: the env-mode front door always checks the bearer. A request with no
// bearer and one with a wrong bearer both get 401, with bodies that tell
// the two apart (and never echo the token); /health and /mcp/info stay
// public. The token is read live: the middleware below is imported (static
// imports run before any of this file's code) long before the token is
// set, and a token changed after the start is the one that counts.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { ensureSchema } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { TEST_BEARER } from "./helpers/auth.js";

const KEYS = ["PORTUNI_AUTH_TOKEN", "PORTUNI_AUTH_MODE", "TURSO_URL", "PORT"] as const;

describe("env-mode front door", () => {
  let saved: Record<string, string | undefined>;
  let tmp: string;
  let handle: HttpServerHandle;
  let base: string;

  before(async () => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    delete process.env.PORTUNI_AUTH_MODE;
    tmp = mkdtempSync(join(tmpdir(), "portuni-front-door-"));
    process.env.TURSO_URL = `file:${join(tmp, "portuni.db")}`;
    setDbForTesting(null);
    await ensureSchema();
    // Set only now, after middleware.ts was evaluated.
    process.env.PORTUNI_AUTH_TOKEN = TEST_BEARER;
    handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false });
    if (!handle.server.listening) {
      await new Promise<void>((r) => handle.server.once("listening", r));
    }
    const { port } = handle.server.address() as AddressInfo;
    process.env.PORT = String(port);
    resetGateCachesForTesting();
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await handle.shutdown();
    setDbForTesting(null);
    resetGateCachesForTesting();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  const get = (path: string, bearer?: string) =>
    fetch(`${base}${path}`, bearer === undefined ? {} : { headers: { Authorization: `Bearer ${bearer}` } });

  it("a request without a bearer is 401 BEARER_MISSING", async () => {
    const res = await get("/graph");
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="portuni"');
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, "BEARER_MISSING");
  });

  it("a request with a wrong bearer is 401 BEARER_MISMATCH, never echoing the token", async () => {
    const res = await get("/graph", "wrong-token");
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.equal((JSON.parse(text) as { code: string }).code, "BEARER_MISMATCH");
    assert.equal(text.includes(TEST_BEARER), false);
  });

  it("the token set after importing the middleware admits the request (live read)", async () => {
    const res = await get("/graph", TEST_BEARER);
    assert.equal(res.status, 200);
  });

  it("/health and /mcp/info answer without a bearer", async () => {
    assert.equal((await get("/health")).status, 200);
    const info = await get("/mcp/info");
    assert.equal(info.status, 200);
    assert.equal(((await info.json()) as { has_auth_token: boolean }).has_auth_token, true);
  });

  it("a token rotated in the env after the start is the one that counts", async () => {
    process.env.PORTUNI_AUTH_TOKEN = "rotated-token";
    try {
      assert.equal((await get("/graph", TEST_BEARER)).status, 401);
      assert.equal((await get("/graph", "rotated-token")).status, 200);
    } finally {
      process.env.PORTUNI_AUTH_TOKEN = TEST_BEARER;
    }
  });
});
