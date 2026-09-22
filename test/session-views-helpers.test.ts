import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sessionRowChip,
  sessionRowAccess,
  applyLiveSessionState,
  mergeLiveSessionStates,
  sortInboxSessions,
  countRunningSessions,
  applySessionStateFrame,
  pickOpenChatSession,
  hostDisplayName,
  requestChatSession,
  mergeSessionIntoNodeMap,
  applyNodeSessionsRefetch,
  dropPromotedDrafts,
  mergeDraftsIntoNodeMap,
  pruneNodeSessions,
  isChatSessionState,
  mountedChatSessions,
  isThreadSession,
  nodeRowActive,
  shownChatSessionId,
  applySessionUpdateToDrafts,
} from "../apps/web/src/lib/session-views.js";
import type { OverviewSessionRow, SessionState } from "../apps/web/src/types.js";
import type { SessionStateMessage } from "../apps/web/src/lib/sessions-client.js";

function overviewRow(overrides: Partial<OverviewSessionRow> & { id: string; user_id: string }): OverviewSessionRow {
  return {
    id: overrides.id,
    node_id: "n1",
    node_name: "Node",
    node_type: "project",
    user_id: overrides.user_id,
    session_type: "interactive_task",
    cli: "claude",
    instance_id: null,
    brief: "do the thing",
    runner: "claude",
    waiting_since: null,
    state: "running",
    name: "Session",
    name_is_custom: false,
    handoff_path: null,
    created_at: "2026-09-13 10:00:00",
    last_active_at: "2026-09-13 10:05:00",
    closed_at: null,
    ...overrides,
  };
}

describe("sessionRowChip", () => {
  it("running with no open question is 'Běží', pulsing", () => {
    const chip = sessionRowChip("running", null);
    assert.equal(chip.label, "Běží");
    assert.equal(chip.pulsing, true);
  });

  it("running with waiting_since is 'Čeká na mě'", () => {
    assert.equal(sessionRowChip("running", "2026-09-13 10:00:00").label, "Čeká na mě");
  });

  it("closed is 'Hotovo' and archived is 'Archiv', neither pulsing", () => {
    assert.equal(sessionRowChip("closed", null).label, "Hotovo");
    assert.equal(sessionRowChip("closed", null).pulsing, false);
    assert.equal(sessionRowChip("archived", null).label, "Archiv");
    assert.equal(sessionRowChip("archived", null).pulsing, false);
  });

  it("suspended is 'Pozastaveno', not pulsing", () => {
    const chip = sessionRowChip("suspended", null);
    assert.equal(chip.label, "Pozastaveno");
    assert.equal(chip.pulsing, false);
  });

  it("a draft's chip reads 'Nový' in both variants, so the header never repeats the draft's name", () => {
    assert.equal(sessionRowChip("draft", null, "row").label, "Nový");
    assert.equal(sessionRowChip("draft", null, "header").label, "Nový");
    assert.equal(sessionRowChip("draft", null).pulsing, false);
  });
});

describe("sessionRowAccess", () => {
  it("the owner can resume and pause/close", () => {
    const access = sessionRowAccess("U1", "U1", false);
    assert.equal(access.canResume, true);
    assert.equal(access.canPauseOrClose, true);
  });

  it("a manage-scoped non-owner can pause/close but not resume", () => {
    const access = sessionRowAccess("U1", "U2", true);
    assert.equal(access.canResume, false);
    assert.equal(access.canPauseOrClose, true);
  });

  it("a plain teammate can do neither", () => {
    const access = sessionRowAccess("U1", "U2", false);
    assert.equal(access.canResume, false);
    assert.equal(access.canPauseOrClose, false);
  });

  it("an unknown caller (meId null) can do neither", () => {
    const access = sessionRowAccess("U1", null, false);
    assert.equal(access.canResume, false);
    assert.equal(access.canPauseOrClose, false);
  });
});

