import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  sessionRowChip,
  applyLiveSessionState,
  mergeLiveSessionStates,
  sortInboxSessions,
  pickOpenChatSession,
  hostDisplayName,
  requestChatSession,
  isChatSessionState,
  isThreadSession,
  nodeRowActive,
  shownChatSessionId,
  threadCloseAction,
  threadAcceptsMessages,
  composerStatePlaceholder,
  sessionRowOpensChat,
  sessionRowContinues,
  threadCanContinue,
  isOpenableChatState,
  overviewMissingLiveThreads,
  overviewInboxRows,
  overviewInboxSnapshot,
  overviewForgetLeftInbox,
} from "../apps/web/src/lib/session-views.js";
import type { OverviewSessionRow, SessionState } from "../apps/web/src/types.js";
import type { SessionStateMessage } from "../apps/web/src/lib/sessions-client.js";
import { createI18n } from "../apps/server/shared/i18n/create.js";
import { RESOURCES } from "../apps/server/shared/i18n/resources.js";

const { i18n } = createI18n({
  lng: "en",
  resources: { en: RESOURCES.en, cs: RESOURCES.cs },
  escapeValue: false,
  initAsync: false,
});
const tEn = i18n.getFixedT("en", "common");
const tCs = i18n.getFixedT("cs", "common");

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
  it("running with no open question is 'Running', pulsing", () => {
    const chip = sessionRowChip("running", null, tEn);
    assert.equal(chip.label, "Running");
    assert.equal(chip.pulsing, true);
  });

  it("running with waiting_since is 'Waiting on me'", () => {
    assert.equal(sessionRowChip("running", "2026-09-13 10:00:00", tEn).label, "Waiting on me");
    assert.equal(sessionRowChip("running", "2026-09-13 10:00:00", tCs).label, "Čeká na mě");
  });

  it("closed is 'Done' in a row and 'Closed' in the header, archived is 'Archived', neither pulsing", () => {
    assert.equal(sessionRowChip("closed", null, tEn).label, "Done");
    assert.equal(sessionRowChip("closed", null, tEn, "header").label, "Closed");
    assert.equal(sessionRowChip("closed", null, tCs).label, "Hotovo");
    assert.equal(sessionRowChip("closed", null, tCs, "header").label, "Uzavřeno");
    assert.equal(sessionRowChip("closed", null, tEn).pulsing, false);
    assert.equal(sessionRowChip("archived", null, tEn).label, "Archived");
    assert.equal(sessionRowChip("archived", null, tCs).label, "Archiv");
    assert.equal(sessionRowChip("archived", null, tEn).pulsing, false);
  });

  it("suspended is 'Suspended', not pulsing", () => {
    const chip = sessionRowChip("suspended", null, tEn);
    assert.equal(chip.label, "Suspended");
    assert.equal(chip.pulsing, false);
  });

  it("a draft's chip reads 'New' in both variants, so the header never repeats the draft's name", () => {
    assert.equal(sessionRowChip("draft", null, tEn, "row").label, "New");
    assert.equal(sessionRowChip("draft", null, tEn, "header").label, "New");
    assert.equal(sessionRowChip("draft", null, tEn).pulsing, false);
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

// Přehled refetches GET /overview for a live thread its payload does not
// list (client traffic contract, rule 3); a state change of a thread it
// lists is overlaid from the live map and costs nothing.
describe("overviewMissingLiveThreads", () => {
  const live = (id: string, state: SessionStateMessage["state"]): Record<string, SessionStateMessage> => ({
    [id]: { session_id: id, state, waiting_since: null, node_id: "n1" },
  });
  const data = {
    sessions: {
      running: [{ id: "S1" } as OverviewSessionRow],
      suspended: [{ id: "S2" } as OverviewSessionRow],
    },
  };

  it("a listed thread, whatever its state now, is not missing", () => {
    assert.deepEqual(overviewMissingLiveThreads(data, live("S1", "running"), new Set()), []);
    assert.deepEqual(overviewMissingLiveThreads(data, live("S2", "running"), new Set()), []);
    assert.deepEqual(overviewMissingLiveThreads(data, live("S1", "closed"), new Set()), []);
  });

  it("an unlisted running or suspended thread is missing", () => {
    assert.deepEqual(overviewMissingLiveThreads(data, live("S9", "running"), new Set()), ["S9"]);
    assert.deepEqual(overviewMissingLiveThreads(data, live("S9", "suspended"), new Set()), ["S9"]);
  });

  it("an unlisted closed or archived thread is not missing", () => {
    assert.deepEqual(overviewMissingLiveThreads(data, live("S9", "closed"), new Set()), []);
    assert.deepEqual(overviewMissingLiveThreads(data, live("S9", "archived"), new Set()), []);
  });

  it("no payload yet means nothing is missing (the mount load is on its way)", () => {
    assert.deepEqual(overviewMissingLiveThreads(null, live("S9", "running"), new Set()), []);
  });

  it("a thread that was live when the payload was loaded is not missing, however the payload caps its rows", () => {
    // GET /overview caps its rows; a live thread beyond the cap is absent
    // from every payload. It was known when the load started, so it is not
    // a thread started since -- no refetch, and no loop.
    assert.deepEqual(overviewMissingLiveThreads(data, live("S9", "running"), new Set(["S9"])), []);
  });
});

// Přehled's inbox between loads (Codex review on #649): the live map
// decides each listed row's membership and bucket. Expected buckets follow
// the server's own rule in apps/server/api/overview.ts -- `running` is
// state === "running", `suspended` is state === "suspended", nothing else
// is listed -- applied to the row's state after the frame.
describe("overviewInboxRows", () => {
  const R = overviewRow({ id: "R", user_id: "me" });
  const P = overviewRow({ id: "P", user_id: "me", state: "suspended" });
  const frame = (id: string, state: SessionStateMessage["state"], waiting_since: string | null = null) => ({
    [id]: { session_id: id, state, waiting_since, node_id: "n1" } as SessionStateMessage,
  });
  const cases: [string, Record<string, SessionStateMessage>, string[], string[]][] = [
    ["no frame", {}, ["R"], ["P"]],
    ["running stays running", frame("R", "running"), ["R"], ["P"]],
    ["running asks a question", frame("R", "running", "2026-11-05 10:00:00"), ["R"], ["P"]],
    ["running is suspended", frame("R", "suspended"), [], ["R", "P"]],
    ["running is closed", frame("R", "closed"), [], ["P"]],
    ["running is archived", frame("R", "archived"), [], ["P"]],
    ["suspended runs again", frame("P", "running"), ["R", "P"], []],
    ["suspended is closed", frame("P", "closed"), ["R"], []],
    ["suspended is archived", frame("P", "archived"), ["R"], []],
    ["a frame for an unlisted thread", frame("X", "running"), ["R"], ["P"]],
  ];
  for (const [name, live, running, suspended] of cases) {
    it(name, () => {
      const inbox = overviewInboxRows({ running: [R], suspended: [P] }, live);
      assert.deepEqual(inbox.running.map((s) => s.id), running);
      assert.deepEqual(inbox.suspended.map((s) => s.id), suspended);
      for (const s of inbox.running) assert.equal(s.state, "running");
      for (const s of inbox.suspended) assert.equal(s.state, "suspended");
    });
  }

  it("a thread closed elsewhere leaves the rendered inbox (the reported case)", () => {
    const row = overviewRow({ id: "s1", user_id: "me" });
    const inbox = overviewInboxRows(
      { running: [row], suspended: [] },
      { s1: { session_id: "s1", state: "closed", waiting_since: null, node_id: "n1" } },
    );
    assert.deepEqual(sortInboxSessions(inbox.running, inbox.suspended), []);
  });
});

// The refetch decision over a sequence of frames, the way OverviewView
// runs it: snapshot the inbox when the load starts, forget a thread that
// left the inbox on every frame, refetch for an inbox thread the payload
// does not list and the snapshot does not know.
describe("Přehled refetch over frame sequences", () => {
  type Live = Record<string, SessionStateMessage>;
  const st = (entries: [string, SessionStateMessage["state"]][]): Live =>
    Object.fromEntries(entries.map(([id, state]) => [id, { session_id: id, state, waiting_since: null, node_id: "n1" }]));
  const payload = (running: string[], suspended: string[] = []) => ({
    sessions: { running: running.map((id) => ({ id })), suspended: suspended.map((id) => ({ id })) },
  });
  // Returns how many refetches the frames cause; a refetch answers with
  // `refetched` and snapshots the live map of the frame that caused it.
  function run(atLoad: Live, first: ReturnType<typeof payload>, frames: Live[], refetched = first): number {
    let known: ReadonlySet<string> = overviewInboxSnapshot(atLoad);
    let data = first;
    let fetches = 0;
    for (const live of frames) {
      known = overviewForgetLeftInbox(known, live);
      if (overviewMissingLiveThreads(data, live, known).length > 0) {
        fetches++;
        known = overviewInboxSnapshot(live);
        data = refetched;
        known = overviewForgetLeftInbox(known, live);
        assert.deepEqual(overviewMissingLiveThreads(data, live, known), [], "a refetch must not loop");
      }
    }
    return fetches;
  }
  const cases: [string, Live, ReturnType<typeof payload>, Live[], number][] = [
    ["a closed thread in the store at load runs again (the reported case)", st([["s1", "closed"]]), payload([]), [st([["s1", "running"]])], 1],
    ["an archived thread at load runs again", st([["s1", "archived"]]), payload([]), [st([["s1", "running"]])], 1],
    ["a closed thread at load is suspended into the inbox", st([["s1", "closed"]]), payload([]), [st([["s1", "suspended"]])], 1],
    ["a thread started since the load", {}, payload([]), [st([["s9", "running"]])], 1],
    ["a thread started since the load and closed before the frame", {}, payload([]), [st([["s9", "closed"]])], 0],
    ["a capped thread changes state within the inbox", st([["c", "running"]]), payload([]), [st([["c", "suspended"]]), st([["c", "running"]])], 0],
    ["a capped thread closes", st([["c", "running"]]), payload([]), [st([["c", "closed"]])], 0],
    ["a capped thread closes and runs again", st([["c", "running"]]), payload([]), [st([["c", "closed"]]), st([["c", "running"]])], 1],
    ["a listed thread closes and runs again", st([["s1", "running"]]), payload(["s1"]), [st([["s1", "closed"]]), st([["s1", "running"]])], 0],
    ["a listed thread is suspended", st([["s1", "running"]]), payload(["s1"]), [st([["s1", "suspended"]])], 0],
    ["a closed thread stays closed", st([["s1", "closed"]]), payload([]), [st([["s1", "closed"]]), st([["s1", "archived"]])], 0],
  ];
  for (const [name, atLoad, first, frames, fetches] of cases) {
    it(name, () => assert.equal(run(atLoad, first, frames), fetches));
  }

  // A load in flight (OverviewView's `pendingKnown`): the snapshot is taken
  // when the request starts, frames during the flight forget what left the
  // inbox, and the answer -- built while the thread was closed -- does not
  // list it. Counterexample from the independent review of this fix.
  it("a thread closed and run again while the load flies is asked for once it lands", () => {
    let pending: ReadonlySet<string> = overviewInboxSnapshot(st([["R", "running"]]));
    for (const live of [st([["R", "closed"]]), st([["R", "running"]])]) pending = overviewForgetLeftInbox(pending, live);
    const live = st([["R", "running"]]);
    const known = overviewForgetLeftInbox(pending, live);
    assert.deepEqual(overviewMissingLiveThreads(payload([]), live, known), ["R"]);
    // The refetch it causes lists R (it runs now) and settles.
    const after = overviewInboxSnapshot(live);
    assert.deepEqual(overviewMissingLiveThreads(payload(["R"]), live, after), []);
  });

  it("a thread that stays in the inbox through the flight is not asked for again", () => {
    let pending: ReadonlySet<string> = overviewInboxSnapshot(st([["c", "running"]]));
    for (const live of [st([["c", "suspended"]]), st([["c", "running"]])]) pending = overviewForgetLeftInbox(pending, live);
    assert.deepEqual(overviewMissingLiveThreads(payload([]), st([["c", "running"]]), pending), []);
  });

  it("overviewForgetLeftInbox returns the same set when nothing left", () => {
    const known = new Set(["a"]);
    assert.equal(overviewForgetLeftInbox(known, st([["a", "suspended"]])), known);
    assert.equal(overviewForgetLeftInbox(known, {}), known);
  });

  it("overviewInboxSnapshot keeps running and suspended only", () => {
    const snap = overviewInboxSnapshot(st([["r", "running"], ["p", "suspended"], ["c", "closed"], ["a", "archived"]]));
    assert.deepEqual([...snap].sort(), ["p", "r"]);
  });
});

describe("sortInboxSessions", () => {
  it("orders waiting, then running, then suspended", () => {
    const running1 = overviewRow({ id: "r1", user_id: "me" });
    const waiting1 = overviewRow({ id: "w1", user_id: "me", waiting_since: "2026-09-13 09:00:00" });
    const suspended1 = overviewRow({ id: "p1", user_id: "me", state: "suspended" });
    const ordered = sortInboxSessions([running1, waiting1], [suspended1]);
    assert.deepEqual(
      ordered.map((s) => s.id),
      ["w1", "r1", "p1"],
    );
  });

  // #457: GET /overview already answers with the caller's own threads only,
  // so this helper no longer filters by owner -- it just orders what it got.
  it("keeps every row it is given, in bucket order", () => {
    const a = overviewRow({ id: "a", user_id: "me" });
    const b = overviewRow({ id: "b", user_id: "me", state: "suspended" });
    assert.deepEqual(
      sortInboxSessions([a], [b]).map((s) => s.id),
      ["a", "b"],
    );
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

describe("isThreadSession (v2 rule 7)", () => {
  it("an interactive_task with no cli is a thread", () => {
    assert.equal(isThreadSession({ session_type: "interactive_task", cli: null, runner: null }), true);
    assert.equal(isThreadSession({ session_type: "interactive_task", cli: null, runner: "claude" }), true);
  });
  it("a runner thread stays a thread once its agent connects to MCP and fills in cli", () => {
    assert.equal(isThreadSession({ session_type: "interactive_task", cli: "claude", runner: "claude" }), true);
  });
  it("a hand-opened CLI session or a chat session is not", () => {
    assert.equal(isThreadSession({ session_type: "interactive_task", cli: "claude", runner: null }), false);
    assert.equal(isThreadSession({ session_type: "interactive_chat", cli: null, runner: null }), false);
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



describe("hostDisplayName (#428)", () => {
  it("prefers the server's label over the raw id", () => {
    assert.equal(hostDisplayName({ host_id: "honzas-macbook-pro", host_label: "Honzas-MacBook-Pro" }), "Honzas-MacBook-Pro");
  });

  it("falls back to the id when no label was resolved", () => {
    assert.equal(hostDisplayName({ host_id: "honzas-macbook-pro", host_label: null }), "honzas-macbook-pro");
    assert.equal(hostDisplayName({ host_id: "honzas-macbook-pro" }), "honzas-macbook-pro");
  });

  it("names this device's own thread from GET /hosts/local when the summary has no label (#578)", () => {
    const local = { host_id: "01DEVICE", host_label: "Case-Mac" };
    assert.equal(hostDisplayName({ host_id: "01DEVICE", host_label: null }, local), "Case-Mac");
    assert.equal(hostDisplayName({ host_id: "01OTHER", host_label: null }, local), "01OTHER");
    assert.equal(hostDisplayName({ host_id: "01DEVICE", host_label: "Server-Label" }, local), "Server-Label");
    assert.equal(hostDisplayName({ host_id: "01DEVICE", host_label: null }, { host_id: "01DEVICE", host_label: null }), "01DEVICE");
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

  it("shows nothing without a selection, without a session, or for an archived one", () => {
    assert.equal(shownChatSessionId(null, open("n1")), null);
    assert.equal(shownChatSessionId("n1", null), null);
    assert.equal(shownChatSessionId("n1", open("n1", "archived")), null);
    // #498: a closed thread reaches here only when it was opened on
    // purpose (selectShownThread), and then it is shown.
    assert.equal(shownChatSessionId("n1", open("n1", "closed")), "S1");
    assert.equal(shownChatSessionId("n1", open("n1", "draft")), "S1");
  });
});

describe("isChatSessionState", () => {
  it("running, suspended and draft render as chat; closed and archived fall back to the node detail", () => {
    assert.equal(isChatSessionState("running"), true);
    assert.equal(isChatSessionState("suspended"), true);
    assert.equal(isChatSessionState("draft"), true);
    assert.equal(isChatSessionState("closed"), false);
    assert.equal(isChatSessionState("archived"), false);
  });
});

// #506: one answer for every surface that closes a thread -- the sidebar's
// Uzly and Stav rows, the chat header and the Relace row all read it.
describe("threadCloseAction", () => {
  it("deletes a draft outright, on every surface", () => {
    assert.equal(threadCloseAction("draft"), "delete");
  });
  it("closes a running or suspended thread without asking (#498)", () => {
    assert.equal(threadCloseAction("running"), "close");
    assert.equal(threadCloseAction("suspended"), "close");
  });
  it("offers nothing for a closed or archived thread", () => {
    assert.equal(threadCloseAction("closed"), null);
    assert.equal(threadCloseAction("archived"), null);
  });
});

// #498: a closed thread has a composer; writing into it reopens it.
describe("the composer and the Relace row for a closed thread (#498)", () => {
  it("the composer takes a message in every state but archived", () => {
    for (const state of ["draft", "running", "suspended", "closed"] as const) {
      assert.equal(threadAcceptsMessages(state), true, state);
      assert.equal(composerStatePlaceholder(state, tEn), "Write a message…", state);
    }
    assert.equal(threadAcceptsMessages("archived"), false);
    assert.equal(composerStatePlaceholder("archived", tEn), "This thread is archived.");
    assert.equal(composerStatePlaceholder("archived", tCs), "Relace je uzavřená.");
  });

  it("a closed row opens its chat like a suspended one; archived and draft do not", () => {
    assert.equal(sessionRowOpensChat("running"), true);
    assert.equal(sessionRowOpensChat("suspended"), true);
    assert.equal(sessionRowOpensChat("closed"), true);
    assert.equal(sessionRowOpensChat("archived"), false);
    assert.equal(sessionRowOpensChat("draft"), false);
  });

  it("Pokračovat v nové session: the header offers it on every thread but a draft, the row on a done thread with a runner", () => {
    assert.equal(threadCanContinue("running"), true);
    assert.equal(threadCanContinue("suspended"), true);
    assert.equal(threadCanContinue("closed"), true);
    assert.equal(threadCanContinue("archived"), true);
    assert.equal(threadCanContinue("draft"), false);

    assert.equal(sessionRowContinues({ state: "closed", runner: "claude" }), true);
    assert.equal(sessionRowContinues({ state: "archived", runner: "claude" }), true);
    assert.equal(sessionRowContinues({ state: "running", runner: "claude" }), false, "a list click never ends a live run");
    assert.equal(sessionRowContinues({ state: "suspended", runner: "claude" }), false);
    assert.equal(sessionRowContinues({ state: "draft", runner: "claude" }), false);
    assert.equal(sessionRowContinues({ state: "closed", runner: null }), false, "a hand-opened CLI session has no runner to continue under");
  });

  it("a closed thread can be shown as chat, an archived one cannot", () => {
    assert.equal(isOpenableChatState("closed"), true);
    assert.equal(isOpenableChatState("archived"), false);
    assert.equal(isChatSessionState("closed"), false, "and it is still not a sidebar thread");
  });

  it("no surface offers Navázat or a close dialog anymore", () => {
    const src = (p: string) =>
      readFileSync(new URL(`../apps/web/src/${p}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    for (const file of ["App.tsx", "components/SessionChat.tsx", "components/DetailPane.sessions.tsx"]) {
      const text = src(file);
      assert.doesNotMatch(text, /Uzavřít (vlákno|relaci)\?/, `${file} has no close dialog`);
      assert.doesNotMatch(text, /title="Navázat"/, `${file} has no Navázat`);
    }
  });
});
