// The central server and session content (#458, #456 follow-up). The
// central server holds the session record only: it never opens a
// content.db, never writes a summary, and never suspends a thread a device
// drives. What content it still has is the legacy graph-db rows an older
// sidecar wrote -- and that sidecar reads them back from the same rows.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
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
  LegacyGraphContentStore,
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
    assert.equal(after?.handoff_inline ?? null, null);
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

  it("an older sidecar reads back the events it sent: the central store is the legacy rows", async () => {
    const session = await createSession(db, "U1", {
      node_id: NODE,
      session_type: "interactive_task",
      runner: "claude",
      host_id: "old-mac",
    });
    const store = sessionContentStoreForProcess();
    assert.ok(store instanceof LegacyGraphContentStore);
    // What POST /sessions/:id/events writes (api/sessions.ts's legacy route).
    await new LegacyGraphContentStore(db).appendEvents(session.id, null, [
      { kind: "user_message", payload: { text: "ahoj", source: "chat" } },
    ]);
    await db.execute({ sql: "UPDATE sessions SET handoff_inline = ? WHERE id = ?", args: ["# Shrnutí", session.id] });

    // What GET /sessions/:id/events and resume-info read on the central server.
    setSessionRuntimeForTesting(null);
    const events = await getSessionRuntime().listEvents(session.id);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["user_message"],
    );
    assert.match(events[0].created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal((await store.getContent(session.id))?.handoff_inline, "# Shrnutí");
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
