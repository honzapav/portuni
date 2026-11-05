// GET /changes (client traffic contract, rule 3): what a device asks central
// -- or a window asks its personal-workspace server -- instead of polling
// the nodes it shows. A write to a node the caller can see answers as a
// change; an unknown cursor answers reset; `wait` holds the request until
// the next change.

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
import { resetChangeFeedForTesting } from "../apps/server/infra/change-feed.js";
import { updateNodeInternal } from "../apps/server/domain/nodes.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { ChangesResponse } from "../apps/server/shared/api-types.js";

const SOLO = "01SOLO0000000000000000000";

function identity(scope: RequestIdentity["globalScope"] = "write"): RequestIdentity {
  return { userId: SOLO, email: "solo@x.com", name: "Solo", globalScope: scope, groups: [], groupIds: [], via: "env" };
}

async function call(path: string): Promise<{ statusCode: number; body: string }> {
  const captured = { statusCode: 0, body: "" };
  const req = new Readable({
    read() {
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = "GET";
  req.url = path;
  req.headers = {};
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
  await routeApiRequest(req, res, new URL(`http://localhost${path}`), identity());
  return captured;
}

describe("GET /changes", () => {
  let db: DbClient;
  let projectId: string;

  before(async () => {
    db = await openTestDb();
    await ensureSchemaOn(db);
    setDbForTesting(db);
    resetChangeFeedForTesting();
    projectId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'Proj', 'proj', ?)",
      args: [projectId, SOLO],
    });
  });

  after(() => setDbForTesting(null as unknown as DbClient));

  it("a first read answers reset with a cursor; a node write then answers as a change", async () => {
    const first = await call("/changes");
    assert.equal(first.statusCode, 200);
    const start = JSON.parse(first.body) as ChangesResponse;
    assert.equal(start.reset, true);
    assert.deepEqual(start.changes, []);

    await updateNodeInternal(db, SOLO, { node_id: projectId, name: "Renamed" });
    const next = JSON.parse((await call(`/changes?since=${encodeURIComponent(start.cursor)}`)).body) as ChangesResponse;
    assert.equal(next.reset, false);
    assert.deepEqual(
      next.changes.map((c) => [c.node_id, c.kind]),
      [[projectId, "node"]],
    );
    const nothing = JSON.parse((await call(`/changes?since=${encodeURIComponent(next.cursor)}`)).body) as ChangesResponse;
    assert.deepEqual(nothing.changes, []);
  });

  it("an unknown cursor answers reset", async () => {
    const r = JSON.parse((await call("/changes?since=01NOPE:3")).body) as ChangesResponse;
    assert.equal(r.reset, true);
  });

  it("wait holds the request until the next change", async () => {
    const start = JSON.parse((await call("/changes")).body) as ChangesResponse;
    const pending = call(`/changes?since=${encodeURIComponent(start.cursor)}&wait=5`);
    setTimeout(() => void updateNodeInternal(db, SOLO, { node_id: projectId, name: "Again" }), 20);
    const r = JSON.parse((await pending).body) as ChangesResponse;
    assert.equal(r.changes.length, 1);
    assert.equal(r.changes[0].node_id, projectId);
  });

  it("refuses a wait beyond the cap", async () => {
    assert.equal((await call("/changes?wait=120")).statusCode, 400);
  });
});