describe("applyLiveSessionState / mergeLiveSessionStates", () => {
  const base = { id: "S1", state: "running" as const, waiting_since: null as string | null };

  it("overlays a matching live frame's state and waiting_since", () => {
    const live: Record<string, SessionStateMessage> = {
      S1: { session_id: "S1", state: "suspended", waiting_since: null, node_id: "n1" },
    };
    const merged = applyLiveSessionState(base, live);
    assert.equal(merged.state, "suspended");
  });

  it("overlays the frame's name when it carries one, and leaves the name alone otherwise", () => {
    const named = { ...base, name: "old" };
    const withName: Record<string, SessionStateMessage> = {
      S1: { session_id: "S1", state: "running", waiting_since: null, node_id: "n1", name: "new" },
    };
    assert.equal(applyLiveSessionState(named, withName).name, "new");
    const withoutName: Record<string, SessionStateMessage> = {
      S1: { session_id: "S1", state: "running", waiting_since: null, node_id: "n1" },
    };
    assert.equal(applyLiveSessionState(named, withoutName).name, "old");
  });

  it("returns the input unchanged when no live frame exists for this id", () => {
    const merged = applyLiveSessionState(base, {});
    assert.equal(merged, base);
  });

  it("mergeLiveSessionStates applies per-item, leaving unmatched items untouched", () => {
    const s2 = { id: "S2", state: "running" as const, waiting_since: null as string | null };
    const live: Record<string, SessionStateMessage> = {
      S1: { session_id: "S1", state: "running", waiting_since: "2026-09-13 10:00:00", node_id: "n1" },
    };
    const [m1, m2] = mergeLiveSessionStates([base, s2], live);
    assert.equal(m1.waiting_since, "2026-09-13 10:00:00");
    assert.equal(m2, s2);
  });
});

describe("sortInboxSessions", () => {
  it("orders waiting, then running, then suspended, all restricted to the caller", () => {
    const running1 = overviewRow({ id: "r1", user_id: "me" });
    const waiting1 = overviewRow({ id: "w1", user_id: "me", waiting_since: "2026-09-13 09:00:00" });
    const suspended1 = overviewRow({ id: "p1", user_id: "me", state: "suspended" });
    const notMine = overviewRow({ id: "x1", user_id: "someone-else" });
    const ordered = sortInboxSessions([running1, waiting1, notMine], [suspended1], "me");
    assert.deepEqual(
      ordered.map((s) => s.id),
      ["w1", "r1", "p1"],
    );
  });

  it("excludes sessions belonging to another user entirely", () => {
    const theirs = overviewRow({ id: "x1", user_id: "someone-else" });
    assert.deepEqual(sortInboxSessions([theirs], [], "me"), []);
  });

  it("returns nothing when the caller's id is unknown", () => {
    const mine = overviewRow({ id: "m1", user_id: "me" });
    assert.deepEqual(sortInboxSessions([mine], [], null), []);
  });
});

describe("countRunningSessions", () => {
  it("counts only running entries across the live-state map", () => {
    const states: Record<string, SessionStateMessage> = {
      S1: { session_id: "S1", state: "running", waiting_since: null, node_id: "n1" },
      S2: { session_id: "S2", state: "suspended", waiting_since: null, node_id: "n1" },
      S3: { session_id: "S3", state: "running", waiting_since: "2026-09-13 10:00:00", node_id: "n2" },
    };
    assert.equal(countRunningSessions(states), 2);
  });

  it("is zero for an empty map", () => {
    assert.equal(countRunningSessions({}), 0);
  });
});

