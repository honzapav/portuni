// #465: the scenarios the session store exists for, spec
// docs/superpowers/specs/2026-09-22-web-session-state-design.md ("Scenario
// tests"). They run against the real store, the real selectors and the real
// api.ts functions, with `fetch` replaced by recorded answers -- the rule
// they hold is not "the helper folds correctly" but "a fact about a thread
// has one place, and every surface reads the same value at the same moment".
//
// The scenarios of #466 (a refusal restoring the record, the sentAt rule)
// live with that issue; 1, 3, 4, 5 and 6 are here.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSessionStore } from "../apps/web/src/lib/session-store.js";
import type { SessionStore } from "../apps/web/src/lib/session-store.js";
import {
  selectSession,
  selectNodeThreads,
  selectShownThread,
  selectMountedThreads,
  selectRunningCount,
  selectThreadsByNode,
  selectLiveStates,
} from "../apps/web/src/lib/session-selectors.js";
import {
  bindSessionStore,
  fetchNodePersistentSessions,
  startDraftThread,
  renamePersistentSession,
  closePersistentSession,
  deletePersistentSession,
  patchSessionRunnerInstance,
} from "../apps/web/src/api.js";
import type { SessionSummary } from "../apps/web/src/types.js";
import type { SessionStateMessage } from "../apps/web/src/lib/sessions-client.js";

