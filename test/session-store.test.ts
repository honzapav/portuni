// #464: the window's session store, its selectors and the rule the hook
// depends on -- every selector's result is reference-stable while the store
// has not changed. There is no component runner in this repo, so these are
// the tests that hold `useSyncExternalStore`'s contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSessionStore } from "../apps/web/src/lib/session-store.js";
import type { SessionStore } from "../apps/web/src/lib/session-store.js";
import {
  selectorCacheSize,
  selectNodeRecordIds,
  selectSession,
  selectNodeThreads,
  selectShownThread,
  selectMountedThreads,
  selectRunningCount,
  selectThreadsByNode,
  selectLiveStates,
} from "../apps/web/src/lib/session-selectors.js";
import type { SessionSummary } from "../apps/web/src/types.js";
import type { SessionStateMessage } from "../apps/web/src/lib/sessions-client.js";

function row(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    node_id: "node-a",
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
  return { state: "running", waiting_since: null, node_id: "node-a", ...overrides };
}

function counted(store: SessionStore): () => number {
  let calls = 0;
  store.subscribe(() => {
    calls += 1;
  });
  return () => calls;
}

describe("session store", () => {
  it("put, putMany, get and remove", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1" }));
    store.putMany([row({ id: "s2" }), row({ id: "s3" })]);
    assert.equal(store.snapshot().size, 3);
    assert.equal(store.get("s2")?.id, "s2");
    store.remove("s2");
    assert.equal(store.get("s2"), undefined);
    assert.deepEqual([...store.snapshot().keys()], ["s1", "s3"]);
  });

  it("an equal put keeps the existing record reference and notifies nobody", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1" }));
    const before = store.get("s1");
    const snapshotBefore = store.snapshot();
    const calls = counted(store);
    store.put(row({ id: "s1" }));
    assert.equal(store.get("s1"), before);
    assert.equal(store.snapshot(), snapshotBefore);
    assert.equal(calls(), 0);
    store.put(row({ id: "s1", name: "Přejmenováno" }));
    assert.notEqual(store.get("s1"), before);
    assert.equal(store.get("s1")?.name, "Přejmenováno");
    assert.equal(calls(), 1);
  });

  it("putMany notifies once for a batch and not at all when nothing changed", () => {
    const store = createSessionStore();
    store.putMany([row({ id: "s1" }), row({ id: "s2" })]);
    const calls = counted(store);
    store.putMany([row({ id: "s1" }), row({ id: "s2" })]);
    assert.equal(calls(), 0);
    store.putMany([row({ id: "s1" }), row({ id: "s2", state: "suspended" })]);
    assert.equal(calls(), 1);
  });

  it("remove notifies only for a record that was there", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1" }));
    const calls = counted(store);
    store.remove("nope");
    assert.equal(calls(), 0);
    store.remove("s1");
    assert.equal(calls(), 1);
  });

  it("a subscriber that unsubscribed stops hearing changes", () => {
    const store = createSessionStore();
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.put(row({ id: "s1" }));
    off();
    store.put(row({ id: "s1", state: "suspended" }));
    assert.equal(calls, 1);
  });

  it("applyFrame folds state, waiting and name and keeps runner, instance and model", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1", runner: "claude", instance_id: "inst-1", model: "opus", effort: "high" }));
    store.applyFrame(frame({ session_id: "s1", state: "running", waiting_since: "2026-09-22 10:05:00", name: "Nový název" }));
    const s = store.get("s1");
    assert.equal(s?.state, "running");
    assert.equal(s?.waiting_since, "2026-09-22 10:05:00");
    assert.equal(s?.name, "Nový název");
    assert.equal(s?.runner, "claude");
    assert.equal(s?.instance_id, "inst-1");
    assert.equal(s?.model, "opus");
    assert.equal(s?.effort, "high");
  });

  it("a frame carrying no name leaves the name alone and an unchanged frame notifies nobody", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1", name: "Původní" }));
    const calls = counted(store);
    store.applyFrame(frame({ session_id: "s1" }));
    assert.equal(store.get("s1")?.name, "Původní");
    assert.equal(calls(), 0);
  });

  it("a frame for an unknown id makes a partial record the next put replaces", () => {
    const store = createSessionStore();
    store.applyFrame(frame({ session_id: "s9", state: "running", node_id: "node-b", name: "Odjinud" }));
    const stub = store.get("s9");
    assert.equal(stub?.partial, true);
    assert.equal(stub?.state, "running");
    assert.equal(stub?.node_id, "node-b");
    assert.equal(stub?.name, "Odjinud");
    assert.equal(stub?.runner, null);
    // A frame folded into the stub keeps it partial.
    store.applyFrame(frame({ session_id: "s9", state: "running", node_id: "node-b", waiting_since: "2026-09-22 11:00:00" }));
    assert.equal(store.get("s9")?.partial, true);
    // The list refetch completes it: no `partial` marker, the server's row.
    store.put(row({ id: "s9", node_id: "node-b", name: "Odjinud", runner: "claude" }));
    const complete = store.get("s9");
    assert.equal(complete?.partial, undefined);
    assert.equal(complete?.runner, "claude");
    assert.equal(complete?.waiting_since, null);
  });
});

