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
  isOpenableChatState,
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
      assert.equal(composerStatePlaceholder(state), "Napiš zprávu…", state);
    }
    assert.equal(threadAcceptsMessages("archived"), false);
    assert.equal(composerStatePlaceholder("archived"), "Relace je uzavřená.");
  });

  it("a closed row opens its chat like a suspended one; archived and draft do not", () => {
    assert.equal(sessionRowOpensChat("running"), true);
    assert.equal(sessionRowOpensChat("suspended"), true);
    assert.equal(sessionRowOpensChat("closed"), true);
    assert.equal(sessionRowOpensChat("archived"), false);
    assert.equal(sessionRowOpensChat("draft"), false);
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
