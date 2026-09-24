// DbSessionStore (apps/server/domain/runner/store.ts): the RECORD half of
// a thread -- tasks and runs. The transcript and the two content columns
// are the device's and live behind SessionContentStore
// (test/session-content-store.test.ts), per
// docs/superpowers/specs/2026-09-22-local-sessions-design.md.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("DbSessionStore", () => {
  it("creates a runner session with the task fields and reads it back", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);

    const session = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      runner: "claude",
      instance_id: "work",
      host_id: "this-machine",
    });

    assert.equal(session.session_type, "interactive_task");
    // #456, #462: the brief is content; the record has no such field.
    assert.equal("brief" in session, false);
    assert.equal(session.runner, "claude");
    assert.equal(session.instance_id, "work");
    assert.equal(session.host_id, "this-machine");
    assert.equal(session.waiting_since, null);
    assert.equal(session.state, "running");

    const fetched = await store.getSession(session.id);
    assert.equal(fetched?.id, session.id);
    assert.equal(await store.getSession("nonexistent-id"), null);
  });

  it("patchSession transitions state through the existing state machine and sets other fields", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);
    const session = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      runner: "claude",
      instance_id: null,
      host_id: null,
    });

    const waiting = await store.patchSession(session.id, { waiting_since: "2026-09-12T10:00:00.000Z" });
    assert.equal(waiting.waiting_since, "2026-09-12T10:00:00.000Z");
    assert.equal(waiting.state, "running");

    const suspended = await store.patchSession(session.id, {
      state: "suspended",
      handoff_path: "/mirror/HANDOFF.md",
      handoff_hash: "abc123",
    });
    assert.equal(suspended.state, "suspended");
    assert.equal(suspended.handoff_path, "/mirror/HANDOFF.md");
    assert.equal(suspended.handoff_hash, "abc123");

    // Invalid transition (suspended -> archived is not allowed) still
    // throws, same as domain/sessions.ts's own state machine.
    await assert.rejects(() => store.patchSession(session.id, { state: "archived" }));
  });

  it("createRun/patchRun/listRuns/liveRun track run lifecycle", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);
    const session = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      runner: "claude",
      instance_id: null,
      host_id: null,
    });

    assert.equal(await store.liveRun(session.id), null);

    const run1 = await store.createRun({
      session_id: session.id,
      runner: "claude",
      instance_id: null,
      host_id: null,
    });
    assert.equal(run1.session_id, session.id);
    assert.equal(run1.ended_at, null);

    const live = await store.liveRun(session.id);
    assert.equal(live?.id, run1.id);

    const ended = await store.patchRun(run1.id, {
      ended_at: new Date().toISOString(),
      end_reason: "completed",
      agent_session_id: "claude-conv-1",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    assert.equal(ended.end_reason, "completed");
    assert.equal(ended.agent_session_id, "claude-conv-1");
    assert.equal(ended.usage, JSON.stringify({ input_tokens: 10, output_tokens: 20 }));
    assert.equal(await store.liveRun(session.id), null);

    const run2 = await store.createRun({
      session_id: session.id,
      runner: "claude",
      instance_id: null,
      host_id: null,
      resumed_from_run_id: run1.id,
      agent_session_id: "claude-conv-1",
    });
    assert.equal(run2.resumed_from_run_id, run1.id);

    const runs = await store.listRuns(session.id);
    assert.deepEqual(
      runs.map((r) => r.id),
      [run1.id, run2.id],
    );
  });

  it("deleting the session cascades to its runs", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);
    const session = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      runner: "claude",
      instance_id: null,
      host_id: null,
    });
    await store.createRun({ session_id: session.id, runner: "claude", instance_id: null, host_id: null });

    await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [session.id] });

    const runs = await db.execute({ sql: "SELECT * FROM session_runs WHERE session_id = ?", args: [session.id] });
    assert.equal(runs.rows.length, 0);
  });
});