describe("session store selectors", () => {
  it("selectSession reads the record by id", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1" }));
    assert.equal(selectSession(store, "s1")?.id, "s1");
    assert.equal(selectSession(store, "nope"), undefined);
    assert.equal(selectSession(store, null), undefined);
  });

  it("selectNodeThreads lists the node's steerable threads, waiting then running then suspended then draft", () => {
    const store = createSessionStore();
    store.putMany([
      row({ id: "running-old", last_active_at: "2026-09-22 09:00:00" }),
      row({ id: "running-new", last_active_at: "2026-09-22 12:00:00" }),
      row({ id: "waiting", waiting_since: "2026-09-22 08:00:00", last_active_at: "2026-09-22 08:00:00" }),
      row({ id: "suspended", state: "suspended", last_active_at: "2026-09-22 13:00:00" }),
      row({ id: "draft", state: "draft", last_active_at: "2026-09-22 14:00:00" }),
      row({ id: "closed", state: "closed" }),
      row({ id: "cli", cli: "claude", runner: null }),
      row({ id: "runner-bound", cli: "claude", state: "suspended", last_active_at: "2026-09-22 10:00:00" }),
      row({ id: "chat", session_type: "interactive_chat" }),
      row({ id: "other-node", node_id: "node-b" }),
    ]);
    assert.deepEqual(
      selectNodeThreads(store, "node-a").map((s) => s.id),
      ["waiting", "running-new", "running-old", "suspended", "runner-bound", "draft"],
    );
    assert.deepEqual(selectNodeThreads(store, "node-z"), []);
    assert.deepEqual(selectNodeThreads(store, null), []);
  });

  it("selectShownThread prefers the requested thread and falls back to the newest live one", () => {
    const store = createSessionStore();
    store.putMany([
      row({ id: "s1", last_active_at: "2026-09-22 09:00:00" }),
      row({ id: "s2", last_active_at: "2026-09-22 12:00:00" }),
    ]);
    assert.equal(selectShownThread(store, "node-a", "s1")?.id, "s1");
    assert.equal(selectShownThread(store, "node-a", "gone")?.id, "s2");
    assert.equal(selectShownThread(store, "node-a", null)?.id, "s2");
    assert.equal(selectShownThread(store, "node-z", null), null);
  });

  it("selectMountedThreads walks the open nodes in order and adds the shown thread its list is missing", () => {
    const store = createSessionStore();
    store.putMany([
      row({ id: "a1" }),
      row({ id: "b1", node_id: "node-b" }),
      row({ id: "loose", node_id: null }),
    ]);
    assert.deepEqual(
      selectMountedThreads(store, ["node-b", "node-a"], null).map((s) => s.id),
      ["b1", "a1"],
    );
    assert.deepEqual(
      selectMountedThreads(store, ["node-a"], "loose").map((s) => s.id),
      ["a1", "loose"],
    );
    // A closed thread is never mounted, asked for or not.
    store.put(row({ id: "done", state: "closed", node_id: null }));
    assert.deepEqual(
      selectMountedThreads(store, ["node-a"], "done").map((s) => s.id),
      ["a1"],
    );
  });

  it("a partial record is not in the node's threads until a put completes it", () => {
    // The initial burst of frames carries every running session the caller
    // can see, a hand-opened CLI session included; a stub from one of those
    // is neither a sub-row nor the node's shown thread, and it never mounts
    // a chat.
    const store = createSessionStore();
    store.applyFrame(frame({ session_id: "cli-1", state: "running" }));
    assert.equal(store.get("cli-1")?.partial, true);
    assert.deepEqual(selectNodeThreads(store, "node-a"), []);
    assert.equal(selectShownThread(store, "node-a", "cli-1"), null);
    assert.deepEqual(selectMountedThreads(store, ["node-a"], "cli-1"), []);
    // ...and it is heard of, so the footer counts it.
    assert.equal(selectRunningCount(store), 1);

    // The refetch that frame triggered completes it; now it is a thread.
    store.put(row({ id: "cli-1" }));
    assert.deepEqual(selectNodeThreads(store, "node-a").map((t) => t.id), ["cli-1"]);
    assert.equal(selectShownThread(store, "node-a", "cli-1")?.id, "cli-1");
    assert.deepEqual(selectMountedThreads(store, ["node-a"], "cli-1").map((t) => t.id), ["cli-1"]);
  });

  it("a frame with no name leaves the name absent instead of blanking it", () => {
    // Version skew: a server older than the frame's name field must not
    // overlay `""` onto the name Přehled and the Relace tab already show.
    const store = createSessionStore();
    store.applyFrame(frame({ session_id: "s1", state: "running" }));
    assert.equal("name" in (store.get("s1") ?? {}), false);
    assert.equal(selectLiveStates(store).s1.name, undefined);
    store.applyFrame(frame({ session_id: "s1", state: "running", name: "Vlákno" }));
    assert.equal(selectLiveStates(store).s1.name, "Vlákno");
  });

  it("closing a node drops its threads from the store and keeps the shown one", () => {
    const store = createSessionStore();
    store.putMany([
      row({ id: "a1" }),
      row({ id: "a2" }),
      row({ id: "b1", node_id: "node-b" }),
    ]);
    // What App.tsx's closeNode does: everything anchored on the node it
    // drops, except the thread still on screen.
    store.removeMany(selectNodeRecordIds(store, "node-a", "a2"));
    assert.deepEqual([...store.snapshot().keys()], ["a2", "b1"]);
    // With nothing to keep, the node leaves no record behind at all.
    store.removeMany(selectNodeRecordIds(store, "node-a", null));
    assert.deepEqual([...store.snapshot().keys()], ["b1"]);
  });

  it("selectRunningCount counts running records, a partial one included", () => {
    const store = createSessionStore();
    store.putMany([row({ id: "s1" }), row({ id: "s2", state: "suspended" })]);
    store.applyFrame(frame({ session_id: "elsewhere", state: "running", node_id: "node-x" }));
    assert.equal(selectRunningCount(store), 2);
    store.applyFrame(frame({ session_id: "s1", state: "suspended" }));
    assert.equal(selectRunningCount(store), 1);
  });
});

