// The central server and session content (#458, #456 follow-up). The
// central server holds the session record only: it never opens a
// content.db, never writes a summary, and never suspends a thread a device
// drives. Since the central migration (#462) it holds no content at all:
// the graph db has no session_events and no brief/handoff_inline columns.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
import { tableExistsSql } from "../apps/server/infra/sql.js";
import type { DbClient } from "../apps/server/infra/db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { getDeviceContentDb, setDeviceContentDbForTesting } from "../apps/server/infra/device-content-db.js";
import {
  closeSessionIfRunning,
  suspendStaleRunningSessionsOnBoot,
  createSession,
  getSession,
} from "../apps/server/domain/sessions.js";
import {
  CentralNoContentStore,
  sessionContentStoreForProcess,
} from "../apps/server/domain/runner/store-content.js";
import { getSessionRuntime, setSessionRuntimeForTesting } from "../apps/server/boot/session-runtime.js";

// makeSharedDb's project node, owned by its test user U1.
const NODE = "N000000000000000000000PROJ";

async function graphDb(): Promise<DbClient> {
  return (await makeSharedDb()).db;
}

async function openRun(db: DbClient, sessionId: string, hostId: string): Promise<string> {
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO session_runs (id, session_id, runner, instance_id, host_id, started_at)
          VALUES (?, ?, 'claude', NULL, ?, ?)`,
    args: [id, sessionId, hostId, new Date().toISOString()],
  });
  return id;
}

describe("central server: no content.db, no summary, no suspending a device's thread", () => {
  let db: DbClient;
  const prevAuth = process.env.PORTUNI_AUTH_MODE;

  before(async () => {
    db = await graphDb();
    setDbForTesting(db);
    // Nothing installed: a content.db opened here would be a real file.
    setDeviceContentDbForTesting(null);
    process.env.PORTUNI_AUTH_MODE = "google";
  });

  after(() => {
    if (prevAuth === undefined) delete process.env.PORTUNI_AUTH_MODE;
    else process.env.PORTUNI_AUTH_MODE = prevAuth;
    setDbForTesting(null);
    setSessionRuntimeForTesting(null);
  });

  it("refuses to open a content.db", async () => {
    await assert.rejects(() => getDeviceContentDb(), /central server never opens one/);
  });

  it("a dropped MCP connection leaves a device's task thread running", async () => {
    const task = await createSession(db, "U1", {
      node_id: NODE,
      session_type: "interactive_task",
      runner: "claude",
      host_id: "honzas-mac",
    });
    await openRun(db, task.id, "honzas-mac");

    await closeSessionIfRunning(db, task.id, "disconnect");

    const after = await getSession(db, task.id);
    assert.equal(after?.state, "running");
    assert.equal(after?.handoff_hash, null);
  });

  it("a dropped connection of a hand-opened CLI suspends its record, with no summary", async () => {
    const cli = await createSession(db, "U1", { node_id: NODE, session_type: "interactive_task", cli: "claude" });

    await closeSessionIfRunning(db, cli.id, "disconnect");

    const after = await getSession(db, cli.id);
    assert.equal(after?.state, "suspended");
    assert.equal(after?.handoff_path, null);
    assert.equal(after?.handoff_hash, null);
    assert.equal("handoff_inline" in (after ?? {}), false);
  });

  it("the boot sweep suspends only the connection sessions and leaves the device's threads running", async () => {
    const task = await createSession(db, "U1", {
      node_id: NODE,
      session_type: "interactive_task",
      runner: "claude",
      host_id: "honzas-mac",
    });
    // A thread with no runner but a run still open on a device counts too.
    const withRun = await createSession(db, "U1", { node_id: NODE, session_type: "interactive_task" });
    await openRun(db, withRun.id, "honzas-mac");
    const cli = await createSession(db, "U1", { node_id: NODE, session_type: "interactive_task", cli: "claude" });

    const suspended = await suspendStaleRunningSessionsOnBoot(db);

    assert.ok(suspended >= 1);
    assert.equal((await getSession(db, task.id))?.state, "running");
    assert.equal((await getSession(db, withRun.id))?.state, "running");
    const cliAfter = await getSession(db, cli.id);
    assert.equal(cliAfter?.state, "suspended");
    assert.equal(cliAfter?.handoff_hash, null);
  });

  it("holds no content: the events answer empty, clearing is a no-op, an append is refused", async () => {
    const session = await createSession(db, "U1", {
      node_id: NODE,
      session_type: "interactive_task",
      runner: "claude",
      host_id: "honzas-mac",
    });
    const store = sessionContentStoreForProcess();
    assert.ok(store instanceof CentralNoContentStore);

    // What GET /sessions/:id/events and resume-info read on the central server.
    setSessionRuntimeForTesting(null);
    assert.deepEqual(await getSessionRuntime().listEvents(session.id), []);
    assert.equal(await store.getContent(session.id), null);
    assert.deepEqual(await store.setContent(session.id, { handoff_inline: null }), {
      session_id: session.id,
      brief: null,
      handoff_inline: null,
    });
    await store.deleteContent(session.id);
    await assert.rejects(
      () => store.appendEvents(session.id, null, [{ kind: "user_message", payload: { text: "ahoj", source: "chat" } }]),
      /holds no session content/,
    );
    await assert.rejects(() => store.setContent(session.id, { brief: "ahoj" }), /holds no session content/);
    const tables = await db.execute({ sql: tableExistsSql(db.dialect), args: ["session_events"] });
    assert.equal(tables.rows.length, 0);
  });
});

describe("personal workspace: the same two suspends still write the device's summary", () => {
  it("closeSessionIfRunning off the central server suspends a running thread with a summary", async () => {
    const db = await graphDb();
    const { installTestContentDb, clearTestContentDb } = await import("./helpers/content-db.js");
    const { content } = await installTestContentDb();
    setDbForTesting(db);
    try {
      const task = await createSession(db, "U1", { node_id: NODE, session_type: "interactive_task", runner: "claude" });
      await closeSessionIfRunning(db, task.id, "disconnect", { central: false });
      const after = await getSession(db, task.id);
      assert.equal(after?.state, "suspended");
      assert.ok(after?.handoff_hash, "the device wrote a summary");
      assert.ok((await content.getContent(task.id))?.handoff_inline);
    } finally {
      setDbForTesting(null);
      clearTestContentDb();
    }
  });
});
