// REST tests for the node-detail sessions endpoints (#192): GET
// /nodes/:id/sessions, PATCH /sessions/:id, POST /sessions/:id/state, GET
// /sessions/:id/resume-info. Same methodology as api-access-requests.test.ts:
// routeApiRequest with a lightweight mock req/res and RequestIdentity
// objects constructed directly.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { ulid } from "ulid";
import { createClient as createDbClient, type Client as DbClient } from "@libsql/client";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import { createSession } from "../apps/server/domain/sessions.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { SessionSummary, SessionResumeInfo } from "../apps/server/shared/api-types.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const SOLO = "01SOLO0000000000000000000";

function makeIdentity(userId: string, scope: RequestIdentity["globalScope"] = "write"): RequestIdentity {
  return {
    userId,
    email: `${userId.toLowerCase()}@x.com`,
    name: userId,
    globalScope: scope,
    groups: [],
    groupIds: [],
    via: "env",
  };
}

interface MockResponse {
  statusCode: number;
  body: string;
}

function makeMockReqRes(
  method: string,
  pathname: string,
  bodyJson?: unknown,
): { req: IncomingMessage; res: ServerResponse; captured: MockResponse } {
  const captured: MockResponse = { statusCode: 0, body: "" };
  const bodyStr = bodyJson !== undefined ? JSON.stringify(bodyJson) : "";
  const req = new Readable({
    read() {
      if (bodyStr) this.push(Buffer.from(bodyStr));
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = method;
  req.url = pathname;
  req.headers = bodyJson !== undefined ? { "content-type": "application/json" } : {};

  const res = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      captured.body += chunk.toString();
      cb();
    },
  }) as unknown as ServerResponse;
  (res as unknown as { writeHead: (code: number, hdrs?: Record<string, string>) => void }).writeHead =
    (code: number) => {
      captured.statusCode = code;
    };
  (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
    if (data) captured.body += data;
  };

  return { req, res, captured };
}

async function call(
  identity: RequestIdentity,
  method: string,
  path: string,
  body?: unknown,
): Promise<MockResponse> {
  const { req, res, captured } = makeMockReqRes(method, path, body);
  await routeApiRequest(req, res, new URL(`http://localhost${path}`), identity);
  return captured;
}

describe("session REST endpoints", () => {
  let db: DbClient;
  let workspace: string;
  let nodeId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-api-sessions-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = createDbClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    setDbForTesting(db);

    const orgId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'organization', 'Org', 'org', ?)",
      args: [orgId, SOLO],
    });
    nodeId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'Proj', 'proj', ?)",
      args: [nodeId, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), nodeId, orgId, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
      args: ["U2", "u2@x.com", "U2"],
    });
  });

  after(async () => {
    resetLocalDbForTests();
    delete process.env.PORTUNI_WORKSPACE_ROOT;
    await rm(workspace, { recursive: true, force: true });
  });

  test("GET /nodes/:id/sessions lists sessions for the node, newest-active first, archived excluded by default", async () => {
    const identity = makeIdentity(SOLO);
    const s1 = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const s2 = await createSession(db, SOLO, { node_id: nodeId, session_type: "headless" });
    await db.execute({ sql: "UPDATE sessions SET state = 'archived' WHERE id = ?", args: [s2.id] });

    const res = await call(identity, "GET", `/nodes/${nodeId}/sessions`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { sessions: SessionSummary[] };
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].id, s1.id);
    assert.equal(body.sessions[0].name, s1.name);
    assert.equal(body.sessions[0].write_count, 0);

    const withArchived = await call(identity, "GET", `/nodes/${nodeId}/sessions?include_archived=1`);
    const bodyAll = JSON.parse(withArchived.body) as { sessions: SessionSummary[] };
    assert.equal(bodyAll.sessions.length, 2);
  });

  test("GET /nodes/:id/sessions 404s for an unknown node", async () => {
    const res = await call(makeIdentity(SOLO), "GET", `/nodes/${ulid()}/sessions`);
    assert.equal(res.statusCode, 404);
  });

  test("PATCH /sessions/:id renames a session the caller owns", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity(SOLO), "PATCH", `/sessions/${session.id}`, { name: "Renamed" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as SessionSummary;
    assert.equal(body.name, "Renamed");
    assert.equal(body.name_is_custom, true);
  });

  test("PATCH /sessions/:id 404s for a session owned by someone else", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2"), "PATCH", `/sessions/${session.id}`, { name: "Nope" });
    assert.equal(res.statusCode, 404);
  });

  test("PATCH /sessions/:id rejects an empty name", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity(SOLO), "PATCH", `/sessions/${session.id}`, { name: "  " });
    assert.equal(res.statusCode, 400);
  });

  test("POST /sessions/:id/state transitions a session the caller owns", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity(SOLO), "POST", `/sessions/${session.id}/state`, { state: "closed" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as SessionSummary;
    assert.equal(body.state, "closed");
  });

  test("POST /sessions/:id/state 409s on an invalid transition", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity(SOLO), "POST", `/sessions/${session.id}/state`, { state: "archived" });
    assert.equal(res.statusCode, 409);
  });

  test("POST /sessions/:id/state 404s for a session owned by someone else", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2"), "POST", `/sessions/${session.id}/state`, { state: "closed" });
    assert.equal(res.statusCode, 404);
  });

  test("GET /sessions/:id/resume-info reports conversationResumable false with no mirror on this machine", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity(SOLO), "GET", `/sessions/${session.id}/resume-info`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as SessionResumeInfo;
    assert.equal(body.session_id, session.id);
    assert.equal(body.conversation_resumable, false);
  });

  test("GET /sessions/:id/resume-info 404s for a session owned by someone else", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2"), "GET", `/sessions/${session.id}/resume-info`);
    assert.equal(res.statusCode, 404);
  });
});
