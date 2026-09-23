// #465: the scenarios the session store exists for, spec
// docs/superpowers/specs/2026-09-22-web-session-state-design.md ("Scenario
// tests"). They run against the real store, the real selectors and the real
// api.ts functions, with `fetch` replaced by recorded answers -- the rule
// they hold is not "the helper folds correctly" but "a fact about a thread
// has one place, and every surface reads the same value at the same moment".
//
// Scenarios 1, 3, 4, 5 and 6 come from #465; 2 and 7 (a refusal restoring
// the record, the send clock) from #466.

import { describe, it, beforeEach, afterEach } from "node:test";
import { readFileSync } from "node:fs";
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
  deleteDraftSession,
  patchSessionRunnerInstance,
} from "../apps/web/src/api.js";
import {
  nextSentAt,
  runIsLiveFor,
  workingPhase,
  type CanonicalEvent,
  type ChatEvent,
} from "../apps/web/src/lib/session-chat.js";
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

// #474: the sidebar's rename is the same server call as the chat header's,
// a draft included. Both tests run App.tsx's `workspaceRenameTask` step for
// step -- the optimistic put, the call, the previous record back on a
// refusal -- against the real store and the real api.ts.
describe("scenario 4b: a draft renamed in the sidebar survives the node's refetch", () => {
  it("renames on the server, so the row the refetch carries has the new name", async () => {
    store.put(row({ id: "d1", state: "draft", name: "Nové vlákno" }));
    answer("POST /sessions/d1/rename", row({ id: "d1", state: "draft", name: "Rozpočet", name_is_custom: true }));

    const before = store.get("d1")!;
    store.put({ ...before, name: "Rozpočet", name_is_custom: true });
    await renamePersistentSession("d1", "Rozpočet");
    assert.equal(selectSession(store, "d1")?.name, "Rozpočet");

    // Since #463 the node's list carries the caller's drafts: before the
    // rename went to the server this refetch wrote the old name back.
    answer("GET /nodes/n1/sessions", {
      sessions: [row({ id: "d1", state: "draft", name: "Rozpočet", name_is_custom: true })],
    });
    await fetchNodePersistentSessions("n1");

    assert.equal(selectSession(store, "d1")?.name, "Rozpočet");
    assert.equal(selectNodeThreads(store, "n1")[0].name, "Rozpočet");
    assert.equal(store.snapshot().size, 1);
    assert.deepEqual(calls, ["POST /sessions/d1/rename", "GET /nodes/n1/sessions"]);
  });

  it("puts the previous record back and names the reason when the rename is refused", async () => {
    store.put(row({ id: "d1", state: "draft", name: "Nové vlákno", instance_id: "work" }));
    answers.set("POST /sessions/d1/rename", { status: 409, body: { error: "session_closed" } });

    let detailError: string | null = null;
    const before = store.get("d1")!;
    store.put({ ...before, name: "Rozpočet", name_is_custom: true });
    await renamePersistentSession("d1", "Rozpočet").catch((e) => {
      store.put(before);
      detailError = `Vlákno se nepodařilo přejmenovat: ${String(e)}`;
    });

    const after = selectSession(store, "d1");
    assert.equal(after?.name, "Nové vlákno");
    assert.equal(after?.name_is_custom, false);
    // The restore is the whole previous record, not a patch of the
    // optimistic one.
    assert.equal(after?.instance_id, "work");
    assert.equal(after?.state, "draft");
    assert.equal(selectNodeThreads(store, "n1")[0].name, "Nové vlákno");
    assert.notEqual(detailError, null);
    assert.match(String(detailError), /Vlákno se nepodařilo přejmenovat/);
  });
});