describe("applySessionStateFrame", () => {
  const frame = (session_id: string, state: "running" | "suspended" | "closed", node_id: string | null = "N1") =>
    ({ session_id, state, waiting_since: null, node_id }) as SessionStateMessage;

  it("keeps live sessions and drops a closed one once nothing live shares its node", () => {
    let map = applySessionStateFrame({}, frame("A", "running"));
    map = applySessionStateFrame(map, frame("B", "running"));
    map = applySessionStateFrame(map, frame("A", "closed"));
    // B is still live on N1, so A's closed frame is kept (the selected-node
    // refresh needs to see it)...
    assert.deepEqual(Object.keys(map).sort(), ["A", "B"]);
    // ...until B closes too, when both go.
    map = applySessionStateFrame(map, frame("B", "closed"));
    assert.deepEqual(Object.keys(map), []);
  });

  it("drops a closed node-less session immediately", () => {
    const map = applySessionStateFrame({}, frame("C", "closed", null));
    assert.deepEqual(Object.keys(map), []);
  });
});

describe("pickOpenChatSession", () => {
  const s = (id: string, state: "running" | "suspended" | "closed" | "draft") => ({ id, state });
  it("prefers the requested session while it is live, else the newest live one, else nothing", () => {
    const list = [s("new", "running"), s("old", "suspended"), s("gone", "closed")];
    assert.equal(pickOpenChatSession(list, "old")?.id, "old");
    assert.equal(pickOpenChatSession(list, "gone")?.id, "new");
    assert.equal(pickOpenChatSession(list, null)?.id, "new");
    assert.equal(pickOpenChatSession([s("gone", "closed")], "gone"), null);
  });

  // #374: a draft (a thread opened but not yet promoted) counts as live
  // too -- it only ever reaches this helper merged in by the caller and
  // asked for by id, since the server never lists one on its own.
  it("finds a requested draft", () => {
    const list = [s("d1", "draft")];
    assert.equal(pickOpenChatSession(list, "d1")?.id, "d1");
  });
});

// A thread started while the node already shows another one ("Nový úkol"
// in the detail aside): the fresh thread is what the node must show, so
// starting one requests it by id. Without that the next pick still
// prefers the thread requested before and the chat snaps back to it.
describe("requestChatSession", () => {
  const s = (id: string, state: "running" | "draft") => ({ id, state });
  it("makes a freshly started thread the node's shown chat", () => {
    const next = requestChatSession({ n1: "old" }, { id: "d1", node_id: "n1" });
    assert.equal(next.n1, "d1");
    const list = [s("old", "running"), s("d1", "draft")];
    assert.equal(pickOpenChatSession(list, next.n1)?.id, "d1");
  });

  it("leaves the map alone for a session with no node", () => {
    assert.deepEqual(requestChatSession({ n1: "old" }, { id: "s2", node_id: null }), { n1: "old" });
  });
});

// --------------------------------------------------------------- #412
// The Práce sidebar's per-node thread map: a thread started from the node
// detail has to land in it without waiting for the open-node set to
// change, and a draft promoted by its first message must not fall out of
// it in the window between the promotion frame and the refetch it
// triggers.

type Thread = {
  id: string;
  node_id: string | null;
  state: "running" | "suspended" | "closed" | "draft";
  session_type: string;
  cli: string | null;
};
const thread = (id: string, state: Thread["state"], node_id: string | null = "n1"): Thread => ({
  id,
  node_id,
  state,
  session_type: "interactive_task",
  cli: null,
});

describe("mergeSessionIntoNodeMap", () => {
  it("adds a started thread under its node and dedupes by id", () => {
    const started = thread("s1", "running");
    const map = mergeSessionIntoNodeMap<Thread>({}, started);
    assert.deepEqual(map.n1.map((s) => s.id), ["s1"]);

    // Same id again (the refetch's own row) replaces in place, no duplicate.
    const again = mergeSessionIntoNodeMap(map, { ...started, state: "suspended" });
    assert.equal(again.n1.length, 1);
    assert.equal(again.n1[0].state, "suspended");

    // A second thread on the same node keeps the first.
    const two = mergeSessionIntoNodeMap(again, thread("s2", "running"));
    assert.deepEqual(two.n1.map((s) => s.id), ["s1", "s2"]);
  });

  it("ignores a node-less session", () => {
    const map = mergeSessionIntoNodeMap<Thread>({}, thread("s1", "running", null));
    assert.deepEqual(Object.keys(map), []);
  });
});

