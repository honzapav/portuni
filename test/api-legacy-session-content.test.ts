// The central server's legacy session content routes (#456 follow-up):
// what a sync agent downloads on its first boot so the history of the
// threads it ran stays readable. GET /sessions/legacy-content?host_id=…
// lists the caller's own threads that ran on that device and still have
// legacy content; GET /sessions/:id/legacy-content serves one of them,
// owner-only, its events a page at a time.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { ulid } from "ulid";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DbClient } from "../apps/server/infra/db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { insertIgnore } from "../apps/server/infra/sql.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import { createSession } from "../apps/server/domain/sessions.js";
import { LegacyGraphContentStore } from "../apps/server/domain/runner/store-content.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { LegacySessionContentPage } from "../apps/server/shared/api-types.js";
import { makeSharedDb } from "./helpers/shared-db.js";

function identity(userId: string, scope: RequestIdentity["globalScope"] = "admin"): RequestIdentity {
  return { userId, email: `${userId}@x.com`, name: userId, globalScope: scope, groups: [], groupIds: [], via: "env" };
}

async function get(who: RequestIdentity, path: string): Promise<{ status: number; body: unknown }> {
  const captured = { status: 0, body: "" };
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
  (res as unknown as { writeHead: (code: number) => void }).writeHead = (code: number) => {
    captured.status = code;
  };
  (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
    if (data) captured.body += data;
  };
  await routeApiRequest(req, res, new URL(`http://localhost${path}`), who);
  return { status: captured.status, body: captured.body ? JSON.parse(captured.body) : null };
}

describe("central legacy session content", () => {
  let db: DbClient;
  let nodeId: string;
  const ids: Record<string, string> = {};

  before(async () => {
    const shared = await makeSharedDb();
    db = shared.db;
    nodeId = shared.nodeId;
    setDbForTesting(db);
    await db.execute({
      sql: insertIgnore(db.dialect, "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)"),
      args: ["U2", "u2@x.com", "U2"],
    });
    const legacy = new LegacyGraphContentStore(db);
    const mk = async (user: string, host: string | null, withContent: boolean) => {
      const s = await createSession(db, user, {
        node_id: nodeId,
        session_type: "interactive_task",
        runner: "claude",
        host_id: host,
      });
      if (withContent) {
        await legacy.appendEvents(s.id, null, [
          { kind: "user_message", payload: { text: "ahoj", source: "chat" } },
          { kind: "assistant_message", payload: { text: "zdravím" } },
        ]);
        await db.execute({ sql: "UPDATE sessions SET brief = ? WHERE id = ?", args: ["ahoj", s.id] });
      }
      return s.id;
    };
    ids.mine = await mk("U1", "mac-a", true);
    ids.mineOtherHost = await mk("U1", "mac-b", true);
    ids.mineNoContent = await mk("U1", "mac-a", false);
    ids.theirs = await mk("U2", "mac-a", true);
    // Started without a host, ran on mac-a: the run names the device.
    ids.mineByRun = await mk("U1", null, true);
    await db.execute({
      sql: `INSERT INTO session_runs (id, session_id, runner, instance_id, host_id, started_at)
            VALUES (?, ?, 'claude', NULL, 'mac-a', ?)`,
      args: [ulid(), ids.mineByRun, new Date().toISOString()],
    });
  });

  after(() => setDbForTesting(null));

  test("lists the caller's own threads that ran on the device and still have legacy content", async () => {
    const res = await get(identity("U1"), "/sessions/legacy-content?host_id=mac-a");
    assert.equal(res.status, 200);
    const listed = (res.body as { sessions: string[] }).sessions;
    assert.deepEqual([...listed].sort(), [ids.mine, ids.mineByRun].sort());
  });

  test("never lists another user's thread, admin included", async () => {
    const res = await get(identity("U2", "admin"), "/sessions/legacy-content?host_id=mac-a");
    assert.deepEqual((res.body as { sessions: string[] }).sessions, [ids.theirs]);
  });

  test("the list needs the device", async () => {
    const res = await get(identity("U1"), "/sessions/legacy-content");
    assert.equal(res.status, 400);
  });

  test("serves a thread's legacy content to its owner, raw", async () => {
    const res = await get(identity("U1"), `/sessions/${ids.mine}/legacy-content`);
    assert.equal(res.status, 200);
    const page = res.body as LegacySessionContentPage;
    assert.equal(page.brief, "ahoj");
    assert.deepEqual(
      page.events.map((e) => [e.seq, e.kind]),
      [
        [1, "user_message"],
        [2, "assistant_message"],
      ],
    );
    assert.equal(typeof page.events[0].payload, "string");
    assert.equal(page.next_after, null);

    const after = await get(identity("U1"), `/sessions/${ids.mine}/legacy-content?after=1`);
    assert.deepEqual(
      (after.body as LegacySessionContentPage).events.map((e) => e.seq),
      [2],
    );
  });

  test("another user's thread is SESSION_NOT_FOUND, admin included", async () => {
    const res = await get(identity("U2", "admin"), `/sessions/${ids.mine}/legacy-content`);
    assert.equal(res.status, 404);
    assert.equal((res.body as { code: string }).code, "SESSION_NOT_FOUND");
  });
});
