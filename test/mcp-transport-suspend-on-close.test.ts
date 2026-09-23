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
  // #456: the suspend's summary is content and lands in this device's
  // content.db, so the test needs one installed before the server runs.
  const { installTestContentDb, clearTestContentDb } = await import("./helpers/content-db.js");
  const { content } = await installTestContentDb();

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
    content,
    async teardown() {
      await handle.shutdown();
      setDbForTesting(null);
      clearTestContentDb();
      if (prevTurso === undefined) delete process.env.TURSO_URL;
      else process.env.TURSO_URL = prevTurso;
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

async function connectClient(base: string, spawnSessionId?: string): Promise<Client> {
  const client = new Client({ name: "claude-code", version: "1.2.3" });
  const headers: Record<string, string> = { authorization: "Bearer test-token" };
  // What a run's own MCP connection carries (RunStart.mcp.headers): the id
  // of the row the session runtime created before the runner started.
  if (spawnSessionId) headers["X-Portuni-Spawn-Id"] = spawnSessionId;
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }),
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
  const { base, db, content, teardown } = await setupServer();
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

  const reason = parseServerHandoffReason((await content.getContent(created!.id))?.handoff_inline ?? null);
  assert.ok(
    reason === "disconnect" || reason === "idle",
    `expected a server-suspend reason for a dropped connection, got ${reason}`,
  );
});

test("the transport's own idle GC suspends a stale session with reason 'idle'", async (t) => {
  const { base, db, content, teardown } = await setupServer();
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

  assert.equal(parseServerHandoffReason((await content.getContent(created!.id))?.handoff_inline ?? null), "idle");
});

// #487: the same two close paths on a thread the RUNNER drives -- its agent
// process is alive and its run is open, so neither a dropped connection nor
// the idle GC may end it, and the agent's MCP client must be able to
// reconnect to the very same thread afterwards (which a suspended row
// refuses with SESSION_BIND_REFUSED).
test("a runner-driven thread survives its MCP connection closing, and the agent reconnects to it", async (t) => {
  const { base, db, content, teardown } = await setupServer();
  t.after(teardown);

  const { createSession, getSession, listSessions } = await import("../apps/server/domain/sessions.js");
  const { SOLO_USER } = await import("../apps/server/infra/schema.js");
  const { ulid } = await import("ulid");

  // The row exists before the runner (Rule 2), with a run the runtime holds.
  const task = await createSession(db, SOLO_USER, {
    node_id: null,
    session_type: "interactive_task",
    runner: "claude",
    host_id: "this-device",
  });
  const runId = ulid();
  await db.execute({
    sql: `INSERT INTO session_runs (id, session_id, runner, instance_id, host_id, started_at)
          VALUES (?, ?, 'claude', NULL, 'this-device', ?)`,
    args: [runId, task.id, new Date().toISOString()],
  });

  const agent = await connectClient(base, task.id);
  // A hand-opened CLI alongside it: its own suspend is this test's signal
  // that the server has finished processing BOTH closes -- it connects
  // second and is closed second, so by the time its row is suspended the
  // task's onclose has long since run. Nothing here waits a fixed time.
  const before = await listSessions(db);
  const cli = await connectClient(base);
  const cliRow = (await listSessions(db)).find((s) => !before.some((b) => b.id === s.id));
  assert.ok(cliRow, "the hand-opened CLI's own session row must exist");

  await agent.close();
  await cli.close();

  const cliSuspended = await waitFor(async () => {
    const rows = await listSessions(db);
    return rows.find((s) => s.id === cliRow.id)?.state === "suspended";
  }, 5000);
  assert.ok(cliSuspended, "a hand-opened CLI still suspends when its connection goes");

  const after = await getSession(db, task.id);
  assert.equal(after?.state, "running", "the runner's thread is untouched by its connection closing");
  assert.equal(after?.handoff_hash, null);
  const run = await db.execute({ sql: "SELECT ended_at FROM session_runs WHERE id = ?", args: [runId] });
  assert.equal(run.rows[0]?.ended_at, null, "the run stays open");
  assert.deepEqual(
    (await content.listEvents(task.id)).map((e) => e.kind),
    [],
    "no run_ended and no state_changed reached the log",
  );

  // The agent reconnects with the same X-Portuni-Spawn-Id: it must bind to
  // the same row, not be refused with SESSION_BIND_REFUSED.
  const reconnected = await connectClient(base, task.id);
  t.after(() => reconnected.close());
  const tools = await reconnected.listTools();
  assert.ok(tools.tools.length > 0, "the reconnected agent has its Portuni tools back");
  assert.equal((await getSession(db, task.id))?.state, "running");
});