function row(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
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
    name: "Vlákno",
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

function frame(overrides: Partial<SessionStateMessage> & { session_id: string }): SessionStateMessage {
  return { state: "running", waiting_since: null, node_id: "n1", ...overrides };
}

// The recorded backend: one answer per `METHOD /path`, and the calls it was
// actually asked for, so a scenario can assert "without a refetch".
type Answer = { status?: number; body: unknown };
let answers: Map<string, Answer>;
let calls: string[];
let realFetch: typeof globalThis.fetch;
let store: SessionStore;

function answer(key: string, body: unknown, status = 200): void {
  answers.set(key, { body, status });
}

beforeEach(() => {
  answers = new Map();
  calls = [];
  store = createSessionStore();
  bindSessionStore(store);
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, "");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${path}`;
    calls.push(key);
    const found = answers.get(key);
    if (!found) return new Response(`no recorded answer for ${key}`, { status: 500 });
    return new Response(JSON.stringify(found.body), {
      status: found.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  bindSessionStore(null);
});

describe("scenario 1: the picked instance survives a frame, a node switch and a switch back", () => {
  it("keeps the answer's instance on the record throughout", async () => {
    store.putMany([
      row({ id: "d1", state: "draft", name: "Nové vlákno", last_active_at: "2026-09-22 10:05:00" }),
      row({ id: "s2", state: "running", last_active_at: "2026-09-22 10:01:00" }),
    ]);

    answer("PATCH /sessions/d1", { runner: "claude", instance_id: "tempo" });
    await patchSessionRunnerInstance("d1", { runner: "claude", instance_id: "tempo" });
    assert.equal(selectSession(store, "d1")?.instance_id, "tempo");

    // A frame for the OTHER thread on the same node: it may not touch d1,
    // and it may not undo the picked instance on s2's own record either.
    store.applyFrame(frame({ session_id: "s2", state: "running", waiting_since: "2026-09-22 10:06:00" }));
    assert.equal(selectSession(store, "d1")?.instance_id, "tempo");

    // Node switch and back: the shown thread is re-derived from the same
    // records, so there is nothing to lose.
    assert.equal(selectShownThread(store, "n2", null), null);
    const shown = selectShownThread(store, "n1", "d1");
    assert.equal(shown?.id, "d1");
    assert.equal(shown?.instance_id, "tempo");
    assert.equal(shown?.runner, "claude");
  });
});

describe("scenario 3: a draft is a thread from the moment the server answers", () => {
  it("is in the node's threads at once and stays one record through promotion", async () => {
    answer("POST /sessions", {
      session: row({ id: "d1", state: "draft", name: "Nové vlákno", last_active_at: "2026-09-22 10:05:00" }),
      run: null,
    });
    const draft = await startDraftThread("n1");
    assert.equal(draft.id, "d1");
    assert.deepEqual(
      selectNodeThreads(store, "n1").map((s) => s.id),
      ["d1"],
    );

    // The first message promotes it: the frame says "running" and carries
    // the name the server gave it.
    store.applyFrame(frame({ session_id: "d1", state: "running", name: "Rozpočet Q4" }));
    assert.equal(store.snapshot().size, 1);
    assert.equal(selectSession(store, "d1")?.state, "running");
    assert.equal(selectSession(store, "d1")?.name, "Rozpočet Q4");

    // The refetch the frame triggers carries the same row; still one record,
    // with the server's name and the runner the draft had.
    answer("GET /nodes/n1/sessions", {
      sessions: [row({ id: "d1", state: "running", name: "Rozpočet Q4", instance_id: "tempo" })],
    });
    await fetchNodePersistentSessions("n1");
    assert.equal(store.snapshot().size, 1);
    assert.equal(selectSession(store, "d1")?.name, "Rozpočet Q4");
    assert.equal(selectSession(store, "d1")?.instance_id, "tempo");
    assert.deepEqual(
      selectNodeThreads(store, "n1").map((s) => s.id),
      ["d1"],
    );
  });
});

describe("scenario 4: a rename shows everywhere without a refetch", () => {
  it("writes the answer's row, and asks the server for nothing else", async () => {
    store.put(row({ id: "s1", name: "Staré jméno" }));
    answer("POST /sessions/s1/rename", row({ id: "s1", name: "Nové jméno", name_is_custom: true }));

    await renamePersistentSession("s1", "Nové jméno");

    // What a chat header reads, what a sidebar row reads: one record.
    assert.equal(selectSession(store, "s1")?.name, "Nové jméno");
    assert.equal(selectNodeThreads(store, "n1")[0].name, "Nové jméno");
    assert.equal(selectLiveStates(store).s1.name, "Nové jméno");
    assert.deepEqual(calls, ["POST /sessions/s1/rename"]);
  });
});

describe("scenario 5: a frame for an unknown thread is a partial record the list completes", () => {
  it("creates the stub and replaces it whole on the refetch", async () => {
    store.applyFrame(frame({ session_id: "x9", state: "running", name: "Běží jinde" }));
    const partial = selectSession(store, "x9");
    assert.equal(partial?.partial, true);
    assert.equal(partial?.runner, null);
    assert.equal(selectRunningCount(store), 1);
    assert.deepEqual(
      selectNodeThreads(store, "n1").map((s) => s.id),
      ["x9"],
    );

    answer("GET /nodes/n1/sessions", {
      sessions: [row({ id: "x9", name: "Běží jinde", runner: "claude", instance_id: "tempo" })],
    });
    await fetchNodePersistentSessions("n1");
    const complete = selectSession(store, "x9");
    assert.equal(complete?.partial, undefined);
    assert.equal(complete?.runner, "claude");
    assert.equal(complete?.instance_id, "tempo");
    assert.equal(store.snapshot().size, 1);
  });
});

describe("scenario 6: a closed thread leaves every selector", () => {
  it("drops a thread the server reports closed", async () => {
    store.putMany([row({ id: "s1" }), row({ id: "s2", last_active_at: "2026-09-22 09:00:00" })]);
    answer("POST /sessions/s1/close", { session: row({ id: "s1", state: "closed", closed_at: "2026-09-22 11:00:00" }) });

    await closePersistentSession("s1");

    assert.equal(selectSession(store, "s1")?.state, "closed");
    assert.deepEqual(
      selectNodeThreads(store, "n1").map((s) => s.id),
      ["s2"],
    );
    assert.deepEqual(
      selectThreadsByNode(store, ["n1"]).n1.map((s) => s.id),
      ["s2"],
    );
    assert.deepEqual(
      selectMountedThreads(store, ["n1"], "s1").map((s) => s.id),
      ["s2"],
    );
    assert.equal(selectShownThread(store, "n1", "s1")?.id, "s2");
    assert.equal(selectRunningCount(store), 1);
  });

  it("drops a deleted draft, record and all", async () => {
    store.put(row({ id: "d1", state: "draft" }));
    answer("DELETE /sessions/d1", { deleted: true });

    await deletePersistentSession("d1");

    assert.equal(selectSession(store, "d1"), undefined);
    assert.deepEqual(selectNodeThreads(store, "n1"), []);
    assert.deepEqual(selectMountedThreads(store, ["n1"], "d1"), []);
    assert.equal(selectShownThread(store, "n1", "d1"), null);
    assert.equal(Object.keys(selectLiveStates(store)).length, 0);
  });
});
