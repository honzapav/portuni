import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ActorRow,
  ResponsibilityRow,
} from "../src/shared/types.js";

describe("ActorRow schema", () => {
  it("accepts a valid person row", () => {
    const ok = ActorRow.parse({
      id: "01HZ" + "X".repeat(22),
      type: "person",
      name: "Honza Pav",
      is_placeholder: 0,
      user_id: "U1",
      notes: null,
      external_id: null,
      created_at: "2026-04-21T10:00:00",
      updated_at: "2026-04-21T10:00:00",
    });
    assert.equal(ok.type, "person");
    assert.equal(ok.is_placeholder, 0);
  });

  it("accepts an automation row without user_id", () => {
    const ok = ActorRow.parse({
      id: "01HZ" + "X".repeat(22),
      type: "automation",
      name: "Stripe sync",
      is_placeholder: 0,
      user_id: null,
      notes: "Pulls daily Stripe reports",
      external_id: null,
      created_at: "2026-04-21T10:00:00",
      updated_at: "2026-04-21T10:00:00",
    });
    assert.equal(ok.type, "automation");
  });
});

describe("ResponsibilityRow schema", () => {
  it("accepts a minimal row", () => {
    const ok = ResponsibilityRow.parse({
      id: "01R" + "X".repeat(23),
      node_id: "01N" + "X".repeat(23),
      title: "Review code",
      description: null,
      sort_order: 0,
      created_at: "2026-04-21T10:00:00",
      updated_at: "2026-04-21T10:00:00",
    });
    assert.equal(ok.sort_order, 0);
  });
});