describe("applyNodeSessionsRefetch", () => {
  it("replaces one node's list with what is still open, leaving other nodes alone", () => {
    const prev = { n1: [thread("old", "running")], n2: [thread("other", "running", "n2")] };
    const next = applyNodeSessionsRefetch(prev, "n1", [
      thread("a", "running"),
      thread("b", "suspended"),
      thread("c", "closed"),
    ]);
    assert.deepEqual(next.n1.map((s) => s.id), ["a", "b"]);
    assert.deepEqual(next.n2.map((s) => s.id), ["other"]);
  });

  it("keeps threads only: a hand-opened CLI session has no sub-row (v2 rule 7)", () => {
    const next = applyNodeSessionsRefetch({}, "n1", [
      { ...thread("a", "running"), cli: "claude" },
      { ...thread("b", "running"), session_type: "interactive_chat" },
      thread("c", "running"),
    ]);
    assert.deepEqual(next.n1.map((s) => s.id), ["c"]);
  });
});

describe("isThreadSession (v2 rule 7)", () => {
  it("an interactive_task with no cli is a thread", () => {
    assert.equal(isThreadSession({ session_type: "interactive_task", cli: null }), true);
  });
  it("a hand-opened CLI session or a chat session is not", () => {
    assert.equal(isThreadSession({ session_type: "interactive_task", cli: "claude" }), false);
    assert.equal(isThreadSession({ session_type: "interactive_chat", cli: null }), false);
  });
});

describe("nodeRowActive (v2 rule 6)", () => {
  it("the selected node is active only while no thread is shown", () => {
    assert.equal(nodeRowActive("N1", "N1", null), true);
    assert.equal(nodeRowActive("N1", "N1", "S1"), false);
    assert.equal(nodeRowActive("N2", "N1", null), false);
    assert.equal(nodeRowActive("N1", null, null), false);
  });
});

describe("draft promotion race (#412)", () => {
  // The defect: the promotion frame dropped the local draft on arrival,
  // assuming the server-fetched list already had it -- it had not been
  // refetched, so the row disappeared. Modelled as the ordered calls the
  // listener makes: frame -> (refetch in flight) -> response.
  it("keeps the row visible from the promotion frame until the refetch carries it", () => {
    const draft = thread("d1", "draft");
    let byNode: Record<string, Thread[]> = { n1: [] };
    let drafts: Record<string, Thread> = { d1: draft };

    // Frame arrives: nothing is dropped yet, so the row is still there.
    let rendered = mergeDraftsIntoNodeMap(byNode, drafts);
    assert.deepEqual(rendered.n1.map((s) => s.id), ["d1"]);

    // The refetch resolves with the promoted row.
    const fetched = [thread("d1", "running")];
    byNode = applyNodeSessionsRefetch(byNode, "n1", fetched);
    drafts = dropPromotedDrafts(drafts, fetched);
    rendered = mergeDraftsIntoNodeMap(byNode, drafts);
    assert.deepEqual(rendered.n1.map((s) => s.id), ["d1"]);
    assert.equal(rendered.n1[0].state, "running");
    assert.deepEqual(Object.keys(drafts), []);
  });

  it("keeps tracking a draft the refetch did not carry, and never renders it twice", () => {
    const drafts = { d1: thread("d1", "draft") };
    // A refetch that raced the promotion (central had not committed it yet)
    // returns nothing for the node: the draft stays tracked locally.
    const stillDrafts = dropPromotedDrafts(drafts, []);
    assert.deepEqual(Object.keys(stillDrafts), ["d1"]);
    // Unchanged means the same reference, so a refetch that drops nothing
    // does not re-run every effect keyed on the draft map.
    assert.equal(stillDrafts, drafts);

    // And once the server list does carry it, the merge yields one row.
    const byNode = { n1: [thread("d1", "running")] };
    const rendered = mergeDraftsIntoNodeMap(byNode, stillDrafts);
    assert.equal(rendered.n1.length, 1);
    assert.equal(rendered.n1[0].state, "running");
  });

  // #463: the node list now carries the caller's own drafts, so the same
  // draft can be in the fetched list AND still tracked locally. Both paths
  // dedupe by id, so the sidebar, the Relace tab and Prace render one row.
  it("a draft the server list already carries renders once and stops being tracked locally", () => {
    const drafts = { d1: thread("d1", "draft") };
    const fetched = [thread("d1", "draft")];

    // Before the refetch resolved: the overlay must not double the row.
    const overlapping = mergeDraftsIntoNodeMap({ n1: fetched }, drafts);
    assert.deepEqual(overlapping.n1.map((s) => s.id), ["d1"]);

    // After it resolved: the local copy is gone, the server row stays.
    const remaining = dropPromotedDrafts(drafts, fetched);
    assert.deepEqual(Object.keys(remaining), []);
    const rendered = mergeDraftsIntoNodeMap({ n1: fetched }, remaining);
    assert.deepEqual(rendered.n1.map((s) => s.id), ["d1"]);
    assert.equal(rendered.n1[0].state, "draft");
  });
});

