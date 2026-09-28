// #272: a `sessions` row must only be created once an MCP connection
// completes a genuine handshake -- never merely because a server/scope pair
// was constructed for it. Verifies the fix end to end over the real HTTP
// transport (createMcpTransport, mounted by startHttpServer): a
// non-initialize first request leaves no row behind, and a real initialize
// creates exactly one, with `cli` populated from clientInfo.
//
// The server reads the bearer live (#521); it only has to be set before
// the server starts.
process.env.PORTUNI_AUTH_TOKEN = "test-token";

import { before, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { installTestContentDb } from "./helpers/content-db.js";
import { startHttpServer } from "../apps/server/http/server.js";
import { ensureSchema } from "../apps/server/infra/schema.js";
import { getDb, setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { listSessions } from "../apps/server/domain/sessions.js";

// A suspend on disconnect writes content: into memory, not a content.db
// in the repo root.
before(async () => {
  await installTestContentDb();
});

test("a non-initialize first request creates no sessions row; a real handshake creates exactly one, with cli set", async (t) => {

  const tmp = mkdtempSync(join(tmpdir(), "portuni-mcp-transport-leak-"));
  const dbPath = join(tmp, "portuni.db");
  const prevTurso = process.env.TURSO_URL;
  process.env.TURSO_URL = `file:${dbPath}`;
  setDbForTesting(null);
  await ensureSchema();
  const handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false });

  t.after(async () => {
    await handle.shutdown();
    setDbForTesting(null);
    if (prevTurso === undefined) delete process.env.TURSO_URL;
    else process.env.TURSO_URL = prevTurso;
    rmSync(tmp, { recursive: true, force: true });
  });

  if (!handle.server.listening) {
    await new Promise<void>((resolve) => handle.server.once("listening", resolve));
  }
  const address = handle.server.address() as AddressInfo | null;
  if (!address || typeof address === "string") throw new Error("expected AddressInfo");
  process.env.PORT = String(address.port);
  resetGateCachesForTesting();
  const base = `http://127.0.0.1:${address.port}`;

  const db = getDb();
  const before = await listSessions(db);

  // The exact repro from #272: a well-formed JSON-RPC request that is NOT
  // an `initialize`. The server rejects it ("Server not initialized"), and
  // must never have inserted a session row for it.
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 400);
  await res.body?.cancel();

  const afterProbe = await listSessions(db);
  assert.equal(afterProbe.length, before.length, "a non-initialize first request must not create a row");

  // A real handshake, via the SDK client, does create exactly one row.
  const client = new Client({ name: "claude-code", version: "1.2.3" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: "Bearer test-token" } },
    }),
  );
  try {
    const afterHandshake = await listSessions(db);
    assert.equal(afterHandshake.length, before.length + 1);
    const created = afterHandshake.find((s) => !before.some((b) => b.id === s.id));
    assert.ok(created, "the new session row must exist");
    assert.equal(created?.cli, "claude");
  } finally {
    await client.close().catch(() => undefined);
  }
});
