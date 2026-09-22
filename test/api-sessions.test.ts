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

  // #463: a draft is a thread the caller composed, so its own list of a
  // visible node shows it; another user's draft on the same node stays
  // invisible (the fixture's project node has no ACL, so U2 sees the node
  // itself, just not SOLO's draft on it).
  test("GET /nodes/:id/sessions includes the caller's own draft, excludes another user's draft", async () => {
    const own = await createDraftSession(db, SOLO, nodeId);
    const other = await createDraftSession(db, "U2", nodeId);

    const mine = await call(makeIdentity(SOLO), "GET", `/nodes/${nodeId}/sessions`);
    const mineBody = JSON.parse(mine.body) as { sessions: SessionSummary[] };
    const mineIds = mineBody.sessions.map((s) => s.id);
    assert.ok(mineIds.includes(own.id));
    assert.ok(!mineIds.includes(other.id));

    const theirs = await call(makeIdentity("U2"), "GET", `/nodes/${nodeId}/sessions`);
    const theirsBody = JSON.parse(theirs.body) as { sessions: SessionSummary[] };
    const theirsIds = theirsBody.sessions.map((s) => s.id);
    assert.ok(theirsIds.includes(other.id));
    assert.ok(!theirsIds.includes(own.id));
  });

  // #463: GET /sessions?state=draft returns only the caller's drafts, even
  // when both drafts anchor to the same visible node.
  test("GET /sessions?state=draft returns only the caller's drafts", async () => {
    const own = await createDraftSession(db, SOLO, nodeId);
    const other = await createDraftSession(db, "U2", nodeId);

    const res = await call(makeIdentity(SOLO), "GET", "/sessions?state=draft");
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { sessions: SessionSummary[] };
    const ids = body.sessions.map((s) => s.id);
    assert.ok(ids.includes(own.id));
    assert.ok(!ids.includes(other.id));
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

  // Renaming is owner-only (auth/session-access.ts's sessionAccess "message"
  // tier); a session owned by someone else on a node the caller CAN see
  // (the fixture's project node has no ACL) is visible but forbidden --
  // 403, not 404, since the caller already knows it exists (it shows up in
  // the node's Relace tab).
  test("PATCH /sessions/:id 403s for a session owned by someone else on a visible node", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2"), "PATCH", `/sessions/${session.id}`, { name: "Nope" });
    assert.equal(res.statusCode, 403);
  });

  // A session anchored to a node the caller cannot see at all is hidden
  // entirely -- 404, same "non-members do not see it AT ALL" rule
  // auth/node-access.ts applies to the node itself.
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

  // State transitions are the "stop" tier (owner or manage scope);
  // makeIdentity's default scope is "write", below manage, so a visible
  // session owned by someone else is forbidden, not hidden.
  test("POST /sessions/:id/state 403s for a session owned by someone else without manage scope", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2"), "POST", `/sessions/${session.id}/state`, { state: "closed" });
    assert.equal(res.statusCode, 403);
  });

  test("POST /sessions/:id/state succeeds for someone else with manage scope", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2", "manage"), "POST", `/sessions/${session.id}/state`, {
      state: "closed",
    });
    assert.equal(res.statusCode, 200);
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

  // Reading is the "read" tier: anyone who can see the anchor node may read
  // resume-info for a session owned by someone else (same rule as reading
  // the chat/events) -- the fixture's project node has no ACL.
  test("GET /sessions/:id/resume-info is readable by anyone who can see the anchor node", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2"), "GET", `/sessions/${session.id}/resume-info`);
    assert.equal(res.statusCode, 200);
  });

  // #329: a server-generated suspend (here via the transport-disconnect GC
  // backstop) must be distinguishable from an agent-written one at resume time.
  test("GET /sessions/:id/resume-info reports generated_by 'server' and the reason after a server-side suspend", async () => {
    const session = await createSession(db, SOLO, {
      node_id: nodeId,
      session_type: "interactive_task",
    });
    await closeSessionIfRunning(db, session.id, "disconnect");

    const res = await call(makeIdentity(SOLO), "GET", `/sessions/${session.id}/resume-info`);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as SessionResumeInfo;
    assert.equal(body.generated_by, "server");
    assert.equal(body.reason, "disconnect");
  });

  // The restart indicator (#342, SessionChat header): GET /sessions/:id/
  // signals is a plain read of sessionSignals, gated by the same "read"
  // tier as resume-info (auth/session-access.ts).
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

  test("GET /sessions/:id/signals is readable by anyone who can see the anchor node", async () => {
    const session = await createSession(db, SOLO, { node_id: nodeId, session_type: "interactive_task" });
    const res = await call(makeIdentity("U2"), "GET", `/sessions/${session.id}/signals`);
    assert.equal(res.statusCode, 200);
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
