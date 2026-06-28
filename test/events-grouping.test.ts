import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupEventsByDate } from "../apps/web/src/lib/events.js";

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
});
