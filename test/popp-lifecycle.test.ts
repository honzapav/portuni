// test/popp-lifecycle.test.ts
// Validates the lifecycle state constants and helpers in src/popp.ts.
// These are the single source of truth for per-type lifecycle enums
// and the coarse status mapping used by DB trigger + frontend.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIFECYCLE_STATES_BY_TYPE,
  STATUS_FROM_LIFECYCLE,
  getLifecycleStatesForType,
  deriveStatusFromLifecycle,
} from "../src/shared/popp.js";

describe("LIFECYCLE_STATES_BY_TYPE", () => {
  it("covers all five node types", () => {
    assert.equal(Object.keys(LIFECYCLE_STATES_BY_TYPE).length, 5);
  });

  it("project has six states", () => {
    assert.deepEqual(
      LIFECYCLE_STATES_BY_TYPE.project,
      ["backlog", "planned", "in_progress", "on_hold", "done", "cancelled"],
    );
  });

  it("process has six states", () => {
    assert.deepEqual(
      LIFECYCLE_STATES_BY_TYPE.process,
      ["not_implemented", "implementing", "operating", "at_risk", "broken", "retired"],
    );
  });
});

describe("deriveStatusFromLifecycle", () => {
  it("maps done to completed", () => {
    assert.equal(deriveStatusFromLifecycle("project", "done"), "completed");
  });
  it("maps archived-like states to archived", () => {
    assert.equal(deriveStatusFromLifecycle("process", "retired"), "archived");
    assert.equal(deriveStatusFromLifecycle("project", "cancelled"), "archived");
    assert.equal(deriveStatusFromLifecycle("area", "inactive"), "archived");
  });
  it("maps live states to active", () => {
    assert.equal(deriveStatusFromLifecycle("process", "operating"), "active");
    assert.equal(deriveStatusFromLifecycle("area", "needs_attention"), "active");
  });
});

describe("getLifecycleStatesForType", () => {
  it("returns the same array referenced in LIFECYCLE_STATES_BY_TYPE", () => {
    assert.equal(
      getLifecycleStatesForType("organization"),
      LIFECYCLE_STATES_BY_TYPE.organization,
    );
  });
});

describe("STATUS_FROM_LIFECYCLE", () => {
  it("is exported for DB trigger + frontend reuse", () => {
    assert.equal(STATUS_FROM_LIFECYCLE.done, "completed");
    assert.equal(STATUS_FROM_LIFECYCLE.retired, "archived");
  });
});
