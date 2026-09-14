// REST tests for the task endpoints under /sessions (runner batch, #321):
// POST /sessions, /messages, /questions/:request_id, /interrupt, /suspend,
// /resume, /close, GET /sessions/:id/events. Same methodology as
// test/api-sessions.test.ts (routeApiRequest + mock req/res) with
// setSessionRuntimeForTesting wired to a FakeRunnerAdapter, the pattern
// test/runner-runtime.test.ts uses directly against the runtime.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import { registerAdapter, clearRegistryForTests } from "../apps/server/domain/runner/registry.js";
import { FakeRunnerAdapter, type FakeScriptStep } from "../apps/server/domain/runner/adapters/fake.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import { createSessionRuntime } from "../apps/server/domain/runner/session-runtime.js";
import { setSessionRuntimeForTesting } from "../apps/server/boot/session-runtime.js";
import type { ProvisionRunResult } from "../apps/server/domain/runner/provision.js";
import { createSession } from "../apps/server/domain/sessions.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { SessionSummary, SessionRunRow, SessionEventRow } from "../apps/server/shared/api-types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { insertIgnore } from "../apps/server/infra/sql.js";

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

function stubProvision(overrides: Partial<ProvisionRunResult> = {}) {
  return async (input: { nodeId: string }): Promise<ProvisionRunResult> => ({
    cwd: "/tmp/mirror",
    orientation: "orientation text",
    mcp: { url: "http://localhost:4011/mcp", token: "tok", homeNodeId: input.nodeId },
    portuniRoot: "/tmp",
    mirrors: ["/tmp/mirror"],
    ...overrides,
  });
}

function installRuntime(script: readonly FakeScriptStep[]) {
  clearRegistryForTests();
  const adapter = new FakeRunnerAdapter({ script });
  registerAdapter(adapter);
  const runtime = createSessionRuntime({
    store: new DbSessionStore(dbFixture.db),
    registry: { getAdapter: (id) => (id === adapter.id ? adapter : null) },
    provision: stubProvision(),
    suspendPollIntervalMs: 10,
    suspendTimeoutMs: 100,
  });
  setSessionRuntimeForTesting(runtime);
  return runtime;
}

let dbFixture: SharedDb;
let dataDir: string;

