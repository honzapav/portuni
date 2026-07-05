// REST-level coverage for /sync/drive/* -- the thin HTTP layer over
// domain/sync/remote-service (Task 4). Boots a real in-process HTTP server
// (same pattern as http-hardening.test.ts / http-rate-limit.test.ts) with a
// non-empty PORTUNI_AUTH_TOKEN so the bearer gate is exercised for real.
//
// PORTUNI_AUTH_TOKEN must be set BEFORE apps/server/http/middleware.ts is
// first evaluated, since it reads the env var into a module-level const at
// import time. Static `import` specifiers are hoisted above this file's own
// top-level code in ESM, so a plain `process.env.X = ...` followed by a
// static import would run too late. All app modules are therefore loaded
// via dynamic `import()` inside `before()`, after the env var is set.

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient, type Client } from "@libsql/client";
import type { HttpServerHandle } from "../apps/server/http/server.js";

const PORT = 14940;
const base = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-drive-token";
const auth = { Authorization: `Bearer ${TOKEN}` };
const authJson = { ...auth, "Content-Type": "application/json" };

let handle: HttpServerHandle;
let db: Client;
let workspace: string;
let resetTokenStoreForTests: () => void;
let resetUserTokenCacheForTests: () => void;
let __setUserTokenFetchForTests: (f: (params: URLSearchParams) => Promise<{ access_token: string; expires_in: number }>) => void;
let __setDriveRestFetchForTests: (f: typeof fetch) => void;

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

before(async () => {
  process.env.PORT = String(PORT);
  process.env.HOST = "127.0.0.1";
  process.env.PORTUNI_AUTH_TOKEN = TOKEN;

  const { ensureSchemaOn } = await import("../apps/server/infra/schema.js");
  const { setDbForTesting } = await import("../apps/server/infra/db.js");
  const { resetGateCachesForTesting } = await import("../apps/server/http/middleware.js");
  const { startHttpServer } = await import("../apps/server/http/server.js");
  const tokenStore = await import("../apps/server/domain/sync/token-store.js");
  const driveUserAuth = await import("../apps/server/domain/sync/drive-user-auth.js");
  const remoteService = await import("../apps/server/domain/sync/remote-service.js");
  resetTokenStoreForTests = tokenStore.resetTokenStoreForTests;
  resetUserTokenCacheForTests = driveUserAuth.resetUserTokenCacheForTests;
  __setUserTokenFetchForTests = driveUserAuth.__setUserTokenFetchForTests;
  __setDriveRestFetchForTests = remoteService.__setDriveRestFetchForTests;

  resetGateCachesForTesting();
  db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);
  handle = startHttpServer({ port: PORT, host: "127.0.0.1", registerSigint: false });
  await new Promise((r) => setImmediate(r));
});

after(async () => {
  await handle.shutdown();
  const { setDbForTesting } = await import("../apps/server/infra/db.js");
  setDbForTesting(null);
});

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-drive-rest-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  process.env.PORTUNI_TOKEN_STORE = "file";
  resetTokenStoreForTests();
  resetUserTokenCacheForTests();
  __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));
  __setDriveRestFetchForTests((async (url: string) =>
    url.includes("/drives") ? okJson({ drives: [{ id: "D1", name: "Tym" }] }) : okJson({ files: [] })
  ) as typeof fetch);
});

afterEach(async () => {
  resetTokenStoreForTests();
  delete process.env.PORTUNI_TOKEN_STORE;
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

const PATHS: Array<[string, string]> = [
  ["POST", "/sync/drive/connect"],
  ["GET", "/sync/drive/targets"],
  ["POST", "/sync/drive/target"],
  ["GET", "/sync/drive/status"],
  ["POST", "/sync/drive/test"],
  ["POST", "/sync/drive/disconnect"],
];

describe("bearer gate", () => {
  it("rejects all six drive routes without a bearer", async () => {
    for (const [method, p] of PATHS) {
      const res = await fetch(`${base}${p}`, { method });
      assert.equal(res.status, 401, p);
    }
  });
});

describe("connect -> status -> disconnect happy path", () => {
  it("connects, reports connected status, then disconnects", async () => {
    const res = await fetch(`${base}/sync/drive/connect`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({
        refresh_token: "R", client_id: "C", client_secret: "S", account_email: "a@b.cz",
      }),
    });
    const body = (await res.json()) as { account_email: string; shared_drives: unknown[] };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.account_email, "a@b.cz");
    assert.deepEqual(body.shared_drives, [{ id: "D1", name: "Tym" }]);

    const st = (await (await fetch(`${base}/sync/drive/status`, { headers: auth })).json()) as {
      connected: boolean;
    };
    assert.equal(st.connected, true);

    const dres = await fetch(`${base}/sync/drive/disconnect`, { method: "POST", headers: auth });
    assert.equal(dres.status, 200);
    const dbody = (await dres.json()) as { ok: boolean };
    assert.equal(dbody.ok, true);

    const st2 = (await (await fetch(`${base}/sync/drive/status`, { headers: auth })).json()) as {
      connected: boolean;
    };
    assert.equal(st2.connected, false);
  });
});

describe("validation", () => {
  it("400s connect with a missing field", async () => {
    const res = await fetch(`${base}/sync/drive/connect`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({ refresh_token: "R" }),
    });
    assert.equal(res.status, 400);
  });

  it("400s target when neither shared_drive_id nor my_drive is given", async () => {
    const res = await fetch(`${base}/sync/drive/target`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it("400s target when both shared_drive_id and my_drive are given", async () => {
    const res = await fetch(`${base}/sync/drive/target`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({ shared_drive_id: "D1", my_drive: true }),
    });
    assert.equal(res.status, 400);
  });
});

describe("targets before connect", () => {
  it("409s with not_connected when no token is stored", async () => {
    const res = await fetch(`${base}/sync/drive/targets`, { headers: auth });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "not_connected");
  });
});

describe("target before connect", () => {
  it("409s with not_connected when no token is stored", async () => {
    const res = await fetch(`${base}/sync/drive/target`, {
      method: "POST",
      headers: authJson,
      body: JSON.stringify({ shared_drive_id: "D1" }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "not_connected");
  });
});
