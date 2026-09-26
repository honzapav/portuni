// Each test file runs in its own process: the local day is Prague's here.
process.env.TZ = "Europe/Prague";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupEventsByDate, localDayOf, moveToLocalDay } from "../apps/web/src/lib/events.js";

// Minimal event shape; groupEventsByDate only reads created_at + id.
function evt(id: string, created_at: string) {
  return { id, created_at } as Parameters<typeof groupEventsByDate>[0][number];
}

describe("groupEventsByDate", () => {
  it("groups consecutive same-date events under one date, newest-first order preserved", () => {
    const events = [
      evt("e1", "2026-06-28T10:00:00Z"),
      evt("e2", "2026-06-28T08:00:00Z"),
      evt("e3", "2026-06-27T17:00:00Z"),
      evt("e4", "2026-06-25T09:00:00Z"),
    ];
    const groups = groupEventsByDate(events);
    assert.deepEqual(
      groups.map((g) => [g.date, g.events.map((e) => e.id)]),
      [
        ["2026-06-28", ["e1", "e2"]],
        ["2026-06-27", ["e3"]],
        ["2026-06-25", ["e4"]],
      ],
    );
  });

  it("returns an empty array for no events", () => {
    assert.deepEqual(groupEventsByDate([]), []);
  });

  it("groups by the user's local day, not the UTC day of the server timestamp (#529)", () => {
    const groups = groupEventsByDate([evt("late", "2026-09-05 23:30:00"), evt("early", "2026-09-05 21:00:00")]);
    assert.deepEqual(
      groups.map((g) => [g.date, g.events.map((e) => e.id)]),
      [
        ["2026-09-06", ["late"]],
        ["2026-09-05", ["early"]],
      ],
    );
    assert.equal(groups[0].day.getDate(), 6);
    assert.equal(groups[0].day.getHours(), 0);
  });
});

describe("localDayOf / moveToLocalDay", () => {
  it("reads the local day of a server timestamp", () => {
    assert.equal(localDayOf("2026-09-05 23:30:00"), "2026-09-06");
    assert.equal(localDayOf("2026-09-05 12:00:00"), "2026-09-05");
  });

  it("moves an event to another local day keeping its local time, in the server's UTC form", () => {
    // 01:30 Prague on 6 Sep; moved to 10 Sep is 01:30 Prague = 23:30 UTC on 9 Sep.
    assert.equal(moveToLocalDay("2026-09-05 23:30:00", "2026-09-10"), "2026-09-09 23:30:00");
    assert.equal(localDayOf(moveToLocalDay("2026-09-05 23:30:00", "2026-09-10")), "2026-09-10");
  });
});
