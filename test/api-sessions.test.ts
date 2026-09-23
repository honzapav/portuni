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
import { openTestDb } from "./helpers/db.js";
import type { DbClient } from "../apps/server/infra/db.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { clearTestContentDb, installTestContentDb } from "./helpers/content-db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import {
  createSession,
  createDraftSession,
  closeSessionIfRunning,
  setSessionScopeWritable,
  upsertSessionScopeRead,
} from "../apps/server/domain/sessions.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { SessionSummary, SessionResumeInfo, SessionScopeRecord } from "../apps/server/shared/api-types.js";
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

    db = await openTestDb();
    await ensureSchemaOn(db);
    setDbForTesting(db);
    await installTestContentDb();

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

  async function insertRun(sessionId: string, hostId: string, startedAt: string): Promise<void> {
    await db.execute({
      sql: `INSERT INTO session_runs (id, session_id, runner, instance_id, host_id, started_at)
            VALUES (?, ?, 'fake', NULL, ?, ?)`,
      args: [ulid(), sessionId, hostId, startedAt],
    });
  }

  after(async () => {
    resetLocalDbForTests();
    clearTestContentDb();
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

  // #463: a draft is a thread, so the node list carries the caller's own
  // (a reload or a second window of the same user shows it). Another
  // user's draft never appears, however visible the node is.
  test("GET /nodes/:id/sessions carries the caller's own drafts and nobody else's", async () => {
    const mine = await createDraftSession(db, SOLO, nodeId);
    const theirs = await createDraftSession(db, "U2", nodeId);

    const asOwner = await call(makeIdentity(SOLO), "GET", `/nodes/${nodeId}/sessions`);
    assert.equal(asOwner.statusCode, 200);
    const ownerIds = (JSON.parse(asOwner.body) as { sessions: SessionSummary[] }).sessions.map((s) => s.id);
    assert.ok(ownerIds.includes(mine.id), "own draft is listed");
    assert.ok(!ownerIds.includes(theirs.id), "another user's draft is not");

    const asOther = await call(makeIdentity("U2"), "GET", `/nodes/${nodeId}/sessions`);
    const otherIds = (JSON.parse(asOther.body) as { sessions: SessionSummary[] }).sessions.map((s) => s.id);
    assert.ok(otherIds.includes(theirs.id), "U2 sees its own draft");
    assert.ok(!otherIds.includes(mine.id), "U2 never sees SOLO's draft");

    await db.execute({ sql: "DELETE FROM sessions WHERE id IN (?, ?)", args: [mine.id, theirs.id] });
  });

  test("GET /sessions?state=draft returns the caller's drafts only", async () => {
    const mine = await createDraftSession(db, SOLO, nodeId);
    const theirs = await createDraftSession(db, "U2", nodeId);

    const res = await call(makeIdentity(SOLO), "GET", "/sessions?state=draft");
    assert.equal(res.statusCode, 200);
    const ids = (JSON.parse(res.body) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    assert.deepEqual(ids, [mine.id]);

    const other = await call(makeIdentity("U2"), "GET", "/sessions?state=draft");
    const otherIds = (JSON.parse(other.body) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    assert.deepEqual(otherIds, [theirs.id]);

    await db.execute({ sql: "DELETE FROM sessions WHERE id IN (?, ?)", args: [mine.id, theirs.id] });
  });

  // #457: a thread is its owner's, of every state -- the node's read gate
  // decides whether the Relace tab exists at all, never which threads it
  // carries. Two identities on the same org-visible node see disjoint lists.
  test("GET /nodes/:id/sessions returns the caller's own threads only, whatever the state", async () => {
    const mine = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const theirs = await createSession(db, "U2", { node_id: nodeId, session_type: "interactive_task" });

    const asOwner = await call(makeIdentity(SOLO), "GET", `/nodes/${nodeId}/sessions`);
    assert.equal(asOwner.statusCode, 200);
    const ownerIds = (JSON.parse(asOwner.body) as { sessions: SessionSummary[] }).sessions.map((s) => s.id);
    assert.ok(ownerIds.includes(mine.id));
    assert.ok(!ownerIds.includes(theirs.id), "SOLO never sees U2's running thread");

    // manage scope buys nothing either.
    const asManager = await call(makeIdentity("U2", "manage"), "GET", `/nodes/${nodeId}/sessions`);
    const managerIds = (JSON.parse(asManager.body) as { sessions: SessionSummary[] }).sessions.map((s) => s.id);
    assert.ok(managerIds.includes(theirs.id));
    assert.ok(!managerIds.includes(mine.id), "manage does not see past ownership");

    await db.execute({ sql: "DELETE FROM sessions WHERE id IN (?, ?)", args: [mine.id, theirs.id] });
  });

  test("GET /sessions?state=running returns the caller's own threads only, manage included", async () => {
    const mine = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const theirs = await createSession(db, "U2", { node_id: nodeId, session_type: "interactive_task" });

    const asOwner = await call(makeIdentity(SOLO), "GET", "/sessions?state=running");
    assert.equal(asOwner.statusCode, 200);
    const ownerIds = (JSON.parse(asOwner.body) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    assert.ok(ownerIds.includes(mine.id));
    assert.ok(!ownerIds.includes(theirs.id));

    const asManager = await call(makeIdentity("U2", "manage"), "GET", "/sessions?state=running");
    const managerIds = (JSON.parse(asManager.body) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    assert.ok(managerIds.includes(theirs.id));
    assert.ok(!managerIds.includes(mine.id));

    await db.execute({ sql: "DELETE FROM sessions WHERE id IN (?, ?)", args: [mine.id, theirs.id] });
  });

  test("GET /nodes/:id/sessions includes terminal_id, null when the session carries none (#231)", async () => {
    const identity = makeIdentity(SOLO);
    const withTerminal = await createSession(db, SOLO, {
      node_id: nodeId,
      session_type: "interactive_task",
      terminal_id: "term_abc_1_xyz",
    });
    const withoutTerminal = await createSession(db, SOLO, {
      node_id: nodeId,
      session_type: "headless",
    });

    const res = await call(identity, "GET", `/nodes/${nodeId}/sessions`);
    const body = JSON.parse(res.body) as { sessions: SessionSummary[] };
    const byId = new Map(body.sessions.map((s) => [s.id, s]));
    assert.equal(byId.get(withTerminal.id)?.terminal_id, "term_abc_1_xyz");
    assert.equal(byId.get(withoutTerminal.id)?.terminal_id, null);
  });

  // #428: the summary's host is the latest run's, not the session row's --
  // a thread that started on one machine and last ran on another shows
  // where it last ran. The label exists only for the host this process is;
  // anything else falls back to the id at the render site.
  test("GET /nodes/:id/sessions reports the latest run's host, labelled when it is this machine", async () => {
    process.env.PORTUNI_HOST_ID = "test-host-1";
    process.env.PORTUNI_HOST_LABEL = "Test Host 1";
    try {
      const moved = await createSession(db, SOLO, {
        node_id: nodeId,
        session_type: "interactive_task",
        host_id: "where-it-started",
      });
      await insertRun(moved.id, "older-host", "2026-09-20T10:00:00.000Z");
      await insertRun(moved.id, "test-host-1", "2026-09-20T11:00:00.000Z");

      const elsewhere = await createSession(db, SOLO, {
        node_id: nodeId,
        session_type: "interactive_task",
        host_id: "where-it-started",
      });
      await insertRun(elsewhere.id, "someone-elses-mac", "2026-09-20T11:00:00.000Z");

      const noRuns = await createSession(db, SOLO, {
        node_id: nodeId,
        session_type: "interactive_task",
        host_id: "where-it-started",
      });

      const res = await call(makeIdentity(SOLO), "GET", `/nodes/${nodeId}/sessions`);
      const body = JSON.parse(res.body) as { sessions: SessionSummary[] };
      const byId = new Map(body.sessions.map((x) => [x.id, x]));

      assert.equal(byId.get(moved.id)?.host_id, "test-host-1");
      assert.equal(byId.get(moved.id)?.host_label, "Test Host 1");
      assert.equal(byId.get(elsewhere.id)?.host_id, "someone-elses-mac");
      assert.equal(byId.get(elsewhere.id)?.host_label, null);
      // No run yet: the session row's own host is what there is.
      assert.equal(byId.get(noRuns.id)?.host_id, "where-it-started");
      assert.equal(byId.get(noRuns.id)?.host_label, null);
    } finally {
      delete process.env.PORTUNI_HOST_ID;
      delete process.env.PORTUNI_HOST_LABEL;
    }
  });

  test("GET /nodes/:id/sessions 404s for an unknown node", async () => {
    const res = await call(makeIdentity(SOLO), "GET", `/nodes/${ulid()}/sessions`);
    assert.equal(res.statusCode, 404);
  });

  // v2 rule 5: runner and instance are the thread's, chosen while it is a
  // draft. A bare change on any other state is refused; the promotion
  // patch (state together with them) is the one exception.
  test("PATCH runner/instance_id is 409 SESSION_NOT_DRAFT on a running session, 200 on a draft", async () => {
    const running = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task", runner: "claude" });
    const refused = await call(makeIdentity(SOLO), "PATCH", `/sessions/${running.id}`, { instance_id: "01INST" });
    assert.equal(refused.statusCode, 409);
    assert.equal((JSON.parse(refused.body) as { code: string }).code, "SESSION_NOT_DRAFT");

    const draft = await createDraftSession(db, SOLO, nodeId);
    const ok = await call(makeIdentity(SOLO), "PATCH", `/sessions/${draft.id}`, { runner: "claude", instance_id: "01INST" });
    assert.equal(ok.statusCode, 200);
    const row = JSON.parse(ok.body) as { runner: string; instance_id: string };
    assert.equal(row.runner, "claude");
    assert.equal(row.instance_id, "01INST");
  });

  test("PATCH /sessions/:id renames a session the caller owns", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity(SOLO), "PATCH", `/sessions/${session.id}`, { name: "Renamed" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as SessionSummary;
    assert.equal(body.name, "Renamed");
    assert.equal(body.name_is_custom, true);
  });

  // #457: a thread is its owner's. A session owned by someone else is hidden
  // whether or not the caller can see the anchor node -- 404, never 403.
  test("PATCH /sessions/:id 404s for a session owned by someone else on a visible node", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2"), "PATCH", `/sessions/${session.id}`, { name: "Nope" });
    assert.equal(res.statusCode, 404);
  });

  test("PATCH /sessions/:id 404s for a session anchored to a node the caller cannot see", async () => {
    const restrictedNodeId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by, visibility) VALUES (?, 'project', 'Hidden', 'hidden', ?, 'group')",
      args: [restrictedNodeId, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO node_access (node_id, kind, principal, display_email, added_by) VALUES (?, 'user', ?, NULL, ?)",
      args: [restrictedNodeId, SOLO, SOLO],
    });
    const session = await createSession(db, SOLO, {
      node_id: restrictedNodeId,
      session_type: "interactive_task",
    });
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

  // #457: stopping is the owner's like every other action -- a non-owner
  // gets 404, manage scope included.
  test("POST /sessions/:id/state 404s for a session owned by someone else", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2"), "POST", `/sessions/${session.id}/state`, { state: "closed" });
    assert.equal(res.statusCode, 404);
  });

  test("POST /sessions/:id/state 404s for someone else even with manage scope", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2", "manage"), "POST", `/sessions/${session.id}/state`, {
      state: "closed",
    });
    assert.equal(res.statusCode, 404);
  });

  test("GET /sessions/:id/resume-info reports conversationResumable false with no mirror on this machine", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity(SOLO), "GET", `/sessions/${session.id}/resume-info`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as SessionResumeInfo;
    assert.equal(body.session_id, session.id);
    assert.equal(body.conversation_resumable, false);
    // #204: no local mirror means handoff_changed cannot be evaluated at
    // all -- must not be reported as a false-positive "changed".
    assert.equal(body.handoff_checkable, false);
    assert.equal(body.handoff_changed, false);
  });

  test("GET /sessions/:id/resume-info accepts a config_dir override without erroring", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(
      makeIdentity(SOLO),
      "GET",
      `/sessions/${session.id}/resume-info?config_dir=${encodeURIComponent("/tmp/some-profile-config")}`,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as SessionResumeInfo;
    assert.equal(body.conversation_resumable, false);
  });

  // #457: reading is the owner's too -- seeing the anchor node says nothing
  // about the threads on it.
  test("GET /sessions/:id/resume-info 404s for a non-owner who can see the anchor node", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2"), "GET", `/sessions/${session.id}/resume-info`);
    assert.equal(res.statusCode, 404);
  });

  // #329 made a server-generated suspend distinguishable at resume time by
  // its summary; #497: a server-side suspend (here the transport-disconnect
  // GC backstop) writes no summary, so there is nothing to attribute.
  test("GET /sessions/:id/resume-info reports no generated summary after a server-side suspend (#497)", async () => {
    const session = await createSession(db, SOLO, {
      node_id: nodeId,
      session_type: "interactive_task",
    });
    await closeSessionIfRunning(db, session.id, "disconnect");

    const res = await call(makeIdentity(SOLO), "GET", `/sessions/${session.id}/resume-info`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as SessionResumeInfo;
    assert.equal(body.generated_by, null);
    assert.equal(body.reason, null);
    assert.equal(body.handoff_path, null);
  });

  // The restart indicator (#342, SessionChat header): GET /sessions/:id/
  // signals is a plain read of sessionSignals, gated by the same owner-only
  // rule as resume-info (auth/session-access.ts).
  test("GET /sessions/:id/signals reports zeros/null for a session with no live run", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity(SOLO), "GET", `/sessions/${session.id}/signals`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      runAgeMs: number | null;
      writeSetSize: number;
      readSetSize: number;
      expansionsSinceRunStart: number;
    };
    assert.equal(body.runAgeMs, null);
    assert.equal(body.writeSetSize, 0);
    assert.equal(body.readSetSize, 0);
    assert.equal(body.expansionsSinceRunStart, 0);
  });

  test("GET /sessions/:id/signals 404s for a non-owner who can see the anchor node", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2"), "GET", `/sessions/${session.id}/signals`);
    assert.equal(res.statusCode, 404);
  });

  test("GET /sessions/:id/signals 404s for an unknown session id", async () => {
    const res = await call(makeIdentity(SOLO), "GET", `/sessions/${ulid()}/signals`);
    assert.equal(res.statusCode, 404);
  });

  // #427: the record half of the session's scope, read by a sync agent's
  // suspend fallback (it has no session_scope table of its own) to fill the
  // summary's "Zápisový rozsah" / "Čtecí rozsah" sections.
  test("GET /sessions/:id/scope returns the read set, the write set and the node name", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const otherId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'Druhy', 'druhy', ?)",
      args: [otherId, SOLO],
    });
    await upsertSessionScopeRead(db, session.id, nodeId, "seed", null);
    await setSessionScopeWritable(db, session.id, nodeId);
    await upsertSessionScopeRead(db, session.id, otherId, "edge", null);

    const res = await call(makeIdentity(SOLO), "GET", `/sessions/${session.id}/scope`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as SessionScopeRecord;
    assert.equal(body.session_id, session.id);
    assert.equal(body.node_name, "Proj");
    assert.deepEqual(body.write_set, [nodeId]);
    assert.deepEqual([...body.read_set].sort(), [nodeId, otherId].sort());
  });

  test("GET /sessions/:id/scope is empty for a session that never reached a node", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity(SOLO), "GET", `/sessions/${session.id}/scope`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as SessionScopeRecord;
    assert.deepEqual(body.write_set, []);
    assert.deepEqual(body.read_set, []);
  });

  test("GET /sessions/:id/scope 404s for an unknown session id", async () => {
    const res = await call(makeIdentity(SOLO), "GET", `/sessions/${ulid()}/scope`);
    assert.equal(res.statusCode, 404);
  });

  test("GET /sessions/:id/resume-info reports generated_by null for an ordinary (non-server) suspend", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    await call(makeIdentity(SOLO), "POST", `/sessions/${session.id}/state`, { state: "suspended" });

    const res = await call(makeIdentity(SOLO), "GET", `/sessions/${session.id}/resume-info`);
    const body = JSON.parse(res.body) as SessionResumeInfo;
    assert.equal(body.generated_by, null);
    assert.equal(body.reason, null);
  });

});
