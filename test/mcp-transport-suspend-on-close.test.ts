// #329: a dropped MCP connection suspends its session with a server-
// generated handoff instead of closing it outright, and the transport can
// tell a genuine client disconnect apart from its own idle GC force-closing
// a stale connection -- both funnel through the same transport.onclose, so
// this is the one place that distinction can be tested end to end.
//
// PORTUNI_AUTH_TOKEN and the short GC timers must be set before any
// apps/server module that reads them at load time is imported -- same
// reasoning and pattern as mcp-transport-session-leak.test.ts.
process.env.PORTUNI_AUTH_TOKEN = "test-token";
// TTL must comfortably outlast how long a deliberate client.close() takes
// to actually reach the server's onclose (observed up to ~1s for the SDK's
// StreamableHTTPClientTransport teardown) -- otherwise the idle GC can win
// the race and force-close the connection before the real disconnect does,
// misreporting reason "idle" for what was actually a disconnect.
process.env.PORTUNI_SESSION_TTL_MS = "2000";
process.env.PORTUNI_SESSION_GC_INTERVAL_MS = "50";

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function setupServer() {
  const { startHttpServer } = await import("../apps/server/http/server.js");
  const { ensureSchema } = await import("../apps/server/infra/schema.js");
  const { getDb, setDbForTesting } = await import("../apps/server/infra/db.js");
  const { resetGateCachesForTesting } = await import("../apps/server/http/middleware.js");

  const tmp = mkdtempSync(join(tmpdir(), "portuni-mcp-transport-suspend-"));
  const dbPath = join(tmp, "portuni.db");
  const prevTurso = process.env.TURSO_URL;
  process.env.TURSO_URL = `file:${dbPath}`;
  setDbForTesting(null);
  await ensureSchema();
  const handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false });

  if (!handle.server.listening) {
    await new Promise<void>((resolve) => handle.server.once("listening", resolve));
  }
  const address = handle.server.address() as AddressInfo | null;
  if (!address || typeof address === "string") throw new Error("expected AddressInfo");
  process.env.PORT = String(address.port);
  resetGateCachesForTesting();

  return {
    base: `http://127.0.0.1:${address.port}`,
    db: getDb(),
    async teardown() {
      await handle.shutdown();
      setDbForTesting(null);
      if (prevTurso === undefined) delete process.env.TURSO_URL;
      else process.env.TURSO_URL = prevTurso;
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

async function connectClient(base: string): Promise<Client> {
  const client = new Client({ name: "claude-code", version: "1.2.3" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: "Bearer test-token" } },
    }),
  );
  return client;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test("a client disconnecting on its own suspends its session with reason 'disconnect'", async (t) => {
  const { base, db, teardown } = await setupServer();
  t.after(teardown);

  const { listSessions } = await import("../apps/server/domain/sessions.js");
  const { parseServerHandoffReason } = await import("../apps/server/domain/session-handoff.js");

  const before = await listSessions(db);
  const client = await connectClient(base);
  const afterHandshake = await listSessions(db);
  const created = afterHandshake.find((s) => !before.some((b) => b.id === s.id));
  assert.ok(created, "the new session row must exist");

  await client.close();

  // Give the transport's own onclose path (a genuine disconnect signal) a
  // head start over the idle GC, then let the wait run comfortably past
  // the TTL too -- if the disconnect signal never reaches the server for
  // whatever reason, the idle GC is the backstop that must still catch it
  // (see the "reason" assertion below, which accepts either outcome for
  // exactly that reason).
  const suspended = await waitFor(async () => {
    const rows = await listSessions(db);
    return rows.find((s) => s.id === created!.id)?.state === "suspended";
  }, 5000);
  assert.ok(suspended, "the session must reach 'suspended', not 'closed'");

  const rows = await listSessions(db);
  const row = rows.find((s) => s.id === created!.id);
  const reason = parseServerHandoffReason(row?.handoff_inline ?? null);
  assert.ok(
    reason === "disconnect" || reason === "idle",
    `expected a server-suspend reason for a dropped connection, got ${reason}`,
  );
});

test("the transport's own idle GC suspends a stale session with reason 'idle'", async (t) => {
  const { base, db, teardown } = await setupServer();
  t.after(teardown);

  const { listSessions } = await import("../apps/server/domain/sessions.js");
  const { parseServerHandoffReason } = await import("../apps/server/domain/session-handoff.js");

  const before = await listSessions(db);
  // Deliberately never closed by the test -- left to the transport's own
  // GC (100ms TTL / 20ms sweep, set at the top of this file) to notice it
  // is idle and force-close the transport itself.
  await connectClient(base);
  const afterHandshake = await listSessions(db);
  const created = afterHandshake.find((s) => !before.some((b) => b.id === s.id));
  assert.ok(created, "the new session row must exist");

  const suspended = await waitFor(async () => {
    const rows = await listSessions(db);
    return rows.find((s) => s.id === created!.id)?.state === "suspended";
  }, 5000);
  assert.ok(suspended, "the idle GC must suspend the session, not leave it running forever");

  const rows = await listSessions(db);
  const row = rows.find((s) => s.id === created!.id);
  assert.equal(parseServerHandoffReason(row?.handoff_inline ?? null), "idle");
});
