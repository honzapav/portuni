import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSessionStore } from "../apps/web/src/lib/session-store.js";
import {
  selectSession,
  selectNodeThreads,
  selectShownThread,
  selectMountedThreads,
  selectRunningCount,
} from "../apps/web/src/lib/session-selectors.js";
import type { SessionSummary } from "../apps/web/src/types.js";
import type { SessionStateMessage } from "../apps/web/src/lib/sessions-client.js";

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

describe("createSessionStore: put/putMany/remove", () => {
  it("put makes the row readable via get", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1" }));
    assert.equal(store.get("s1")?.id, "s1");
  });

  it("putMany adds every row", () => {
    const store = createSessionStore();
    store.putMany([row({ id: "s1" }), row({ id: "s2" })]);
    assert.deepEqual([...store.snapshot().keys()].sort(), ["s1", "s2"]);
  });

  it("remove drops the row", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1" }));
    store.remove("s1");
    assert.equal(store.get("s1"), undefined);
    assert.equal(store.snapshot().size, 0);
  });

  it("remove of an id not in the store is a no-op, no notify", () => {
    const store = createSessionStore();
    let notified = 0;
    store.subscribe(() => notified++);
    store.remove("nope");
    assert.equal(notified, 0);
  });
});

describe("createSessionStore: reference stability", () => {
  it("put keeps the existing reference when every field is equal", () => {
    const store = createSessionStore();
    const first = row({ id: "s1" });
    store.put(first);
    const before = store.get("s1");
    store.put(row({ id: "s1" })); // a different object, same fields
    assert.equal(store.get("s1"), before);
  });

  it("put replaces the reference when a field differs", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1", name: "old" }));
    const before = store.get("s1");
    store.put(row({ id: "s1", name: "new" }));
    assert.notEqual(store.get("s1"), before);
    assert.equal(store.get("s1")?.name, "new");
  });
});

describe("createSessionStore: applyFrame", () => {
  const frame = (overrides: Partial<SessionStateMessage> & { session_id: string }): SessionStateMessage => ({
    session_id: overrides.session_id,
    state: "running",
    waiting_since: null,
    node_id: "n1",
    ...overrides,
  });

  it("folds state, waiting_since and name into the record, leaving runner, instance and model", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1", runner: "claude", instance_id: "osobni", model: "opus", state: "running", name: "Task" }));
    store.applyFrame(frame({ session_id: "s1", state: "suspended", waiting_since: "2026-09-22 10:05:00", name: "Renamed" }));
    const updated = store.get("s1");
    assert.equal(updated?.state, "suspended");
    assert.equal(updated?.waiting_since, "2026-09-22 10:05:00");
    assert.equal(updated?.name, "Renamed");
    assert.equal(updated?.runner, "claude");
    assert.equal(updated?.instance_id, "osobni");
    assert.equal(updated?.model, "opus");
  });

  it("leaves the name alone when the frame does not carry one", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1", name: "Task" }));
    store.applyFrame(frame({ session_id: "s1", state: "suspended" }));
    assert.equal(store.get("s1")?.name, "Task");
  });

  it("a frame for an unknown id creates a partial stub, completed by the next put", () => {
    const store = createSessionStore();
    store.applyFrame(frame({ session_id: "s9", state: "running", waiting_since: null, node_id: "n1" }));
    const stub = store.get("s9");
    assert.equal(stub?.partial, true);
    assert.equal(stub?.state, "running");
    assert.equal(stub?.node_id, "n1");

    store.put(row({ id: "s9", name: "Real name", runner: "claude" }));
    const completed = store.get("s9");
    assert.equal(completed?.partial, undefined);
    assert.equal(completed?.name, "Real name");
    assert.equal(completed?.runner, "claude");
  });
});

describe("createSessionStore: subscribe", () => {
  it("fires once per change and not on an equal put", () => {
    const store = createSessionStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified++);
    store.put(row({ id: "s1", name: "a" }));
    assert.equal(notified, 1);
    store.put(row({ id: "s1", name: "a" })); // equal, no notify
    assert.equal(notified, 1);
    store.put(row({ id: "s1", name: "b" }));
    assert.equal(notified, 2);
    unsubscribe();
    store.put(row({ id: "s1", name: "c" }));
    assert.equal(notified, 2);
  });

  it("putMany notifies once for a batch, not once per row", () => {
    const store = createSessionStore();
    let notified = 0;
    store.subscribe(() => notified++);
    store.putMany([row({ id: "s1" }), row({ id: "s2" })]);
    assert.equal(notified, 1);
  });
});

describe("selectors", () => {
  it("selectSession reads the record by id", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1" }));
    assert.equal(selectSession(store, "s1")?.id, "s1");
    assert.equal(selectSession(store, "nope"), undefined);
  });

  it("selectNodeThreads orders waiting, running, suspended, draft, restricted to the node and to threads", () => {
    const store = createSessionStore();
    store.putMany([
      row({ id: "running1", node_id: "n1", state: "running", waiting_since: null }),
      row({ id: "waiting1", node_id: "n1", state: "running", waiting_since: "2026-09-22 10:00:00" }),
      row({ id: "suspended1", node_id: "n1", state: "suspended" }),
      row({ id: "draft1", node_id: "n1", state: "draft" }),
      row({ id: "other-node", node_id: "n2", state: "running" }),
      row({ id: "hand-opened", node_id: "n1", state: "running", cli: "claude" }),
      row({ id: "chat", node_id: "n1", state: "running", session_type: "interactive_chat" }),
    ]);
    const ids = selectNodeThreads(store, "n1").map((s) => s.id);
    assert.deepEqual(ids, ["waiting1", "running1", "suspended1", "draft1"]);
  });

  it("selectNodeThreads returns the same reference when the store is unchanged", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1", node_id: "n1", state: "running" }));
    const first = selectNodeThreads(store, "n1");
    const second = selectNodeThreads(store, "n1");
    assert.equal(first, second);
  });

  it("selectNodeThreads returns a stable reference across a put on a different node", () => {
    const store = createSessionStore();
    store.put(row({ id: "s1", node_id: "n1", state: "running" }));
    const first = selectNodeThreads(store, "n1");
    store.put(row({ id: "s2", node_id: "n2", state: "running" }));
    const second = selectNodeThreads(store, "n1");
    assert.equal(first, second);
  });

  it("selectShownThread picks the requested thread while it is live, else the newest live one", () => {
    const store = createSessionStore();
    store.putMany([
      row({ id: "old", node_id: "n1", state: "suspended" }),
      row({ id: "new", node_id: "n1", state: "running" }),
    ]);
    assert.equal(selectShownThread(store, "n1", "old")?.id, "old");
    assert.equal(selectShownThread(store, "n1", "gone")?.id, "new");
    assert.equal(selectShownThread(store, null, "old"), null);
  });

  it("selectMountedThreads mounts every chat-eligible thread of every open node, shown thread included", () => {
    const store = createSessionStore();
    store.putMany([
      row({ id: "a", node_id: "n1", state: "running" }),
      row({ id: "b", node_id: "n1", state: "closed" }),
      row({ id: "c", node_id: "n2", state: "draft" }),
    ]);
    const mounted = selectMountedThreads(store, ["n2", "n1"], "a").map((s) => s.id);
    assert.deepEqual(mounted, ["c", "a"]);
  });

  it("selectRunningCount counts running records across the whole store", () => {
    const store = createSessionStore();
    store.putMany([
      row({ id: "a", state: "running" }),
      row({ id: "b", state: "suspended" }),
      row({ id: "c", state: "running" }),
    ]);
    assert.equal(selectRunningCount(store), 2);
  });
});