describe("task REST endpoints under /sessions", () => {
  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "portuni-api-sessions-runtime-"));
    process.env.PORTUNI_DATA_DIR = dataDir;
  });

  after(async () => {
    delete process.env.PORTUNI_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dbFixture = await makeSharedDb();
    await dbFixture.db.execute({
      sql: insertIgnore(dbFixture.db.dialect, "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)"),
      args: ["U2", "u2@x.com", "U2"],
    });
    setDbForTesting(dbFixture.db);
  });

  after(() => {
    setDbForTesting(null);
    setSessionRuntimeForTesting(null);
    clearRegistryForTests();
  });

  test("POST /sessions starts a task; GET events shows run_started + the brief as user_message", async () => {
    installRuntime([]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "Fix the bug",
      runner: "fake",
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body) as { session: SessionSummary; run: SessionRunRow };
    assert.equal(body.session.node_id, dbFixture.nodeId);
    assert.equal(body.session.brief, "Fix the bug");
    assert.equal(body.session.runner, "fake");
    assert.equal(body.run.session_id, body.session.id);

    const eventsRes = await call(makeIdentity("U1"), "GET", `/sessions/${body.session.id}/events`);
    assert.equal(eventsRes.statusCode, 200);
    const eventsBody = JSON.parse(eventsRes.body) as { events: SessionEventRow[]; next_after: number | null };
    assert.deepEqual(
      eventsBody.events.map((e) => e.kind),
      ["run_started", "user_message", "run_ended"],
    );
    assert.deepEqual(eventsBody.events[1].payload, { text: "Fix the bug", source: "chat" });
    assert.equal(eventsBody.next_after, null);
  });

  test("POST /sessions 400s for an unknown runner", async () => {
    installRuntime([]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "nonexistent",
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, "UNKNOWN_RUNNER");
  });

  test("POST /sessions 400s for an unknown instance", async () => {
    installRuntime([]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
      instance_id: "no-such-instance",
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, "UNKNOWN_INSTANCE");
  });

  test("a scripted question sets waiting_since; POST .../questions/:request_id clears it and records the decision", async () => {
    const script: FakeScriptStep[] = [
      {
        kind: "question",
        payload: {
          request_id: "req-1",
          type: "approval",
          tool: "mcp__portuni__portuni_expand_scope",
          title: "Rozšířit rozsah?",
          detail: "detail",
          options: null,
          decision: null,
        },
      },
      { wait: "answer" },
      { kind: "assistant_message", payload: { text: "done" } },
    ];
    installRuntime(script);
    const start = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
    });
    const { session } = JSON.parse(start.body) as { session: SessionSummary };
    assert.ok(session.waiting_since, "waiting_since must be set once the question opens");

    const badReq = await call(makeIdentity("U1"), "POST", `/sessions/${session.id}/questions/wrong-id`, {
      decision: { value: true },
    });
    assert.equal(badReq.statusCode, 409);
    assert.equal(JSON.parse(badReq.body).code, "NO_PENDING_QUESTION");

    const answerRes = await call(makeIdentity("U1"), "POST", `/sessions/${session.id}/questions/req-1`, {
      decision: { value: true },
    });
    assert.equal(answerRes.statusCode, 202);

    const eventsRes = await call(makeIdentity("U1"), "GET", `/sessions/${session.id}/events`);
    const { events } = JSON.parse(eventsRes.body) as { events: SessionEventRow[] };
    // Two "question" events land: the original (decision: null) and the
    // answered one appended by answer() -- the last one is the answered one.
    const questionEvents = events.filter((e) => e.kind === "question");
    assert.equal(questionEvents.length, 2);
    const answered = questionEvents[questionEvents.length - 1];
    assert.equal((answered.payload as { decision: { value: boolean } | null }).decision?.value, true);
  });

  test("interrupt, suspend, resume {mode: handoff} and close move the session through its states", async () => {
    installRuntime([{ wait: "message" }]);
    const start = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
    });
    const { session: started } = JSON.parse(start.body) as { session: SessionSummary };

    const interruptRes = await call(makeIdentity("U1"), "POST", `/sessions/${started.id}/interrupt`);
    assert.equal(interruptRes.statusCode, 200);

    // Suspend on a session with no live run still runs the full poll (short,
    // via the test-only override) and falls back to a server-generated
    // handoff since nothing calls portuni_session_suspend in this test.
    const suspendRes = await call(makeIdentity("U1"), "POST", `/sessions/${started.id}/suspend`);
    assert.equal(suspendRes.statusCode, 200);
    const suspended = (JSON.parse(suspendRes.body) as { session: SessionSummary }).session;
    assert.equal(suspended.state, "suspended");

    const resumeRes = await call(makeIdentity("U1"), "POST", `/sessions/${started.id}/resume`, {
      mode: "handoff",
    });
    assert.equal(resumeRes.statusCode, 200);
    const resumed = (JSON.parse(resumeRes.body) as { session: SessionSummary; run: SessionRunRow }).session;
    assert.equal(resumed.state, "running");

    const closeRes = await call(makeIdentity("U1"), "POST", `/sessions/${started.id}/close`);
    assert.equal(closeRes.statusCode, 200);
    const closed = (JSON.parse(closeRes.body) as { session: SessionSummary }).session;
    assert.equal(closed.state, "closed");
  });

  test("events?after pages", async () => {
    installRuntime([{ kind: "assistant_message", payload: { text: "hello" } }]);
    const start = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
    });
    const { session } = JSON.parse(start.body) as { session: SessionSummary };

    const all = await call(makeIdentity("U1"), "GET", `/sessions/${session.id}/events`);
    const allEvents = (JSON.parse(all.body) as { events: SessionEventRow[] }).events;
    assert.ok(allEvents.length >= 3);

    const firstSeq = allEvents[0].seq;
    const rest = await call(makeIdentity("U1"), "GET", `/sessions/${session.id}/events?after=${firstSeq}`);
    const restEvents = (JSON.parse(rest.body) as { events: SessionEventRow[] }).events;
    assert.equal(restEvents.length, allEvents.length - 1);
    assert.ok(restEvents.every((e) => e.seq > firstSeq));
  });

  test("a second user who can see the node reads events but cannot message; interrupt needs manage scope", async () => {
    installRuntime([{ wait: "message" }]);
    const start = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
    });
    const { session } = JSON.parse(start.body) as { session: SessionSummary };

    const eventsRes = await call(makeIdentity("U2"), "GET", `/sessions/${session.id}/events`);
    assert.equal(eventsRes.statusCode, 200);

    const messageRes = await call(makeIdentity("U2"), "POST", `/sessions/${session.id}/messages`, { text: "hi" });
    assert.equal(messageRes.statusCode, 403);

    const interruptDenied = await call(makeIdentity("U2", "write"), "POST", `/sessions/${session.id}/interrupt`);
    assert.equal(interruptDenied.statusCode, 403);

    const interruptAllowed = await call(makeIdentity("U2", "manage"), "POST", `/sessions/${session.id}/interrupt`);
    assert.equal(interruptAllowed.statusCode, 200);

    const eventsAfter = await call(makeIdentity("U1"), "GET", `/sessions/${session.id}/events`);
    const events = (JSON.parse(eventsAfter.body) as { events: SessionEventRow[] }).events;
    const stateChanged = events.find(
      (e) => e.kind === "state_changed" && (e.payload as { by?: string }).by === "U2",
    );
    assert.ok(stateChanged, "a non-owner interrupt must append a state_changed event naming the actor");
  });

  test("a node-less session is forbidden for everyone but the owner", async () => {
    installRuntime([]);
    const session = await createSession(dbFixture.db, "U1", { node_id: null, session_type: "interactive_chat" });

    const ownerRes = await call(makeIdentity("U1"), "GET", `/sessions/${session.id}/events`);
    assert.equal(ownerRes.statusCode, 200);

    const otherRes = await call(makeIdentity("U2", "manage"), "GET", `/sessions/${session.id}/events`);
    assert.equal(otherRes.statusCode, 403);
  });
});
