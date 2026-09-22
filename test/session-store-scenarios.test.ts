// Scenario tests for #465 (docs/superpowers/specs/2026-09-22-web-session-
// state-design.md): the session store plus the api.ts functions api.ts
// binds it to, driven with a fake fetch that answers recorded requests --
// no React, no App.tsx. Each scenario is one of the numbered cases in the
// issue: the store is the only place a thread's facts live, and every
// surface (here: the selectors) reads the same record.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSessionStore, withOptimisticPatch } from "../apps/web/src/lib/session-store.js";
import { selectNodeThreads } from "../apps/web/src/lib/session-selectors.js";
import { clearsSentAt, runIsLiveFor, workingPhase, type ChatEvent } from "../apps/web/src/lib/session-chat.js";
import {
  bindSessionStore,
  deletePersistentSession,
  fetchNodePersistentSessions,
  patchSessionRunnerInstance,
  renamePersistentSession,
  startDraftThread,
} from "../apps/web/src/api.js";
import type { SessionSummary } from "../apps/web/src/types.js";

function row(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    id: overrides.id,
    node_id: "n1",
    user_id: "u1",
    session_type: "interactive_task",
    cli: null,
    instance_id: null,
    terminal_id: null,
    brief: null,
    runner: "claude",
    host_id: null,
    host_label: null,
    waiting_since: null,
    state: "running",
    name: "Session",
    name_is_custom: false,
    handoff_path: null,
    write_count: 0,
    model: null,
    effort: null,
    context_used_tokens: null,
    context_max_tokens: null,
    created_at: "2026-09-22 10:00:00",
    last_active_at: "2026-09-22 10:00:00",
    closed_at: null,
    ...overrides,
  };
}

type RecordedCall = { method: string; path: string; body: unknown };
type RecordedResponse = { response: unknown; status?: number };

// A queue of canned answers, consumed in the order api.ts's calls fire --
// every real call site here is a single, sequential await, so the order is
// deterministic. Restored after each test so a later file's tests don't
// inherit a patched global.
let originalFetch: typeof fetch;
let calls: RecordedCall[];
let queue: RecordedResponse[];

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = String(input).replace(/^\/api/, "");
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, body });
  const next = queue.shift();
  if (!next) throw new Error(`session-store-scenarios: unexpected fetch ${method} ${path}`);
  return Promise.resolve(new Response(JSON.stringify(next.response), { status: next.status ?? 200 }));
}

