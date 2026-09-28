// #487: a dropped or idle MCP connection never suspends a thread the runner
// drives. mcp/transport.ts's onclose (a genuine client disconnect and its own
// 30-minute idle GC alike) calls closeSessionIfRunning, which is the one
// place that distinction can be made -- in BOTH workspaces: the device branch
// (personal workspace, and the sync agent whenever it serves an MCP
// connection itself) and the central branch, which has had the rule since
// #458. What stays suspendable is a hand-opened CLI or a connector session
// whose only life was that connection.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
import { installTestContentDb, clearTestContentDb } from "./helpers/content-db.js";
import type { DbClient } from "../apps/server/infra/db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { closeSessionIfRunning, createSession, getSession } from "../apps/server/domain/sessions.js";
import { lookupSpawnSessionForBind } from "../apps/server/mcp/session-persistence.js";

async function openRun(db: DbClient, sessionId: string): Promise<string> {
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO session_runs (id, session_id, runner, instance_id, host_id, started_at)
          VALUES (?, ?, 'claude', NULL, 'this-device', ?)`,
    args: [id, sessionId, new Date().toISOString()],
  });
  return id;
}

async function runIsOpen(db: DbClient, runId: string): Promise<boolean> {
  const res = await db.execute({ sql: "SELECT ended_at FROM session_runs WHERE id = ?", args: [runId] });
  return res.rows.length === 1 && res.rows[0].ended_at === null;
}

describe("a closed MCP connection and a runner-driven thread (#487)", () => {
  it("leaves the thread running, its run open and its log untouched -- idle GC and disconnect alike", async () => {
    const { db, nodeId } = await makeSharedDb();
    const { content } = await installTestContentDb();
    setDbForTesting(db);
    try {
      const task = await createSession(db, "U1", {
        node_id: nodeId,
        session_type: "interactive_task",
        runner: "claude",
        host_id: "this-device",
      });
      const runId = await openRun(db, task.id);
      await content.appendEvents(task.id, runId, [
        { kind: "run_started", payload: { run_id: runId } },
      ]);

      // The transport's own 30-minute idle GC: the agent simply had not
      // called a Portuni tool for half an hour while working on files.
      await closeSessionIfRunning(db, task.id, "idle");
      // And a genuine disconnect of the same connection.
      await closeSessionIfRunning(db, task.id, "disconnect");

      const after = await getSession(db, task.id);
      assert.equal(after?.state, "running");
      assert.equal(after?.handoff_path, null);
      assert.equal(after?.handoff_hash, null);
      assert.ok(await runIsOpen(db, runId), "the run the runtime holds stays open");
      assert.equal((await content.getContent(task.id))?.handoff_inline ?? null, null);
      const kinds = (await content.listEvents(task.id)).map((e) => e.kind);
      assert.deepEqual(kinds, ["run_started"], "no run_ended and no state_changed in the log");
    } finally {
      setDbForTesting(null);
      clearTestContentDb();
    }
  });

  it("leaves a thread with an open run alone even when its runner column is not set yet", async () => {
    const { db, nodeId } = await makeSharedDb();
    const { content } = await installTestContentDb();
    setDbForTesting(db);
    try {
      const task = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
      const runId = await openRun(db, task.id);

      await closeSessionIfRunning(db, task.id, "disconnect");

      assert.equal((await getSession(db, task.id))?.state, "running");
      assert.ok(await runIsOpen(db, runId));
      assert.equal((await content.getContent(task.id))?.handoff_inline ?? null, null);
    } finally {
      setDbForTesting(null);
      clearTestContentDb();
    }
  });

  it("still suspends a hand-opened CLI -- that connection was the whole session -- with no summary (#497)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const { content } = await installTestContentDb();
    setDbForTesting(db);
    try {
      const cli = await createSession(db, "U1", {
        node_id: nodeId,
        session_type: "interactive_task",
        cli: "claude",
      });

      await closeSessionIfRunning(db, cli.id, "disconnect");

      assert.equal((await getSession(db, cli.id))?.state, "suspended");
      assert.equal((await content.getContent(cli.id))?.handoff_inline ?? null, null, "no summary is written");
    } finally {
      setDbForTesting(null);
      clearTestContentDb();
    }
  });

  // The other half of the same bug: a suspended row is exactly what
  // lookupSpawnSessionForBind refuses (SESSION_BIND_REFUSED), so the agent
  // that lost its connection lost its Portuni tools for good. A thread left
  // running is bindable again.
  it("lets the agent's MCP client reconnect to the same thread -- no SESSION_BIND_REFUSED", async () => {
    const { db, nodeId } = await makeSharedDb();
    await installTestContentDb();
    setDbForTesting(db);
    try {
      const task = await createSession(db, "U1", {
        node_id: nodeId,
        session_type: "interactive_task",
        runner: "claude",
        host_id: "this-device",
      });
      await openRun(db, task.id);

      await closeSessionIfRunning(db, task.id, "idle");

      const lookup = await lookupSpawnSessionForBind(db, { userId: "U1" }, task.id);
      assert.equal(lookup.kind, "bindable");
      assert.equal(lookup.kind === "bindable" ? lookup.row.id : null, task.id);
    } finally {
      setDbForTesting(null);
      clearTestContentDb();
    }
  });

  // Team workspace: the thread's record lives on the central server, and the
  // device's own front door (mcp/agent-transport.ts) proxies the agent's
  // connection to it -- its onclose closes the upstream client and nothing
  // else, so the only suspend that can follow is the central branch's, which
  // skips a device-driven thread.
  it("is the same on the central server: a dropped upstream connection leaves the thread running", async () => {
    const { db, nodeId } = await makeSharedDb();
    setDbForTesting(db);
    try {
      const task = await createSession(db, "U1", {
        node_id: nodeId,
        session_type: "interactive_task",
        runner: "claude",
        host_id: "honzas-mac",
      });
      const runId = await openRun(db, task.id);

      await closeSessionIfRunning(db, task.id, "idle", { central: true });

      assert.equal((await getSession(db, task.id))?.state, "running");
      assert.ok(await runIsOpen(db, runId));
    } finally {
      setDbForTesting(null);
    }
  });

  it("the sync agent's own MCP front door has no suspend path at all", async () => {
    const src = await readFile(new URL("../apps/server/mcp/agent-transport.ts", import.meta.url), "utf8");
    assert.ok(
      !src.includes("closeSessionIfRunning"),
      "agent-transport.ts's onclose must only close its upstream client, never suspend a record",
    );
  });
});