describe("session store selector reference stability", () => {
  // The rule useSyncExternalStore's getSnapshot depends on: an unchanged
  // store returns the very same value, and a change that does not touch
  // what a selector selects leaves its value alone too. An inline selector
  // building a fresh object per call is what makes React re-render until it
  // throws "Maximum update depth exceeded".
  function selectorsOf(store: SessionStore) {
    return {
      session: () => selectSession(store, "s1"),
      threads: () => selectNodeThreads(store, "node-a"),
      noThreads: () => selectNodeThreads(store, "node-empty"),
      nullNode: () => selectNodeThreads(store, null),
      shown: () => selectShownThread(store, "node-a", "s1"),
      mounted: () => selectMountedThreads(store, ["node-a", "node-b"], "s1"),
      noneMounted: () => selectMountedThreads(store, [], null),
      running: () => selectRunningCount(store),
      // #465's two additions: the sidebar's per-node map and the live-state
      // map the surfaces that fetch their own lists still take.
      byNode: () => selectThreadsByNode(store, ["node-a", "node-b"]),
      noNodes: () => selectThreadsByNode(store, []),
      liveStates: () => selectLiveStates(store),
    };
  }

  it("every selector returns the same reference twice against an unchanged store", () => {
    const store = createSessionStore();
    store.putMany([row({ id: "s1" }), row({ id: "s2", state: "suspended" }), row({ id: "b1", node_id: "node-b" })]);
    for (const [name, select] of Object.entries(selectorsOf(store))) {
      assert.equal(select(), select(), `${name} is not reference-stable`);
    }
  });

  it("an unrelated put leaves every selector's value alone", () => {
    const store = createSessionStore();
    store.putMany([row({ id: "s1" }), row({ id: "b1", node_id: "node-b" })]);
    const before = Object.fromEntries(
      Object.entries(selectorsOf(store)).map(([name, select]) => [name, select()]),
    );
    // Another node's thread, suspended, so even the running count is untouched.
    store.put(row({ id: "elsewhere", node_id: "node-x", state: "suspended" }));
    for (const [name, select] of Object.entries(selectorsOf(store))) {
      // liveStates is window-wide on purpose -- it is what tells the
      // surfaces that fetch their own lists (Přehled, the Relace tab) that
      // something, anywhere, changed -- so a new record is news for it.
      if (name === "liveStates") continue;
      assert.equal(select(), before[name], `${name} changed on an unrelated put`);
    }
    assert.notEqual(selectLiveStates(store), before.liveStates);
  });

  it("a relevant put changes the reference of the selectors that see it", () => {
    const store = createSessionStore();
    store.putMany([row({ id: "s1" }), row({ id: "b1", node_id: "node-b" })]);
    const before = Object.fromEntries(
      Object.entries(selectorsOf(store)).map(([name, select]) => [name, select()]),
    );
    store.put(row({ id: "s1", name: "Přejmenováno" }));
    const after = selectorsOf(store);
    assert.notEqual(after.session(), before.session);
    assert.notEqual(after.threads(), before.threads);
    assert.notEqual(after.shown(), before.shown);
    assert.notEqual(after.mounted(), before.mounted);
    assert.notEqual(after.byNode(), before.byNode);
    assert.notEqual(after.liveStates(), before.liveStates);
    // The node with no threads and the empty mount keep their references.
    assert.equal(after.noThreads(), before.noThreads);
    assert.equal(after.noneMounted(), before.noneMounted);
    assert.equal(after.noNodes(), before.noNodes);
  });

  it("a put that changes only last_active_at leaves the live-state map alone", () => {
    // The Relace tab and Přehled refetch on a change of this map; a list
    // refetch that touched nothing they read would re-trigger itself.
    const store = createSessionStore();
    store.put(row({ id: "s1" }));
    const before = selectLiveStates(store);
    store.put(row({ id: "s1", last_active_at: "2026-09-22 12:00:00" }));
    assert.equal(selectLiveStates(store), before);
  });

  it("a frame for another thread of the same node does not disturb the threads it does not touch", () => {
    const store = createSessionStore();
    store.putMany([row({ id: "s1" }), row({ id: "s2" })]);
    const s1Before = selectSession(store, "s1");
    store.applyFrame(frame({ session_id: "s2", state: "suspended" }));
    assert.equal(selectSession(store, "s1"), s1Before);
  });
});

