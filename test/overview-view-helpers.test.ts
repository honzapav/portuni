import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capRows, splitThreadsAndCli, overviewCounters, OVERVIEW_ROW_CAP } from "../apps/web/src/lib/overview-view.js";
import type { OverviewSessionRow } from "../apps/web/src/types.js";

function row(id: string, over: Partial<OverviewSessionRow> = {}): OverviewSessionRow {
  return {
    id,
    node_id: "N1",
    node_name: "Node",
    node_type: "project",
    user_id: "U1",
    session_type: "interactive_task",
    cli: null,
    instance_id: null,
    brief: null,
    runner: "claude",
    waiting_since: null,
    state: "running",
    name: id,
    name_is_custom: false,
    handoff_path: null,
    host_id: null,
    host_label: null,
    created_at: "2026-09-21 10:00:00",
    last_active_at: "2026-09-21 10:00:00",
    closed_at: null,
    ...over,
  } as OverviewSessionRow;
}

describe("capRows", () => {
  it("caps at OVERVIEW_ROW_CAP and reports the hidden count; expanded shows all", () => {
    const rows = Array.from({ length: 11 }, (_, i) => i);
    assert.deepEqual(capRows(rows, false), { shown: rows.slice(0, OVERVIEW_ROW_CAP), hidden: 3 });
    assert.deepEqual(capRows(rows, true), { shown: rows, hidden: 0 });
    assert.deepEqual(capRows([1, 2], false), { shown: [1, 2], hidden: 0 });
  });
});

describe("splitThreadsAndCli", () => {
  it("keeps threads, counts CLI and chat sessions with how many run", () => {
    const r = splitThreadsAndCli([
      row("t1"),
      row("c1", { cli: "claude" }),
      row("c2", { cli: "claude", state: "suspended" }),
      row("ch", { session_type: "interactive_chat" }),
    ]);
    assert.deepEqual(
      r.threads.map((t) => t.id),
      ["t1"],
    );
    assert.deepEqual(r.cli, { total: 3, running: 2 });
  });
});

describe("overviewCounters", () => {
  it("counts the caller's own threads by need, passes attention and unsynced through", () => {
    const c = overviewCounters(
      [row("w", { waiting_since: "x" }), row("r"), row("other", { user_id: "U2" }), row("cli", { cli: "claude" })],
      [row("s", { state: "suspended" })],
      "U1",
      4,
      3,
    );
    assert.deepEqual(c, { waiting: 1, running: 1, attention: 4, unsynced: 3 });
  });
});
