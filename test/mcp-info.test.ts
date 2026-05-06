// Verifies GET /mcp/info reports endpoint metadata for the Settings UI
// without requiring auth, even when AUTH_ENABLED is true. The token must
// not appear in the response body — only a flag indicating one is set.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startHttpServer } from "../src/http/server.js";
import { ensureSchema } from "../src/infra/schema.js";
import { setDbForTesting } from "../src/infra/db.js";
import { resetGateCachesForTesting } from "../src/http/middleware.js";

test("GET /mcp/info returns endpoint metadata without auth", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "portuni-mcp-info-"));
  const dbPath = join(tmp, "portuni.db");
  const prevTurso = process.env.TURSO_URL;
  const prevAuth = process.env.PORTUNI_AUTH_TOKEN;
  process.env.TURSO_URL = `file:${dbPath}`;
  process.env.PORTUNI_AUTH_TOKEN = "secret-token-do-not-leak";
  setDbForTesting(null);

  await ensureSchema();
  const handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false });

  t.after(async () => {
    await handle.shutdown();
    setDbForTesting(null);
    if (prevTurso === undefined) delete process.env.TURSO_URL;
    else process.env.TURSO_URL = prevTurso;
    if (prevAuth === undefined) delete process.env.PORTUNI_AUTH_TOKEN;
    else process.env.PORTUNI_AUTH_TOKEN = prevAuth;
    rmSync(tmp, { recursive: true, force: true });
  });

  if (!handle.server.listening) {
    await new Promise<void>((resolve) => handle.server.once("listening", resolve));
  }
  const address = handle.server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    throw new Error("expected AddressInfo from server");
  }
  process.env.PORT = String(address.port);
  resetGateCachesForTesting();

  // No Authorization header — endpoint must still answer 200.
  const res = await fetch(`http://127.0.0.1:${address.port}/mcp/info`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    url: string;
    port: number;
    has_auth_token: boolean;
  };
  assert.equal(body.port, address.port);
  assert.equal(body.has_auth_token, true);
  assert.match(body.url, /\/mcp$/);
  assert.equal(
    JSON.stringify(body).includes("secret-token-do-not-leak"),
    false,
    "token must not leak through /mcp/info",
  );
});
