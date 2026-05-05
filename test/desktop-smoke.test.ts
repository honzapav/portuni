// Smoke test for desktop mode: backend boots end-to-end with a file-backed
// libSQL URL and no Turso auth, exercising the same startHttpServer +
// ensureSchema path the Tauri sidecar will run.

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

test("backend runs end-to-end with file: libSQL URL", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "portuni-desktop-"));
  const dbPath = join(tmp, "portuni.db");
  const prevTurso = process.env.TURSO_URL;
  const prevTursoToken = process.env.TURSO_AUTH_TOKEN;
  const prevAuth = process.env.PORTUNI_AUTH_TOKEN;
  process.env.TURSO_URL = `file:${dbPath}`;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.PORTUNI_AUTH_TOKEN;
  setDbForTesting(null);

  await ensureSchema();
  const handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false });

  t.after(async () => {
    await handle.shutdown();
    setDbForTesting(null);
    if (prevTurso === undefined) delete process.env.TURSO_URL;
    else process.env.TURSO_URL = prevTurso;
    if (prevTursoToken !== undefined) process.env.TURSO_AUTH_TOKEN = prevTursoToken;
    if (prevAuth !== undefined) process.env.PORTUNI_AUTH_TOKEN = prevAuth;
    rmSync(tmp, { recursive: true, force: true });
  });

  if (!handle.server.listening) {
    await new Promise<void>((resolve) => handle.server.once("listening", resolve));
  }
  const address = handle.server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    throw new Error("expected AddressInfo from server");
  }
  // Allowed hosts are built lazily from PORT env; align them with the
  // OS-assigned port we just bound, then reset caches.
  process.env.PORT = String(address.port);
  resetGateCachesForTesting();
  const res = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "ok");
});
