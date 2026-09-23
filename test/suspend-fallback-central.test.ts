// #434: the sync agent's suspend fallback on a node this device has no
// mirror for -- the summary itself has to survive, or the thread resumes
// from nothing. #456 moved that summary off the record and into this
// device's content.db, so these tests drive the real fallback against a
// fake central server (a CentralClient whose record methods go through the
// central server's own REST handlers, routeApiRequest, on a test db) plus a
// real content store, and then read the handoff back the way a resume does.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { openTestDb } from "./helpers/db.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting, type DbClient } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import { createSession } from "../apps/server/domain/sessions.js";
import { createSuspendFallbackCentral } from "../apps/server/domain/runner/suspend-fallback-central.js";
import { CentralSessionStore } from "../apps/server/domain/runner/store-central.js";
import { installTestContentDb } from "./helpers/content-db.js";
import type { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
import { sha256Buffer } from "../apps/server/domain/sync/hash.js";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { SessionRow } from "../apps/server/shared/types.js";
import type { SessionResumeInfo } from "../apps/server/shared/api-types.js";

const SOLO = "01SOLO0000000000000000000";

function makeIdentity(): RequestIdentity {
  return {
    userId: SOLO,
    email: "solo@x.com",
    name: "Solo",
    globalScope: "admin",
    groups: [],
    groupIds: [],
    via: "env",
  };
}

interface MockResponse {
  statusCode: number;
  body: string;
}

// Same lightweight req/res pair test/api-sessions.test.ts uses.
async function call(method: string, path: string, body?: unknown): Promise<MockResponse> {
  const captured: MockResponse = { statusCode: 0, body: "" };
  const bodyStr = body !== undefined ? JSON.stringify(body) : "";
  const req = new Readable({
    read() {
      if (bodyStr) this.push(Buffer.from(bodyStr));
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = body !== undefined ? { "content-type": "application/json" } : {};

  const res = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      captured.body += chunk.toString();
      cb();
    },
  }) as unknown as ServerResponse;
  (res as unknown as { writeHead: (code: number) => void }).writeHead = (code: number) => {
    captured.statusCode = code;
  };
  (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
    if (data) captured.body += data;
  };

  await routeApiRequest(req, res, new URL(`http://localhost${path}`), makeIdentity());
  return captured;
}

describe("central suspend fallback without a mirror (#434)", () => {
  let db: DbClient;
  let workspace: string;
  let nodeId: string;
  let client: CentralClient;
  let content: SessionContentStore;

  before(async () => {
    // No mirror is ever registered under this root, so getMirrorPath
    // answers null for the node -- the branch under test.
    workspace = await mkdtemp(join(tmpdir(), "portuni-suspend-fallback-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await openTestDb();
    await ensureSchemaOn(db);
    setDbForTesting(db);

    nodeId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'Proj', 'proj', ?)",
      args: [nodeId, SOLO],
    });

    content = (await installTestContentDb()).content;

    // The fake central server: only the record methods the fallback and
    // CentralSessionStore reach for, each one going through the central
    // server's real handler (the record write is the point of the test).
    // #456: there is no event method to fake at all -- the transcript is
    // read from the device's own content store.
    client = {
      getSessionRecord: async (id: string) => {
        const r = await call("GET", `/sessions/${id}`);
        return r.statusCode === 200 ? (JSON.parse(r.body) as SessionRow) : null;
      },
      patchSessionRecord: async (id: string, patch: unknown) => {
        const r = await call("PATCH", `/sessions/${id}`, patch);
        assert.equal(r.statusCode, 200, `PATCH /sessions/${id} answered ${r.statusCode}: ${r.body}`);
        return JSON.parse(r.body) as SessionRow;
      },
      appendSessionEvents: () => {
        throw new Error("the central server must never receive session events (#456)");
      },
      listSessionEvents: () => {
        throw new Error("the central server must never be asked for session events (#456)");
      },
      sessionScopeRecord: async (sessionId: string) => {
        const r = await call("GET", `/sessions/${sessionId}/scope`);
        assert.equal(r.statusCode, 200);
        return JSON.parse(r.body);
      },
    } as unknown as CentralClient;
  });

  after(async () => {
    resetLocalDbForTests();
    delete process.env.PORTUNI_WORKSPACE_ROOT;
    await rm(workspace, { recursive: true, force: true });
  });

  test("suspends with the summary in the device content store and a hash that matches it", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    await content.appendEvents(session.id, null, [
      { kind: "user_message", payload: { text: "Oprav ten test", source: "chat" } },
      { kind: "assistant_message", payload: { text: "Hotovo, zbývá dokumentace." } },
    ]);

    const fallback = createSuspendFallbackCentral(new CentralSessionStore(client), content, client);
    const suspended = await fallback(session.id, "idle");

    assert.equal(suspended?.state, "suspended");
    assert.equal(suspended?.handoff_path, null, "no mirror here, so there is no handoff file to point at");
    assert.equal(suspended?.handoff_inline, null, "the central record never carries the summary (#456)");
    const inline = (await content.getContent(session.id))?.handoff_inline ?? null;
    assert.ok(inline && inline.length > 0, "the summary itself is stored on the device");
    assert.match(inline!, /Oprav ten test/);
    assert.equal(
      suspended?.handoff_hash,
      sha256Buffer(Buffer.from(inline!, "utf8")),
      "handoff_hash is the hash of the content that was stored",
    );
  });

  test("the stored handoff is what a resume reads back", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const fallback = createSuspendFallbackCentral(new CentralSessionStore(client), content, client);
    await fallback(session.id, "disconnect");

    const res = await call("GET", `/sessions/${session.id}/resume-info`);
    assert.equal(res.statusCode, 200);
    const info = JSON.parse(res.body) as SessionResumeInfo;
    assert.equal(info.handoff_path, null);
    // Both of these are read off the handoff's own content: without the
    // device's inline summary getResumeInfo would have nothing to parse.
    assert.equal(info.generated_by, "server");
    assert.equal(info.reason, "disconnect");
  });
});
