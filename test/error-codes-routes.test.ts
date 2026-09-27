// Route errors carry a stable code (#531): every 4xx the graph, file,
// access and runner routes answer is `{ error, code, params? }`, with
// `error` English for logs and `params` data only. A few representative
// routes, driven through routeApiRequest with a mock req/res.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { openTestDb } from "./helpers/db.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting, type DbClient } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import { isErrorCode } from "../apps/server/shared/error-codes.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

const SOLO = "01SOLO0000000000000000000";

const identity: RequestIdentity = {
  userId: SOLO,
  email: "solo@x.com",
  name: "Solo",
  globalScope: "admin",
  groups: [],
  groupIds: [],
  via: "env",
};

interface Captured {
  statusCode: number;
  body: string;
}

// `rawBody` is sent as-is (a string) so a test can send malformed JSON.
async function call(method: string, path: string, rawBody?: string): Promise<Captured> {
  const captured: Captured = { statusCode: 0, body: "" };
  const req = new Readable({
    read() {
      if (rawBody !== undefined) this.push(Buffer.from(rawBody));
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = rawBody !== undefined ? { "content-type": "application/json" } : {};
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
  await routeApiRequest(req, res, new URL(`http://localhost${path}`), identity);
  return captured;
}

function errorBody(r: Captured): { error: string; code: string; params?: Record<string, unknown> } {
  const body = JSON.parse(r.body) as { error: string; code: string; params?: Record<string, unknown> };
  assert.equal(typeof body.error, "string");
  assert.ok(isErrorCode(body.code), `unknown code ${body.code}`);
  return body;
}

describe("route error codes", () => {
  let db: DbClient;
  let workspace: string;
  let dataDir: string;
  let projectId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-error-codes-ws-"));
    dataDir = await mkdtemp(join(tmpdir(), "portuni-error-codes-data-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    process.env.PORTUNI_DATA_DIR = dataDir;
    resetLocalDbForTests();
    db = await openTestDb();
    await ensureSchemaOn(db);
    setDbForTesting(db);
    const orgId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'organization', 'Org', ?, ?)",
      args: [orgId, `org-${orgId}`, SOLO],
    });
    projectId = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
            VALUES (?, 'project', 'Project', 'active', 'team', ?, ?)`,
      args: [projectId, `proj-${projectId}`, SOLO],
    });
    await db.execute({
      sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by)
            VALUES (?, ?, ?, 'belongs_to', ?)`,
      args: [ulid(), projectId, orgId, SOLO],
    });
  });

  after(async () => {
    setDbForTesting(null);
    resetLocalDbForTests();
    delete process.env.PORTUNI_DATA_DIR;
    await rm(workspace, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an unknown node is 404 NODE_NOT_FOUND with the id as a param", async () => {
    const missing = ulid();
    const r = await call("GET", `/nodes/${missing}`);
    assert.equal(r.statusCode, 404);
    const body = errorBody(r);
    assert.equal(body.code, "NODE_NOT_FOUND");
    assert.deepEqual(body.params, { nodeId: missing });
  });

  test("a malformed JSON body is 400 INVALID_JSON", async () => {
    const r = await call("POST", "/nodes", "{not json");
    assert.equal(r.statusCode, 400);
    assert.equal(errorBody(r).code, "INVALID_JSON");
  });

  test("an invalid visibility is 400 INVALID_VISIBILITY with the value as a param", async () => {
    const r = await call("PATCH", `/nodes/${projectId}`, JSON.stringify({ visibility: "bogus" }));
    assert.equal(r.statusCode, 400);
    const body = errorBody(r);
    assert.equal(body.code, "INVALID_VISIBILITY");
    assert.equal(body.params?.visibility, "bogus");
  });

  test("an unknown edge is 404 EDGE_NOT_FOUND", async () => {
    const r = await call("DELETE", `/edges/${ulid()}`);
    assert.equal(r.statusCode, 404);
    assert.equal(errorBody(r).code, "EDGE_NOT_FOUND");
  });

  test("an unknown event is 404 EVENT_NOT_FOUND", async () => {
    const r = await call("DELETE", `/events/${ulid()}`);
    assert.equal(r.statusCode, 404);
    assert.equal(errorBody(r).code, "EVENT_NOT_FOUND");
  });

  test("a PORTUNI_* instance env key is 400 INSTANCE_ENV_KEY_RESERVED with the key", async () => {
    const r = await call(
      "POST",
      "/runners/instances",
      JSON.stringify({ name: "Bad", runner: "claude", env: { PORTUNI_WORKSPACE_ROOT: "/x" } }),
    );
    assert.equal(r.statusCode, 400);
    const body = errorBody(r);
    assert.equal(body.code, "INSTANCE_ENV_KEY_RESERVED");
    assert.deepEqual(body.params, { key: "PORTUNI_WORKSPACE_ROOT" });
    assert.match(body.error, /PORTUNI_WORKSPACE_ROOT/);
  });

  test("an unknown runner instance is 404 INSTANCE_NOT_FOUND", async () => {
    const r = await call("DELETE", "/runners/instances/nope");
    assert.equal(r.statusCode, 404);
    const body = errorBody(r);
    assert.equal(body.code, "INSTANCE_NOT_FOUND");
    assert.deepEqual(body.params, { instanceId: "nope" });
  });
});