describe("pruneNodeSessions", () => {
  it("drops entries for nodes that are no longer open", () => {
    const prev = { n1: [thread("a", "running")], n2: [thread("b", "running", "n2")] };
    assert.deepEqual(Object.keys(pruneNodeSessions(prev, ["n1"])), ["n1"]);
    assert.deepEqual(Object.keys(pruneNodeSessions(prev, [])), []);
  });
});

describe("hostDisplayName (#428)", () => {
  it("prefers the server's label over the raw id", () => {
    assert.equal(hostDisplayName({ host_id: "honzas-macbook-pro", host_label: "Honzas-MacBook-Pro" }), "Honzas-MacBook-Pro");
  });

  it("falls back to the id when no label was resolved", () => {
    assert.equal(hostDisplayName({ host_id: "honzas-macbook-pro", host_label: null }), "honzas-macbook-pro");
    assert.equal(hostDisplayName({ host_id: "honzas-macbook-pro" }), "honzas-macbook-pro");
  });

  it("is null when there is no host at all, so the surface hides the slot", () => {
    assert.equal(hostDisplayName({ host_id: null, host_label: null }), null);
    assert.equal(hostDisplayName({ host_id: "  ", host_label: "  " }), null);
  });
});

describe("shownChatSessionId", () => {
  const open = (node_id: string | null, state: SessionState = "suspended") => ({ id: "S1", node_id, state });

  it("shows the open session only for the node it is anchored on", () => {
    assert.equal(shownChatSessionId("n1", open("n1")), "S1");
    // Switched to another node: its own list is not picked yet, so nothing
    // is shown rather than the previous node's thread.
    assert.equal(shownChatSessionId("n2", open("n1")), null);
  });

  it("shows nothing without a selection, without a session, or for a closed one", () => {
    assert.equal(shownChatSessionId(null, open("n1")), null);
    assert.equal(shownChatSessionId("n1", null), null);
    assert.equal(shownChatSessionId("n1", open("n1", "closed")), null);
    assert.equal(shownChatSessionId("n1", open("n1", "draft")), "S1");
  });
});

