// REST tests for the runner registry endpoints (#319): GET /runners,
// GET/POST/PATCH/DELETE /runners/instances, PUT
// /runners/instances/:id/org-default. Same methodology as
// api-sessions.test.ts: routeApiRequest with a lightweight mock req/res.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { routeApiRequest } from "../apps/server/api/router.js";
import { registerAdapter, clearRegistryForTests } from "../apps/server/domain/runner/registry.js";
import { FakeRunnerAdapter } from "../apps/server/domain/runner/adapters/fake.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { RunnerInfo, RunnerInstanceSummary, RunnerModel } from "../apps/server/shared/api-types.js";
import type { IncomingMessage, ServerResponse } from "node:http";

function makeIdentity(scope: RequestIdentity["globalScope"]): RequestIdentity {
  return {
    userId: "U1",
    email: "u1@x.com",
    name: "U1",
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

describe("runner registry REST endpoints", () => {
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "portuni-api-runners-"));
    process.env.PORTUNI_DATA_DIR = dataDir;
  });

  after(async () => {
    delete process.env.PORTUNI_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearRegistryForTests();
  });

  test("GET /runners reports the registered fake adapter's availability", async () => {
    registerAdapter(new FakeRunnerAdapter({ script: [] }));
    const res = await call(makeIdentity("read"), "GET", "/runners");
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { runners: RunnerInfo[] };
    assert.equal(body.runners.length, 1);
    assert.equal(body.runners[0].id, "fake");
    assert.equal(body.runners[0].availability.installed, true);
    assert.equal(body.runners[0].availability.logged_in, true);
  });

  // #376: the model picker's list.
  test("GET /runners/:runner/models returns the fake adapter's models list", async () => {
    registerAdapter(
      new FakeRunnerAdapter({
        script: [],
        models: [{ id: "m1", displayName: "Model One", description: "d", supportsEffort: true, effortLevels: ["low", "high"] }],
      }),
    );
    const res = await call(makeIdentity("read"), "GET", "/runners/fake/models");
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { models: RunnerModel[] };
    assert.deepEqual(body.models, [
      { id: "m1", displayName: "Model One", description: "d", supportsEffort: true, effortLevels: ["low", "high"] },
    ]);
  });

  test("GET /runners/:runner/models 404s for an unregistered runner", async () => {
    const res = await call(makeIdentity("read"), "GET", "/runners/nonexistent/models");
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).code, "UNKNOWN_RUNNER");
  });

  test("POST /runners/instances creates, GET /runners/instances lists it without env values", async () => {
    const createRes = await call(makeIdentity("write"), "POST", "/runners/instances", {
      name: "Work",
      runner: "claude",
      env: { CLAUDE_CONFIG_DIR: "/x/.claude" },
    });
    assert.equal(createRes.statusCode, 201);
    const created = JSON.parse(createRes.body) as RunnerInstanceSummary;
    assert.equal(created.name, "Work");
    assert.deepEqual(created.env_keys, ["CLAUDE_CONFIG_DIR"]);

    const listRes = await call(makeIdentity("read"), "GET", "/runners/instances");
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body) as { instances: RunnerInstanceSummary[] };
    const row = body.instances.find((i) => i.id === created.id);
    assert.ok(row);
    assert.equal(JSON.stringify(row).includes("/x/.claude"), false);
  });

  test("POST /runners/instances with a secret-shaped env key is refused (400, typed code)", async () => {
    const res = await call(makeIdentity("write"), "POST", "/runners/instances", {
      name: "Bad",
      runner: "claude",
      env: { API_KEY: "sk-x" },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, "INSTANCE_ENV_KEY_REFUSED");
  });

  test("PATCH /runners/instances/:id updates an existing instance", async () => {
    const createRes = await call(makeIdentity("write"), "POST", "/runners/instances", {
      name: "ToRename",
      runner: "claude",
    });
    const created = JSON.parse(createRes.body) as RunnerInstanceSummary;

    const patchRes = await call(makeIdentity("write"), "PATCH", `/runners/instances/${created.id}`, {
      name: "Renamed",
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal((JSON.parse(patchRes.body) as RunnerInstanceSummary).name, "Renamed");
  });

  test("PATCH /runners/instances/:id for an unknown id is 404", async () => {
    const res = await call(makeIdentity("write"), "PATCH", "/runners/instances/nonexistent", { name: "x" });
    assert.equal(res.statusCode, 404);
  });

  test("DELETE /runners/instances/:id requires admin scope", async () => {
    const createRes = await call(makeIdentity("write"), "POST", "/runners/instances", {
      name: "ToDelete",
      runner: "claude",
    });
    const created = JSON.parse(createRes.body) as RunnerInstanceSummary;

    const forbidden = await call(makeIdentity("write"), "DELETE", `/runners/instances/${created.id}`);
    assert.equal(forbidden.statusCode, 403);

    const ok = await call(makeIdentity("admin"), "DELETE", `/runners/instances/${created.id}`);
    assert.equal(ok.statusCode, 200);

    const listRes = await call(makeIdentity("read"), "GET", "/runners/instances");
    const body = JSON.parse(listRes.body) as { instances: RunnerInstanceSummary[] };
    assert.ok(!body.instances.some((i) => i.id === created.id));
  });

  test("PUT /runners/instances/:id/org-default sets the default, exclusive across instances", async () => {
    const aRes = await call(makeIdentity("write"), "POST", "/runners/instances", { name: "A", runner: "claude" });
    const bRes = await call(makeIdentity("write"), "POST", "/runners/instances", { name: "B", runner: "claude" });
    const a = JSON.parse(aRes.body) as RunnerInstanceSummary;
    const b = JSON.parse(bRes.body) as RunnerInstanceSummary;

    const setA = await call(makeIdentity("write"), "PUT", `/runners/instances/${a.id}/org-default`, { org_id: "org-1" });
    assert.equal(setA.statusCode, 200);

    const setB = await call(makeIdentity("write"), "PUT", `/runners/instances/${b.id}/org-default`, { org_id: "org-1" });
    assert.equal(setB.statusCode, 200);

    const listRes = await call(makeIdentity("read"), "GET", "/runners/instances");
    const body = JSON.parse(listRes.body) as { instances: RunnerInstanceSummary[] };
    assert.deepEqual(body.instances.find((i) => i.id === a.id)?.org_defaults, []);
    assert.deepEqual(body.instances.find((i) => i.id === b.id)?.org_defaults, ["org-1"]);
  });

  test("DELETE /runners/org-defaults/:orgId clears the org's default", async () => {
    const aRes = await call(makeIdentity("write"), "POST", "/runners/instances", { name: "A", runner: "claude" });
    const a = JSON.parse(aRes.body) as RunnerInstanceSummary;
    await call(makeIdentity("write"), "PUT", `/runners/instances/${a.id}/org-default`, { org_id: "org-1" });

    const cleared = await call(makeIdentity("write"), "DELETE", "/runners/org-defaults/org-1");
    assert.equal(cleared.statusCode, 200);

    const listRes = await call(makeIdentity("read"), "GET", "/runners/instances");
    const body = JSON.parse(listRes.body) as { instances: RunnerInstanceSummary[] };
    assert.deepEqual(body.instances.find((i) => i.id === a.id)?.org_defaults, []);
  });

  test("DELETE /runners/org-defaults/:orgId needs write scope", async () => {
    const res = await call(makeIdentity("read"), "DELETE", "/runners/org-defaults/org-1");
    assert.equal(res.statusCode, 403);
  });

  test("PUT /runners/instances/:id/org-default for an unknown id is 404", async () => {
    const res = await call(makeIdentity("write"), "PUT", "/runners/instances/nonexistent/org-default", {
      org_id: "org-1",
    });
    assert.equal(res.statusCode, 404);
  });
});
