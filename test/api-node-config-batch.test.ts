// POST /nodes/config-batch (client traffic contract, rule 6): the sync
// agent's boot used to read two central routes per mirror to write each
// mirror's harness config; one request now carries every visible node's
// orientation and data sources.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { openTestDb } from "./helpers/db.js";
import type { DbClient } from "../apps/server/infra/db.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import { addDataSource } from "../apps/server/domain/entity-attributes.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { NodeConfigBatchResponse } from "../apps/server/shared/api-types.js";

const SOLO = "01SOLO0000000000000000000";

function makeIdentity(scope: RequestIdentity["globalScope"] = "write"): RequestIdentity {
  return { userId: SOLO, email: "solo@x.com", name: "Solo", globalScope: scope, groups: [], groupIds: [], via: "env" };
}

async function call(method: string, path: string, body?: unknown): Promise<{ statusCode: number; body: string }> {
  const captured = { statusCode: 0, body: "" };
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
  (res as unknown as { writeHead: (code: number) => void }).writeHead = (code) => {
    captured.statusCode = code;
  };
  (res as unknown as { end: (data?: string) => void }).end = (data) => {
    if (data) captured.body += data;
  };
  await routeApiRequest(req, res, new URL(`http://localhost${path}`), makeIdentity());
  return captured;
}

describe("POST /nodes/config-batch", () => {
  let db: DbClient;
  let orgId: string;
  let projectId: string;

  before(async () => {
    db = await openTestDb();
    await ensureSchemaOn(db);
    setDbForTesting(db);
    orgId = ulid();
    projectId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'organization', 'Org', 'org', ?)",
      args: [orgId, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'Proj', 'proj', ?)",
      args: [projectId, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), projectId, orgId, SOLO],
    });
    await addDataSource(db, SOLO, { node_id: projectId, name: "CRM", kind: "database" } as Parameters<typeof addDataSource>[2]);
  });

  after(() => setDbForTesting(null as unknown as DbClient));

  it("answers every known node's orientation and data sources in one request; unknown ids are left out", async () => {
    const res = await call("POST", "/nodes/config-batch", { node_ids: [projectId, "01NOPE0000000000000000000", orgId] });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as NodeConfigBatchResponse;
    assert.deepEqual(body.configs.map((c) => c.node_id), [projectId, orgId]);
    const project = body.configs[0];
    assert.equal(project.orientation?.node.name, "Proj");
    assert.equal(project.data_sources.length, 1);
    assert.equal(project.data_sources[0].name, "CRM");
    assert.equal(body.configs[1].data_sources.length, 0);
  });

  it("refuses an empty or oversized batch", async () => {
    assert.equal((await call("POST", "/nodes/config-batch", {})).statusCode, 400);
    assert.equal((await call("POST", "/nodes/config-batch", { node_ids: [] })).statusCode, 400);
    const many = Array.from({ length: 501 }, (_, i) => `01ID${String(i).padStart(21, "0")}`);
    assert.equal((await call("POST", "/nodes/config-batch", { node_ids: many })).statusCode, 400);
  });
});