describe("session store selector cache", () => {
  // The cache is bounded: one entry per selector key, whatever the
  // arguments. A window left open for a day switches threads and nodes
  // hundreds of times, and every one of those used to leave an entry
  // (keyed on the open-node set and the shown thread) behind forever.
  it("switching the shown thread N times leaves one cache entry per selector key", () => {
    const store = createSessionStore();
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    store.putMany(ids.map((id) => row({ id })));

    for (const id of ids) {
      selectMountedThreads(store, ["node-a"], id);
      selectThreadsByNode(store, ["node-a"]);
      selectShownThread(store, "node-a", id);
    }
    // nodeThreads:node-a, mounted, threadsByNode -- and nothing else.
    assert.equal(selectorCacheSize(store), 3);
  });

  it("opening and closing nodes leaves one entry per open-node-set selector", () => {
    const store = createSessionStore();
    store.putMany([row({ id: "a1" }), row({ id: "b1", node_id: "node-b" })]);
    const sets = [["node-a"], ["node-a", "node-b"], ["node-b"], ["node-a"]];
    for (const open of sets) {
      selectThreadsByNode(store, open);
      selectMountedThreads(store, open, null);
    }
    // mounted, threadsByNode, plus the per-node list of each node opened --
    // those are what the map and the mount set read side by side.
    assert.equal(selectorCacheSize(store), 4);
  });

  it("an empty open-node set costs no cache entry and is one shared reference", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1" }));
    assert.equal(selectMountedThreads(store, [], null), selectMountedThreads(store, [], null));
    assert.equal(selectThreadsByNode(store, []), selectThreadsByNode(store, []));
    assert.equal(selectorCacheSize(store), 0);
  });

  it("switching the shown thread back and forth keeps the mounted array's reference", () => {
    // The bound must not cost reference stability: the two threads of one
    // node mount the same rows, so React keeps every chat mounted.
    const store = createSessionStore();
    store.putMany([row({ id: "s1" }), row({ id: "s2" })]);
    const first = selectMountedThreads(store, ["node-a"], "s1");
    assert.equal(selectMountedThreads(store, ["node-a"], "s2"), first);
    assert.equal(selectMountedThreads(store, ["node-a"], "s1"), first);
  });
});

// The snapshot a fresh connection receives carries every running or
// suspended session. One store write per session re-rendered the app once
// per session and React threw "Maximum update depth exceeded" after 50.
describe("the connection burst", () => {
  it("applyFrames folds a whole burst in one notification", () => {
    const store = createSessionStore();
    const calls = counted(store);
    const burst = Array.from({ length: 200 }, (_, i) => frame({ session_id: `s${i}`, state: i % 2 ? "suspended" : "running" }));
    store.applyFrames(burst);
    assert.equal(calls(), 1);
    assert.equal(store.snapshot().size, 200);
    assert.equal(store.get("s1")?.state, "suspended");
  });

  it("applyFrames that changes nothing does not notify", () => {
    const store = createSessionStore();
    store.applyFrames([frame({ session_id: "s1" })]);
    const calls = counted(store);
    store.applyFrames([frame({ session_id: "s1" })]);
    assert.equal(calls(), 0);
  });
});
