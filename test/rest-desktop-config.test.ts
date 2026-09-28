// GET /auth/desktop-config: public endpoint serving the desktop OAuth client
// (id + secret) so the onboarding wizard can join a central server from just
// its URL. Env-gated, mode-independent, read per request.

process.env.PORT = "14927";
process.env.HOST = "127.0.0.1";
useTestBearer();
delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID;
delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET;

import { authFetch, useTestBearer } from "./helpers/auth.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { openTestDb } from "./helpers/db.js";
import type { DbClient as Client } from "../apps/server/infra/db.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";

const base = "http://127.0.0.1:14927";

let handle: HttpServerHandle;
let db: Client;

before(async () => {
  resetGateCachesForTesting();
  db = await openTestDb();
  await ensureSchemaOn(db);
  setDbForTesting(db);
  handle = startHttpServer({ port: 14927, host: "127.0.0.1", registerSigint: false });
  await new Promise((r) => setImmediate(r));
});

after(async () => {
  await handle.shutdown();
  setDbForTesting(null);
});

describe("GET /auth/desktop-config", () => {
  it("404s when the desktop client env vars are not set", async () => {
    delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID;
    delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET;
    const res = await authFetch(`${base}/auth/desktop-config`);
    assert.equal(res.status, 404);
  });

  it("returns the client id and secret when configured", async () => {
    process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
    process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET = "GOCSPX-test-secret";
    try {
      const res = await authFetch(`${base}/auth/desktop-config`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.google_client_id, "123-abc.apps.googleusercontent.com");
      assert.equal(body.google_client_secret, "GOCSPX-test-secret");
    } finally {
      delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID;
      delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET;
    }
  });

  it("404s again when one of the two vars is missing", async () => {
    process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
    try {
      const res = await authFetch(`${base}/auth/desktop-config`);
      assert.equal(res.status, 404);
    } finally {
      delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID;
    }
  });
});
