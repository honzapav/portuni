// MCP handshake binding (runner batch, Rule 2 "The session exists before
// the runner"): a fresh connection whose X-Portuni-Spawn-Id names a
// `running` session row owned by the connecting identity binds to that row
// instead of creating a second one; a row that is not running or not owned
// is refused (SESSION_BIND_REFUSED); no row at all keeps today's
// create-with-preassigned-id behaviour. Same server/client harness as
// test/mcp-transport-suspend-on-close.test.ts.
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
import { ensureSchema, SOLO_USER } from "../apps/server/infra/schema.js";
import { getDb, setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { createSession, getSession, listSessions, transitionSessionState } from "../apps/server/domain/sessions.js";
import { ulid } from "ulid";

// A suspend on disconnect writes content: into memory, not a content.db
// in the repo root.
before(async () => {
  await installTestContentDb();
});

async function setupServer() {

  const tmp = mkdtempSync(join(tmpdir(), "portuni-mcp-transport-bind-"));
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
    soloUser: SOLO_USER,
    async teardown() {
      await handle.shutdown();
      setDbForTesting(null);
      if (prevTurso === undefined) delete process.env.TURSO_URL;
      else process.env.TURSO_URL = prevTurso;
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test("a running, owned session row is bound to instead of creating a second one", async (t) => {
  const { base, db, soloUser, teardown } = await setupServer();
  t.after(teardown);


  const row = await createSession(db, soloUser, { node_id: null, session_type: "interactive_task" });
  const before = await listSessions(db);

  const client = new Client({ name: "claude-code", version: "1.2.3" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: "Bearer test-token", "x-portuni-spawn-id": row.id } },
    }),
  );

  const after = await listSessions(db);
  assert.equal(after.length, before.length, "no second row must be created");

  const bound = await getSession(db, row.id);
  assert.equal(bound?.cli, "claude", "the handshake's own clientInfo.name must fill in cli");

  await client.close();
});

test("a spawn id naming a suspended row is refused with SESSION_BIND_REFUSED", async (t) => {
  const { base, db, soloUser, teardown } = await setupServer();
  t.after(teardown);


  const row = await createSession(db, soloUser, { node_id: null, session_type: "interactive_task" });
  await transitionSessionState(db, soloUser, row.id, "suspended");

  await assert.rejects(async () => {
    const client = new Client({ name: "claude-code", version: "1.2.3" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer test-token", "x-portuni-spawn-id": row.id } },
      }),
    );
  });
});

test("a spawn id with no matching row falls back to creating one under that id (today's behaviour)", async (t) => {
  const { base, teardown } = await setupServer();
  t.after(teardown);

  const freshId = ulid();

  const client = new Client({ name: "claude-code", version: "1.2.3" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: "Bearer test-token", "x-portuni-spawn-id": freshId } },
    }),
  );

  const row = await getSession((await import("../apps/server/infra/db.js")).getDb(), freshId);
  assert.ok(row, "a fresh row must be created under the relayed spawn id");
  assert.equal(row?.id, freshId);

  await client.close();
});
