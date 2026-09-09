// #272: a `sessions` row must only be created once an MCP connection
// completes a genuine handshake -- never merely because a server/scope pair
// was constructed for it. Verifies the fix end to end over the real HTTP
// transport (createMcpTransport, mounted by startHttpServer): a
// non-initialize first request leaves no row behind, and a real initialize
// creates exactly one, with `cli` populated from clientInfo.
//
// PORTUNI_AUTH_TOKEN must be set before any apps/server module that reads
// it at load time (http/middleware.ts's AUTH_ENABLED) is imported. Static
// `import` bindings are hoisted and their target modules evaluated before
// ANY of this file's own top-level code runs -- even a plain assignment
// written before the import declarations -- so those modules are loaded
// dynamically below, after the env assignment has actually executed. Same
// pattern as agent-mcp-e2e.test.ts.
process.env.PORTUNI_AUTH_TOKEN = "test-token";

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("a non-initialize first request creates no sessions row; a real handshake creates exactly one, with cli set", async (t) => {
  const { startHttpServer } = await import("../apps/server/http/server.js");
  const { ensureSchema } = await import("../apps/server/infra/schema.js");
  const { getDb, setDbForTesting } = await import("../apps/server/infra/db.js");
  const { resetGateCachesForTesting } = await import("../apps/server/http/middleware.js");
  const { listSessions } = await import("../apps/server/domain/sessions.js");

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