describe("scenario 5: a frame for an unknown thread is a partial record the list completes", () => {
  it("creates the stub and replaces it whole on the refetch", async () => {
    store.applyFrame(frame({ session_id: "x9", state: "running", name: "Běží jinde" }));
    const partial = selectSession(store, "x9");
    assert.equal(partial?.partial, true);
    assert.equal(partial?.runner, null);
    assert.equal(selectRunningCount(store), 1);
    // Heard of, but not a thread yet (#475): the burst of frames carries
    // every running session the caller can see, a hand-opened CLI session
    // included, so the list is what says whether this one belongs in the
    // node's sub-rows at all.
    assert.deepEqual(selectNodeThreads(store, "n1"), []);

    answer("GET /nodes/n1/sessions", {
      sessions: [row({ id: "x9", name: "Běží jinde", runner: "claude", instance_id: "tempo" })],
    });
    await fetchNodePersistentSessions("n1");
    const complete = selectSession(store, "x9");
    assert.equal(complete?.partial, undefined);
    assert.equal(complete?.runner, "claude");
    assert.equal(complete?.instance_id, "tempo");
    assert.equal(store.snapshot().size, 1);
    assert.deepEqual(
      selectNodeThreads(store, "n1").map((s) => s.id),
      ["x9"],
    );
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

// #506: a draft can be deleted from the Stav list, the chat header and the
// Relace row, and every one of them is the same deleteDraftSession.
describe("scenario 6b: a draft deleted from any surface leaves the store at once", () => {
  it("removes the record before the DELETE lands and sends the DELETE", async () => {
    store.putMany([row({ id: "d1", state: "draft" }), row({ id: "s2", last_active_at: "2026-09-22 09:00:00" })]);
    answer("DELETE /sessions/d1", { deleted: true });
    // The signal the DELETE was sent: the recorded backend answered it.
    const recorded = globalThis.fetch;
    let answered!: () => void;
    const sent = new Promise<void>((resolve) => {
      answered = resolve;
    });
    globalThis.fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
      const res = await recorded(...args);
      answered();
      return res;
    }) as typeof globalThis.fetch;

    deleteDraftSession("d1");

    // Synchronously gone: the chat showing it closes and the shown thread
    // falls back to the node's other one, as with the sidebar's ×.
    assert.equal(selectSession(store, "d1"), undefined);
    assert.equal(selectShownThread(store, "n1", "d1")?.id, "s2");
    assert.deepEqual(selectMountedThreads(store, ["n1"], "d1").map((s) => s.id), ["s2"]);
    await sent;
    assert.deepEqual(calls, ["DELETE /sessions/d1"]);
    assert.equal(selectSession(store, "d1"), undefined);
  });

  it("is the one deletion the sidebar, the chat header and Relace call", () => {
    const src = (p: string) => readFileSync(new URL(`../apps/web/src/${p}`, import.meta.url), "utf8");
    for (const file of ["App.tsx", "components/SessionChat.tsx", "components/DetailPane.sessions.tsx"]) {
      const text = src(file);
      assert.match(text, /deleteDraftSession\(/, `${file} deletes a draft through deleteDraftSession`);
      assert.match(text, /threadCloseAction\(/, `${file} asks threadCloseAction what close does`);
      assert.doesNotMatch(text, /deletePersistentSession/, `${file} has no second draft deletion`);
    }
    // The Stav list hands its × to the same onCloseTask as the Uzly rows.
    assert.match(src("components/WorkspaceNodeList.tsx"), /function TaskList\([^)]*onCloseTask/);
  });
});

// #466: the two scenarios that belong to SessionChat reading its thread out
// of the store. Both run against the same pieces the component runs on --
// the store, api.ts and the pure helpers of lib/session-chat.ts -- so the
// rules are held here and not by the order of setState calls in a file no
// test runner mounts.
describe("scenario 2: a refused runner/instance change puts the record back", () => {
  it("restores the whole previous record and sets the composer error", async () => {
    store.put(row({ id: "d1", state: "draft", runner: "claude", instance_id: "work", model: "opus" }));
    answers.set("PATCH /sessions/d1", { status: 409, body: { error: "instance_busy" } });

    // SessionChat's handleRunnerChange, step for step.
    let composerError: string | null = null;
    const before = selectSession(store, "d1")!;
    store.put({ ...before, runner: "claude", instance_id: "tempo" });
    assert.equal(selectSession(store, "d1")?.instance_id, "tempo");

    await patchSessionRunnerInstance("d1", { runner: "claude", instance_id: "tempo" }).catch((e) => {
      store.put(before);
      composerError = `Runner a instanci se nepodařilo uložit: ${String(e)}`;
    });

    const after = selectSession(store, "d1");
    assert.equal(after?.instance_id, "work");
    assert.equal(after?.runner, "claude");
    // The restore is the previous record, not a patch of the optimistic one:
    // everything else it carried is still there.
    assert.equal(after?.model, "opus");
    assert.equal(after?.state, "draft");
    assert.notEqual(composerError, null);
    assert.match(String(composerError), /Runner a instanci se nepodařilo uložit/);
    // One record, and the sidebar reads the restored one too.
    assert.equal(store.snapshot().size, 1);
    assert.equal(selectNodeThreads(store, "n1")[0].instance_id, "work");
  });
});

describe("scenario 7: the send clock, a run that starts before the reply resolves and ends with an error", () => {
  // SessionChat's own state, as the pure helpers see it: the send clock,
  // the live run and the transcript. No component, no timers -- the clock
  // is an injected `now`.
  function chat() {
    const state = { sentAt: null as number | null, liveRunId: null as string | null, events: [] as ChatEvent[] };
    return {
      state,
      send(now: number) {
        state.sentAt = nextSentAt(state.sentAt, { kind: "send", liveRunId: state.liveRunId, now });
      },
      sendFailed() {
        state.sentAt = nextSentAt(state.sentAt, { kind: "send_failed" });
      },
      receive(event: CanonicalEvent) {
        state.events = [...state.events, { seq: state.events.length + 1, event }];
        state.sentAt = nextSentAt(state.sentAt, { kind: "event", event });
        if (event.kind === "run_started") state.liveRunId = event.payload.run_id;
        else if (event.kind === "run_ended") state.liveRunId = null;
      },
      // What the transcript shows at its end, exactly as the component
      // computes it (`phase` + `showWorking`, nothing streaming here).
      workingRow(sessionState: SessionSummary["state"]): string | null {
        const runIsLive = runIsLiveFor(state.liveRunId, sessionState);
        if (!runIsLive && state.sentAt === null) return null;
        return workingPhase(state.events, state.liveRunId, state.sentAt);
      },
    };
  }

  const started = (runId: string): CanonicalEvent => ({
    kind: "run_started",
    payload: { run_id: runId, runner: "claude", instance_id: null, resume: null },
  });
  const ended = (runId: string, reason: "error" | "completed"): CanonicalEvent => ({
    kind: "run_ended",
    payload: { run_id: runId, reason, usage: null },
  });
  const said = (text: string): CanonicalEvent => ({ kind: "user_message", payload: { text, source: "chat" } });

  it("shows Spouštím… from the send, then the run, then nothing once it ended", () => {
    const c = chat();
    assert.equal(c.workingRow("draft"), null);

    // Sent, reply not back yet: the clock is set before the await, so the
    // row is already on screen.
    c.send(1_000);
    assert.equal(c.workingRow("draft"), "starting");

    // run_started (and the promotion's own user_message) land while the
    // send is still in flight: the clock stops, the run takes over.
    c.receive(started("r1"));
    c.receive(said("Ahoj"));
    assert.equal(c.state.sentAt, null);
    assert.equal(c.workingRow("running"), "thinking");

    // The reply resolves now. It must not restart the clock -- a live run
    // announces itself, so a send into one sets nothing.
    c.send(1_200);
    assert.equal(c.state.sentAt, null);

    // The run ends with an error: nothing live, nothing starting, so the
    // working row is gone (and does not hang forever, which is the bug the
    // rule exists for).
    c.receive(ended("r1", "error"));
    assert.equal(c.state.liveRunId, null);
    assert.equal(c.state.sentAt, null);
    assert.equal(c.workingRow("suspended"), null);
    assert.equal(c.workingRow("running"), null);
  });

  it("clears the clock when the send itself fails", () => {
    const c = chat();
    c.send(1_000);
    assert.equal(c.workingRow("draft"), "starting");
    c.sendFailed();
    assert.equal(c.state.sentAt, null);
    assert.equal(c.workingRow("draft"), null);
  });

  it("clears the clock when a run ends without ever starting one of its own", () => {
    // A resume that dies at start: run_ended arrives with no run_started
    // this window saw. The clock stops on it all the same.
    const c = chat();
    c.send(1_000);
    c.receive(ended("r9", "error"));
    assert.equal(c.state.sentAt, null);
    assert.equal(c.workingRow("suspended"), null);
  });
});
