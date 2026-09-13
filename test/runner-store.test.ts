// DbSessionStore (apps/server/domain/runner/store.ts): the runner batch's
// persistence layer for tasks, runs and the canonical event log. See
// docs/superpowers/specs/2026-09-12-runner-and-session-design.md.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import type { CanonicalEvent } from "../apps/server/domain/runner/types.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("DbSessionStore", () => {
  it("creates a runner session with the task fields and reads it back", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);

    const session = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      brief: "Fix the sync bug",
      runner: "claude",
      instance_id: "work",
      host_id: "this-machine",
    });

    assert.equal(session.session_type, "interactive_task");
    assert.equal(session.brief, "Fix the sync bug");
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
      brief: null,
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
      brief: null,
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

  it("appendEvents assigns monotonic seq per session, including across interleaved calls", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);
    const session = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      brief: null,
      runner: "claude",
      instance_id: null,
      host_id: null,
    });
    const run = await store.createRun({ session_id: session.id, runner: "claude", instance_id: null, host_id: null });

    const userMsg: CanonicalEvent = { kind: "user_message", payload: { text: "hi", source: "chat" } };
    const assistantMsg: CanonicalEvent = { kind: "assistant_message", payload: { text: "hello" } };

    // Two batches "interleaved": issued concurrently, each appending one
    // event, on the same session -- must not collide on seq.
    const [seqsA, seqsB] = await Promise.all([
      store.appendEvents(session.id, run.id, [userMsg]),
      store.appendEvents(session.id, run.id, [assistantMsg]),
    ]);
    const allSeqs = [...seqsA, ...seqsB].sort((a, b) => a - b);
    assert.deepEqual(allSeqs, [1, 2]);

    // A multi-event batch in one call gets consecutive seqs.
    const seqsC = await store.appendEvents(session.id, run.id, [userMsg, assistantMsg, userMsg]);
    assert.deepEqual(seqsC, [3, 4, 5]);

    const events = await store.listEvents(session.id);
    assert.equal(events.length, 5);
    assert.deepEqual(
      events.map((e) => e.seq),
      [1, 2, 3, 4, 5],
    );
  });

  it("listEvents supports after and limit", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);
    const session = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      brief: null,
      runner: "claude",
      instance_id: null,
      host_id: null,
    });
    const run = await store.createRun({ session_id: session.id, runner: "claude", instance_id: null, host_id: null });
    for (let i = 0; i < 5; i++) {
      await store.appendEvents(session.id, run.id, [{ kind: "user_message", payload: { text: `msg ${i}`, source: "chat" } }]);
    }

    const afterTwo = await store.listEvents(session.id, { after: 2 });
    assert.deepEqual(
      afterTwo.map((e) => e.seq),
      [3, 4, 5],
    );

    const limited = await store.listEvents(session.id, { limit: 2 });
    assert.deepEqual(
      limited.map((e) => e.seq),
      [1, 2],
    );

    const afterAndLimit = await store.listEvents(session.id, { after: 1, limit: 2 });
    assert.deepEqual(
      afterAndLimit.map((e) => e.seq),
      [2, 3],
    );
  });

  it("caps oversized payloads and marks tool_call truncated", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);
    const session = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      brief: null,
      runner: "claude",
      instance_id: null,
      host_id: null,
    });
    const run = await store.createRun({ session_id: session.id, runner: "claude", instance_id: null, host_id: null });

    const hugeText = "x".repeat(70 * 1024);
    const [assistantSeq] = await store.appendEvents(session.id, run.id, [
      { kind: "assistant_message", payload: { text: hugeText } },
    ]);
    const [toolSeq] = await store.appendEvents(session.id, run.id, [
      {
        kind: "tool_call",
        payload: {
          tool_use_id: "t1",
          tool: "Bash",
          category: "command",
          title: "Run tests",
          input_summary: "y".repeat(2 * 1024),
          status: "completed",
          output_excerpt: "z".repeat(10 * 1024),
          truncated: false,
        },
      },
    ]);

    const events = await store.listEvents(session.id);
    const assistantRow = events.find((e) => e.seq === assistantSeq)!;
    const assistantPayload = JSON.parse(assistantRow.payload) as { text: string };
    assert.ok(Buffer.byteLength(assistantPayload.text, "utf8") <= 64 * 1024);

    const toolRow = events.find((e) => e.seq === toolSeq)!;
    const toolPayload = JSON.parse(toolRow.payload) as {
      output_excerpt: string;
      input_summary: string;
      truncated: boolean;
    };
    assert.ok(Buffer.byteLength(toolPayload.output_excerpt, "utf8") <= 8 * 1024);
    assert.ok(Buffer.byteLength(toolPayload.input_summary, "utf8") <= 1024);
    assert.equal(toolPayload.truncated, true);
  });

  it("deleting the session cascades to its runs and events", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);
    const session = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      brief: null,
      runner: "claude",
      instance_id: null,
      host_id: null,
    });
    const run = await store.createRun({ session_id: session.id, runner: "claude", instance_id: null, host_id: null });
    await store.appendEvents(session.id, run.id, [{ kind: "user_message", payload: { text: "hi", source: "chat" } }]);

    await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [session.id] });

    const runs = await db.execute({ sql: "SELECT * FROM session_runs WHERE session_id = ?", args: [session.id] });
    const events = await db.execute({ sql: "SELECT * FROM session_events WHERE session_id = ?", args: [session.id] });
    assert.equal(runs.rows.length, 0);
    assert.equal(events.rows.length, 0);
  });
});