describe("mountedChatSessions (#429)", () => {
  type Thread = { id: string; node_id: string | null; state: SessionState };
  const thread = (id: string, node_id: string | null, state: SessionState = "running"): Thread => ({
    id,
    node_id,
    state,
  });

  it("mounts every chat-eligible thread of every open node, in open-node order", () => {
    const byNode = {
      n1: [thread("a"), thread("b", null, "suspended")],
      n2: [thread("c", "n2", "draft")],
    };
    byNode.n1[0].node_id = "n1";
    byNode.n1[1].node_id = "n1";
    const mounted = mountedChatSessions(byNode, ["n2", "n1"], null);
    assert.deepEqual(mounted.map((s) => s.id), ["c", "a", "b"]);
  });

  it("leaves out closed and archived threads -- those fall back to the node detail", () => {
    const byNode = { n1: [thread("a", "n1", "closed"), thread("b", "n1", "archived"), thread("c", "n1")] };
    assert.deepEqual(mountedChatSessions(byNode, ["n1"], null).map((s) => s.id), ["c"]);
    assert.equal(isChatSessionState("closed"), false);
    assert.equal(isChatSessionState("draft"), true);
  });

  it("mounts the shown thread even when the node map has not caught up with it", () => {
    const shown = thread("draft-1", "n1", "draft");
    assert.deepEqual(mountedChatSessions({}, ["n1"], shown).map((s) => s.id), ["draft-1"]);
    // ...and only once when the map does carry it.
    const byNode = { n1: [thread("draft-1", "n1", "draft"), thread("a", "n1")] };
    assert.deepEqual(mountedChatSessions(byNode, ["n1"], shown).map((s) => s.id), ["draft-1", "a"]);
  });

  it("prefers the shown thread's own object over the map's copy of it", () => {
    const shown = { ...thread("a", "n1"), state: "suspended" as SessionState };
    const byNode = { n1: [thread("a", "n1")] };
    assert.equal(mountedChatSessions(byNode, ["n1"], shown)[0], shown);
  });

  it("overlays the map copy's name onto the shown thread -- a rename elsewhere reaches the chat header", () => {
    const shown = { ...thread("a", "n1"), name: "old", model: "opus" };
    const byNode = { n1: [{ ...thread("a", "n1"), name: "new" }] };
    const [mounted] = mountedChatSessions(byNode, ["n1"], shown);
    assert.equal(mounted.name, "new");
    assert.equal((mounted as { model?: string }).model, "opus", "everything else stays the shown thread's own");
    // Same name: the shown object itself, so nothing downstream re-renders.
    const same = { n1: [{ ...thread("a", "n1"), name: "old" }] };
    assert.equal(mountedChatSessions(same, ["n1"], shown)[0], shown);
  });

  it("keeps the same mounted ids when only the shown thread changes -- a switch is not a remount", () => {
    const byNode = { n1: [thread("a", "n1"), thread("b", "n1")] };
    const before = mountedChatSessions(byNode, ["n1"], byNode.n1[0]).map((s) => s.id);
    const after = mountedChatSessions(byNode, ["n1"], byNode.n1[1]).map((s) => s.id);
    assert.deepEqual(before, after);
  });

  it("drops the threads of a node that is no longer open, and a thread that left the map", () => {
    const byNode = { n1: [thread("a", "n1")], n2: [thread("c", "n2")] };
    assert.deepEqual(mountedChatSessions(byNode, ["n1"], null).map((s) => s.id), ["a"]);
    assert.deepEqual(mountedChatSessions({ n1: [] }, ["n1"], null), []);
  });
});

describe("applySessionUpdateToDrafts", () => {
  it("replaces the tracked draft with the updated session", () => {
    const drafts = {
      d1: { id: "d1", runner: "claude", instance_id: "osobni" },
      d2: { id: "d2", runner: "claude", instance_id: null },
    };
    const next = applySessionUpdateToDrafts(drafts, { id: "d1", runner: "claude", instance_id: "tempo" });
    assert.equal(next.d1.instance_id, "tempo");
    assert.equal(next.d2, drafts.d2);
  });

  it("returns the same map when the session is not a tracked draft", () => {
    const drafts = { d1: { id: "d1", runner: "claude", instance_id: null } };
    assert.equal(applySessionUpdateToDrafts(drafts, { id: "s9", runner: "claude", instance_id: null }), drafts);
  });
});