function queueResponse(response: unknown, status = 200): void {
  queue.push({ response, status });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as typeof fetch;
  calls = [];
  queue = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("session store scenarios (#465)", () => {
  it("scenario 1: an instance pick survives a live frame for another thread and a node switch", async () => {
    const store = createSessionStore();
    bindSessionStore(store);
    store.put(row({ id: "s1", node_id: "n1", state: "draft", runner: "claude", instance_id: null }));

    // Pick an instance; the server answers with the full row (the record
    // half of the device-local PATCH).
    queueResponse({ ...row({ id: "s1", node_id: "n1", state: "draft", runner: "claude", instance_id: "work" }) });
    await patchSessionRunnerInstance("s1", { runner: "claude", instance_id: "work" });
    assert.equal(store.get("s1")?.instance_id, "work");

    // A live frame for a DIFFERENT thread on the same node arrives --
    // folded into its own record, s1 is untouched (principle 3).
    store.applyFrame({ session_id: "s2", node_id: "n1", state: "running", waiting_since: null });
    assert.equal(store.get("s1")?.instance_id, "work");

    // "Node switch and back": reading a different node's threads, then s1's
    // node again -- a pure read, so nothing about s1 changes.
    selectNodeThreads(store, "n2");
    const backOnN1 = selectNodeThreads(store, "n1").find((s) => s.id === "s1");
    assert.equal(backOnN1?.instance_id, "work");
  });

  it("scenario 2 (#466): pick instance -> server refuses 409 -> record restored, error set", async () => {
    const store = createSessionStore();
    bindSessionStore(store);
    store.put(row({ id: "s1", node_id: "n1", state: "draft", runner: "claude", instance_id: null }));

    // SessionChat's handleRunnerChange: withOptimisticPatch puts the pick
    // right away, patchSessionRunnerInstance is the request it awaits.
    queueResponse({ error: "SESSION_NOT_DRAFT" }, 409);
    let composerError: string | null = null;
    await withOptimisticPatch(store, "s1", { instance_id: "work" }, () =>
      patchSessionRunnerInstance("s1", { runner: "claude", instance_id: "work" }),
    ).catch((e) => {
      composerError = `Runner a instanci se nepodařilo uložit: ${String(e)}`;
    });

    // The optimistic put is visible mid-flight (the picker shows the pick
    // at once); the refusal puts the prior record back.
    assert.equal(store.get("s1")?.instance_id, null);
    assert.match(composerError ?? "", /nepodařilo uložit/);
  });

  it("scenario 3: a draft becomes running through the live frame alone -- one record, server name throughout", async () => {
    const store = createSessionStore();
    bindSessionStore(store);

    queueResponse({
      session: row({ id: "d1", node_id: "n1", state: "draft", name: "Nový úkol" }),
      run: null,
    });
    const draft = await startDraftThread("n1");
    assert.equal(draft.state, "draft");
    assert.deepEqual(
      selectNodeThreads(store, "n1").map((s) => s.id),
      ["d1"],
    );

    // The first message promotes it server-side; this window only ever
    // learns of it via the session_state frame (no REST answer to put).
    store.applyFrame({ session_id: "d1", node_id: "n1", state: "running", waiting_since: null });

    assert.equal(store.snapshot().size, 1);
    const promoted = store.get("d1");
    assert.equal(promoted?.state, "running");
    // The frame carries no name, so the record keeps the server row's own.
    assert.equal(promoted?.name, "Nový úkol");
  });

  it("scenario 4: a rename reaches the record without a refetch", async () => {
    const store = createSessionStore();
    bindSessionStore(store);
    store.put(row({ id: "s1", node_id: "n1", name: "Old" }));

    queueResponse(row({ id: "s1", node_id: "n1", name: "New" }));
    await renamePersistentSession("s1", "New");

    assert.equal(store.get("s1")?.name, "New");
    // One call: the rename POST, nothing else -- no list refetch.
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      ["POST /sessions/s1/rename"],
    );
  });

  it("scenario 5: a frame for an unknown id creates a partial record; a list refetch completes it", async () => {
    const store = createSessionStore();
    bindSessionStore(store);

    store.applyFrame({ session_id: "s9", node_id: "n1", state: "running", waiting_since: null });
    const partial = store.get("s9");
    assert.equal(partial?.partial, true);
    assert.equal(partial?.name, "");

    queueResponse({ sessions: [row({ id: "s9", node_id: "n1", name: "Real name", state: "running" })] });
    await fetchNodePersistentSessions("n1");

    const completed = store.get("s9");
    assert.equal(completed?.partial, undefined);
    assert.equal(completed?.name, "Real name");
  });

  it("scenario 6: closing (deleting) a draft removes it from every selector", async () => {
    const store = createSessionStore();
    bindSessionStore(store);
    store.put(row({ id: "d1", node_id: "n1", state: "draft" }));
    assert.deepEqual(
      selectNodeThreads(store, "n1").map((s) => s.id),
      ["d1"],
    );

    queueResponse({ deleted: true });
    await deletePersistentSession("d1");

    assert.equal(store.get("d1"), undefined);
    assert.deepEqual(selectNodeThreads(store, "n1"), []);
  });

  it("scenario 7 (#466): send sets sentAt; a run_started racing the reply clears it; run_ended with error leaves no working row", () => {
    // Mirrors SessionChat's own sequence: handlePromptSubmit sets sentAt
    // before awaiting sessionsClient.message, then the live channel's
    // run_started can arrive before that send() promise ever resolves.
    let sentAt: number | null = null;
    let liveRunId: string | null = null;
    const events: ChatEvent[] = [];

    const startsRun = liveRunId === null;
    if (startsRun) sentAt = 1_000;
    assert.equal(sentAt, 1_000);

    // run_started arrives first -- clearsSentAt is the same predicate the
    // component's onEvent handler calls.
    events.push({ seq: 1, event: { kind: "run_started", payload: { run_id: "r1", runner: "claude", instance_id: null, resume: null } } });
    liveRunId = "r1";
    if (clearsSentAt("run_started")) sentAt = null;
    assert.equal(sentAt, null);

    // The send()'s own promise finally resolves here in the real
    // component -- nothing left for it to clear, sentAt is already null.

    // The run ends in error.
    events.push({ seq: 2, event: { kind: "run_ended", payload: { run_id: "r1", reason: "error", usage: null } } });
    if (clearsSentAt("run_ended")) sentAt = null;
    liveRunId = null;

    const runIsLive = runIsLiveFor(liveRunId, "suspended");
    const phase = runIsLive || sentAt !== null ? workingPhase(events, liveRunId, sentAt) : null;
    assert.equal(phase, null);
  });
});
