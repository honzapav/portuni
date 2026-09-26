// The one mapping of a session runtime refusal to what a client receives,
// shared by the local router, the sync agent's router and the live channel
// (api/session-refusals.ts). #530: the code comes from the type only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionRefusal } from "../apps/server/api/session-refusals.js";
import { NoLiveRunError, SessionHandoffError } from "../apps/server/domain/runner/session-runtime.js";

test("a SessionHandoffError is a 409 carrying its code and its message", () => {
  const err = new SessionHandoffError("HANDOFF_RUN_ELSEWHERE", "The thread is running on other-mac; hand it over there.");
  assert.deepEqual(sessionRefusal(err), {
    status: 409,
    code: "HANDOFF_RUN_ELSEWHERE",
    message: "The thread is running on other-mac; hand it over there.",
  });
});

test("a NoLiveRunError is a 409 NO_LIVE_RUN", () => {
  const err = new NoLiveRunError("sendMessage", "s1");
  assert.deepEqual(sessionRefusal(err), { status: 409, code: "NO_LIVE_RUN", message: err.message });
});

test("rewording a refusal's message never changes its code", () => {
  const noLiveRun = new NoLiveRunError("sendMessage", "s1");
  noLiveRun.message = "reworded";
  assert.equal(sessionRefusal(noLiveRun)?.code, "NO_LIVE_RUN");
  const handoff = new SessionHandoffError("HANDOFF_NO_MIRROR", "reworded");
  assert.equal(sessionRefusal(handoff)?.code, "HANDOFF_NO_MIRROR");
});

test("a plain Error is never a refusal, whatever its text says", () => {
  assert.equal(sessionRefusal(new Error("sendMessage: session s1 has no live run")), null);
  assert.equal(sessionRefusal(new Error("boom")), null);
  assert.equal(sessionRefusal("boom"), null);
});
