// The one mapping of a Předat / Navázat na handoff refusal to what a client
// receives, shared by the local router, the sync agent's router and the
// live channel (api/session-handoff-errors.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffRefusal } from "../apps/server/api/session-handoff-errors.js";
import { SessionHandoffError } from "../apps/server/domain/runner/session-runtime.js";

test("a SessionHandoffError is a 409 carrying its code and its Czech message", () => {
  const err = new SessionHandoffError("HANDOFF_RUN_ELSEWHERE", "Vlákno právě běží na zařízení druhy-mac; předat ho lze jen tam.");
  assert.deepEqual(handoffRefusal(err), {
    status: 409,
    code: "HANDOFF_RUN_ELSEWHERE",
    message: "Vlákno právě běží na zařízení druhy-mac; předat ho lze jen tam.",
  });
});

test("any other error is not a refusal", () => {
  assert.equal(handoffRefusal(new Error("boom")), null);
  assert.equal(handoffRefusal("boom"), null);
});
