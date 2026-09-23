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
import { installTestContentDb } from "./helpers/content-db.js";
import type { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
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

// #456: the runtime writes the transcript to the device's content.db; a
// fresh in-memory one per runtime keeps each test's transcript its own.
let content: SessionContentStore;

async function installRuntime(script: readonly FakeScriptStep[]) {
  clearRegistryForTests();
  const adapter = new FakeRunnerAdapter({ script });
  registerAdapter(adapter);
  content = (await installTestContentDb()).content;
  const runtime = createSessionRuntime({
    store: new DbSessionStore(dbFixture.db),
    content,
    registry: { getAdapter: (id) => (id === adapter.id ? adapter : null) },
    provision: stubProvision(),
  });
  setSessionRuntimeForTesting(runtime);
  return { runtime, adapter };
}

let dbFixture: SharedDb;
let dataDir: string;

describe("task REST endpoints under /sessions", () => {
  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "portuni-api-sessions-runtime-"));
    process.env.PORTUNI_DATA_DIR = dataDir;
    // #428: pin the host identity so the assertions below do not depend on
    // the machine's own hostname.
    process.env.PORTUNI_HOST_ID = "test-host-1";
    process.env.PORTUNI_HOST_LABEL = "Test Host 1";
  });

  after(async () => {
    delete process.env.PORTUNI_DATA_DIR;
    delete process.env.PORTUNI_HOST_ID;
    delete process.env.PORTUNI_HOST_LABEL;
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
    await installRuntime([]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "Fix the bug",
      runner: "fake",
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body) as { session: SessionSummary; run: SessionRunRow };
    assert.equal(body.session.node_id, dbFixture.nodeId);
    // #456: the brief is content -- the record carries none of it; the
    // device's content store does, and the transcript shows it as the
    // first user_message (asserted just below).
    assert.equal(body.session.brief, null);
    assert.equal((await content.getContent(body.session.id))?.brief, "Fix the bug");
    assert.equal(body.session.runner, "fake");
    assert.equal(body.run.session_id, body.session.id);

    const eventsRes = await call(makeIdentity("U1"), "GET", `/sessions/${body.session.id}/events`);
    assert.equal(eventsRes.statusCode, 200);
    const eventsBody = JSON.parse(eventsRes.body) as { events: SessionEventRow[]; next_after: number | null };
    assert.deepEqual(
      eventsBody.events.map((e) => e.kind),
      // #378: nobody closed this run explicitly, so it falls through to the
      // auto-summary/suspend path and gets its handoff event too.
      ["run_started", "user_message", "run_ended", "handoff"],
    );
    assert.deepEqual(eventsBody.events[1].payload, { text: "Fix the bug", source: "chat" });
    assert.equal(eventsBody.next_after, null);
  });

  test("POST /sessions 400s for an unknown runner", async () => {
    await installRuntime([]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "nonexistent",
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, "UNKNOWN_RUNNER");
  });

  test("POST /sessions 400s for an unknown instance", async () => {
    await installRuntime([]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
      instance_id: "no-such-instance",
    });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, "UNKNOWN_INSTANCE");
  });

  // #375/#426: model/effort round-trip through POST /sessions and
  // POST /sessions/:id/model.
  test("POST /sessions persists model/effort; SessionSummary carries them", async () => {
    await installRuntime([]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
      model: "claude-opus-4-8",
      effort: "high",
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body) as { session: SessionSummary };
    assert.equal(body.session.model, "claude-opus-4-8");
    assert.equal(body.session.effort, "high");
  });

  // #428: the run carries the host it started on, and the summary reads it
  // back from there -- so the Relace row and the chat header show which
  // machine ran the task without a per-row GET /sessions/:id/runs.
  test("POST /sessions stamps this host on the run; SessionSummary carries id and label", async () => {
    await installRuntime([]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body) as { session: SessionSummary; run: SessionRunRow | null };
    assert.equal(body.run?.host_id, "test-host-1");
    assert.equal(body.session.host_id, "test-host-1");
    assert.equal(body.session.host_label, "Test Host 1");
  });

  // #426: POST /sessions/:id/model, not PATCH /sessions/:id -- the live
  // half has to run on the device driving the run, so it got its own
  // device-local route.
  test("POST /sessions/:id/model sets model on a session with a live run, reaching the adapter's live query", async () => {
    const { adapter } = await installRuntime([{ wait: "message" }]);
    const startRes = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
    });
    const { session } = JSON.parse(startRes.body) as { session: SessionSummary };
    assert.equal(adapter.getLastSetModel(), null);

    const patchRes = await call(makeIdentity("U1"), "POST", `/sessions/${session.id}/model`, {
      model: "claude-sonnet-5",
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(adapter.getLastSetModel(), "claude-sonnet-5", "the live run's Query must have been told");

    const getRes = await call(makeIdentity("U1"), "GET", `/sessions/${session.id}`);
    assert.equal((JSON.parse(getRes.body) as { model: string | null }).model, "claude-sonnet-5");
  });

  test("POST /sessions/:id/model sets effort without touching the live run (no live setter for it)", async () => {
    const { adapter } = await installRuntime([{ wait: "message" }]);
    const startRes = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
    });
    const { session } = JSON.parse(startRes.body) as { session: SessionSummary };

    const patchRes = await call(makeIdentity("U1"), "POST", `/sessions/${session.id}/model`, { effort: "xhigh" });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(adapter.getLastSetModel(), null, "effort has no live setter, unlike model");

    const getRes = await call(makeIdentity("U1"), "GET", `/sessions/${session.id}`);
    assert.equal((JSON.parse(getRes.body) as { effort: string | null }).effort, "xhigh");
  });

  // #374: a thread opens empty -- POST /sessions with no brief creates a
  // draft (no run) instead of starting a task. v2 rule 5: the draft
  // already carries the device's default runner (the fake is the only
  // one registered) and instance (none configured, so null).
  test("POST /sessions without a brief creates a draft, no run started", async () => {
    await installRuntime([]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", { node_id: dbFixture.nodeId });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body) as { session: SessionSummary; run: SessionRunRow | null };
    assert.equal(body.session.state, "draft");
    assert.equal(body.session.name, "Nový úkol");
    assert.equal(body.session.brief, null);
    assert.equal(body.session.runner, "fake");
    assert.equal(body.session.instance_id, null);
    assert.equal(body.run, null);

    // The draft is a thread of the node for its owner (#463), so the
    // owner's list carries it -- another user's list never does.
    const listRes = await call(makeIdentity("U1"), "GET", `/nodes/${dbFixture.nodeId}/sessions`);
    const listBody = JSON.parse(listRes.body) as { sessions: SessionSummary[] };
    assert.ok(listBody.sessions.some((s) => s.id === body.session.id));

    const otherRes = await call(makeIdentity("U2"), "GET", `/nodes/${dbFixture.nodeId}/sessions`);
    const otherBody = JSON.parse(otherRes.body) as { sessions: SessionSummary[] };
    assert.ok(!otherBody.sessions.some((s) => s.id === body.session.id));
  });

  // v2 context ring: the runtime folds each context_usage event's counters
  // onto the session row, so a list row carries them without the log.
  test("a context_usage event folds its counters into the session summary", async () => {
    await installRuntime([
      {
        kind: "context_usage",
        payload: {
          run_id: "ignored",
          model: "m",
          used_tokens: 1234,
          max_tokens: 200000,
          input_tokens: 1000,
          cached_tokens: 234,
          output_tokens: 9,
        },
      },
      { wait: "message" },
    ]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", { node_id: dbFixture.nodeId, brief: "go", runner: "fake" });
    assert.equal(res.statusCode, 201);
    const { session } = JSON.parse(res.body) as { session: SessionSummary };
    const listRes = await call(makeIdentity("U1"), "GET", `/nodes/${dbFixture.nodeId}/sessions`);
    const row = (JSON.parse(listRes.body) as { sessions: SessionSummary[] }).sessions.find((s) => s.id === session.id);
    assert.ok(row);
    assert.equal(row.context_used_tokens, 1234);
    assert.equal(row.context_max_tokens, 200000);
    const eventsRes = await call(makeIdentity("U1"), "GET", `/sessions/${session.id}/events`);
    const kinds = (JSON.parse(eventsRes.body) as { events: SessionEventRow[] }).events.map((e) => e.kind);
    assert.ok(kinds.includes("context_usage"));
  });

  // v2 rule 5: promotion keeps what the draft row says -- here an instance
  // patched onto the draft after creation -- instead of re-resolving the
  // organisation's default.
  test("promotion keeps the draft's own runner/instance instead of re-resolving", async () => {
    await installRuntime([{ wait: "message" }]);
    const draftRes = await call(makeIdentity("U1"), "POST", "/sessions", { node_id: dbFixture.nodeId });
    const { session: draft } = JSON.parse(draftRes.body) as { session: SessionSummary };
    const patchRes = await call(makeIdentity("U1"), "PATCH", `/sessions/${draft.id}`, { instance_id: "01INST" });
    assert.equal(patchRes.statusCode, 200);

    const msgRes = await call(makeIdentity("U1"), "POST", `/sessions/${draft.id}/messages`, { text: "go" });
    assert.equal(msgRes.statusCode, 202);
    const getRes = await call(makeIdentity("U1"), "GET", `/sessions/${draft.id}`);
    const updated = JSON.parse(getRes.body) as { state: string; runner: string; instance_id: string | null };
    assert.equal(updated.state, "running");
    assert.equal(updated.runner, "fake");
    assert.equal(updated.instance_id, "01INST");
  });

  test("POST /sessions/:id/messages promotes a draft: resolves the runner, names the thread, starts the run", async () => {
    // A trailing wait keeps the run live -- an empty script would auto-
    // complete right away and (#378) fall into the auto-summary/suspend
    // path, which is not what this test is about.
    await installRuntime([{ wait: "message" }]);
    const draftRes = await call(makeIdentity("U1"), "POST", "/sessions", { node_id: dbFixture.nodeId });
    const { session: draft } = JSON.parse(draftRes.body) as { session: SessionSummary };

    const msgRes = await call(makeIdentity("U1"), "POST", `/sessions/${draft.id}/messages`, {
      text: "Fix the login bug please, it throws on empty passwords",
    });
    assert.equal(msgRes.statusCode, 202);

    // GET /sessions/:id returns the raw SessionRow (see handleGetSession's
    // own comment), not the curated SessionSummary -- name_is_custom is
    // still the 0/1 integer column here.
    const getRes = await call(makeIdentity("U1"), "GET", `/sessions/${draft.id}`);
    const updated = JSON.parse(getRes.body) as { state: string; runner: string; brief: string; name: string; name_is_custom: number };
    assert.equal(updated.state, "running");
    assert.equal(updated.runner, "fake");
    assert.equal(updated.brief, null, "#456: the first message is content, not a record column");
    assert.equal(
      (await content.getContent(draft.id))?.brief,
      "Fix the login bug please, it throws on empty passwords",
    );
    assert.equal(updated.name, "Fix the login bug please, it throws on empty passwords");
    assert.equal(updated.name_is_custom, 1);

    const eventsRes = await call(makeIdentity("U1"), "GET", `/sessions/${draft.id}/events`);
    const eventsBody = JSON.parse(eventsRes.body) as { events: SessionEventRow[] };
    assert.deepEqual(
      eventsBody.events.map((e) => e.kind),
      ["state_changed", "run_started", "user_message"],
    );
    assert.deepEqual(eventsBody.events[0].payload, { from: "draft", to: "running", waiting: false });
    assert.deepEqual(eventsBody.events[2].payload, {
      text: "Fix the login bug please, it throws on empty passwords",
      source: "chat",
    });
  });

  test("POST /sessions/:id/messages 400s promoting a draft when no runner is installed/logged in", async () => {
    clearRegistryForTests(); // no adapter registered at all
    const runtime = createSessionRuntime({
      store: new DbSessionStore(dbFixture.db),
      registry: { getAdapter: () => null },
      provision: stubProvision(),
    });
    setSessionRuntimeForTesting(runtime);

    const draftRes = await call(makeIdentity("U1"), "POST", "/sessions", { node_id: dbFixture.nodeId });
    const { session: draft } = JSON.parse(draftRes.body) as { session: SessionSummary };

    const res = await call(makeIdentity("U1"), "POST", `/sessions/${draft.id}/messages`, { text: "hello" });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, "NO_RUNNER_AVAILABLE");
  });

  test("DELETE /sessions/:id removes a draft", async () => {
    await installRuntime([]);
    const draftRes = await call(makeIdentity("U1"), "POST", "/sessions", { node_id: dbFixture.nodeId });
    const { session: draft } = JSON.parse(draftRes.body) as { session: SessionSummary };

    const res = await call(makeIdentity("U1"), "DELETE", `/sessions/${draft.id}`);
    assert.equal(res.statusCode, 200);

    const getRes = await call(makeIdentity("U1"), "GET", `/sessions/${draft.id}`);
    assert.equal(getRes.statusCode, 404);
  });

  test("DELETE /sessions/:id refuses a non-draft session", async () => {
    await installRuntime([]);
    const res0 = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
    });
    const { session } = JSON.parse(res0.body) as { session: SessionSummary };

    const res = await call(makeIdentity("U1"), "DELETE", `/sessions/${session.id}`);
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, "NOT_A_DRAFT");
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
    await installRuntime(script);
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

  test("interrupt leaves the run live, continue moves to a new session, and close ends it (#378)", async () => {
    await installRuntime([{ wait: "message" }]);
    const start = await call(makeIdentity("U1"), "POST", "/sessions", {
      node_id: dbFixture.nodeId,
      brief: "x",
      runner: "fake",
    });
    const { session: started } = JSON.parse(start.body) as { session: SessionSummary };

    // interrupt() only cancels the current turn -- the run and the session
    // both stay live, so a message right after is accepted as ordinary.
    const interruptRes = await call(makeIdentity("U1"), "POST", `/sessions/${started.id}/interrupt`);
    assert.equal(interruptRes.statusCode, 200);
    const afterInterrupt = (JSON.parse(interruptRes.body) as { session: SessionSummary }).session;
    assert.equal(afterInterrupt.state, "running");

    const msgRes = await call(makeIdentity("U1"), "POST", `/sessions/${started.id}/messages`, {
      text: "still here?",
    });
    assert.equal(msgRes.statusCode, 202);

    // "Pokračovat v nové session": closes the old session (no summary
    // written on it -- continueSession's own close is not the auto-summary
    // path) and starts a fresh, running one on the same node, carrying the
    // old session's history as orientation.
    const continueRes = await call(makeIdentity("U1"), "POST", `/sessions/${started.id}/continue`);
    assert.equal(continueRes.statusCode, 200);
    const { session: continued } = JSON.parse(continueRes.body) as { session: SessionSummary; run: SessionRunRow };
    assert.notEqual(continued.id, started.id);
    assert.equal(continued.state, "running");

    const oldRes = await call(makeIdentity("U1"), "GET", `/sessions/${started.id}`);
    assert.equal((JSON.parse(oldRes.body) as { state: string }).state, "closed");

    const closeRes = await call(makeIdentity("U1"), "POST", `/sessions/${continued.id}/close`);
    assert.equal(closeRes.statusCode, 200);
    const closed = (JSON.parse(closeRes.body) as { session: SessionSummary }).session;
    assert.equal(closed.state, "closed");
  });

  test("events?after pages", async () => {
    await installRuntime([{ kind: "assistant_message", payload: { text: "hello" } }]);
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
    await installRuntime([{ wait: "message" }]);
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
    await installRuntime([]);
    const session = await createSession(dbFixture.db, "U1", { node_id: null, session_type: "interactive_chat" });

    const ownerRes = await call(makeIdentity("U1"), "GET", `/sessions/${session.id}/events`);
    assert.equal(ownerRes.statusCode, 200);

    const otherRes = await call(makeIdentity("U2", "manage"), "GET", `/sessions/${session.id}/events`);
    assert.equal(otherRes.statusCode, 403);
  });
});
