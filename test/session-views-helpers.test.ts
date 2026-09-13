import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sessionRowChip,
  sessionRowAccess,
  applyLiveSessionState,
  mergeLiveSessionStates,
  sortInboxSessions,
  countRunningSessions,
} from "../apps/web/src/lib/session-views.js";
import type { OverviewSessionRow } from "../apps/web/src/types.js";
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
