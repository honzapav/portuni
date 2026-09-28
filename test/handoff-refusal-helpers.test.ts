// apps/web/src/lib/handoff-refusal.ts: a refused Předat becomes an error
// carrying the server's HANDOFF_* code and params, which the web renders
// from the errors catalog (displayError), never the raw status line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HandoffRefusedError, parseHandoffRefusal } from "../apps/web/src/lib/handoff-refusal.js";
import { errorCode } from "../apps/web/src/lib/api-error.js";

test("a 409 with a handoff code becomes the refusal with its code and params", () => {
  const refusal = parseHandoffRefusal(
    409,
    JSON.stringify({
      error: "The node has no mirror on this device.",
      code: "HANDOFF_NO_MIRROR",
      params: { nodeId: "n1", count: 2, ignored: { nested: true } },
    }),
  );
  assert.ok(refusal instanceof HandoffRefusedError);
  assert.equal(refusal?.code, "HANDOFF_NO_MIRROR");
  assert.equal(errorCode(refusal), "HANDOFF_NO_MIRROR");
  assert.equal(refusal?.message, "The node has no mirror on this device.");
  assert.deepEqual(refusal?.params, { nodeId: "n1", count: 2 });
});

test("a refusal without params carries empty params", () => {
  const refusal = parseHandoffRefusal(409, JSON.stringify({ error: "x", code: "HANDOFF_CLOSED" }));
  assert.deepEqual(refusal?.params, {});
});

test("any other answer is not a refusal", () => {
  assert.equal(parseHandoffRefusal(500, JSON.stringify({ error: "x", code: "HANDOFF_NO_MIRROR" })), null);
  assert.equal(parseHandoffRefusal(409, "not json"), null);
  assert.equal(parseHandoffRefusal(409, JSON.stringify({ error: "x", code: "SESSION_NOT_DRAFT" })), null);
});
