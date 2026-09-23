// apps/web/src/lib/handoff-refusal.ts: a refused Předat shows the server's
// Czech reason, never the raw status line.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HandoffRefusedError,
  handoffErrorText,
  parseHandoffRefusal,
} from "../apps/web/src/lib/handoff-refusal.js";

test("a 409 with a handoff code becomes the refusal with the server's message", () => {
  const refusal = parseHandoffRefusal(
    409,
    JSON.stringify({ error: "Uzel nemá na tomto zařízení zrcadlo, soubor s předáním nelze zapsat.", code: "HANDOFF_NO_MIRROR" }),
  );
  assert.ok(refusal instanceof HandoffRefusedError);
  assert.equal(refusal?.code, "HANDOFF_NO_MIRROR");
  assert.equal(handoffErrorText(refusal), "Uzel nemá na tomto zařízení zrcadlo, soubor s předáním nelze zapsat.");
});

test("any other answer is not a refusal, and its error text is kept", () => {
  assert.equal(parseHandoffRefusal(500, JSON.stringify({ error: "x", code: "HANDOFF_NO_MIRROR" })), null);
  assert.equal(parseHandoffRefusal(409, "not json"), null);
  assert.equal(parseHandoffRefusal(409, JSON.stringify({ error: "x", code: "SESSION_NOT_DRAFT" })), null);
  assert.equal(handoffErrorText(new Error("POST /x: 500 boom")), "Error: POST /x: 500 boom");
});
