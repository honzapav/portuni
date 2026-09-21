import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contextRingState, latestContextUsage, formatTokens } from "../apps/web/src/lib/context-ring.js";
import type { ChatEvent } from "../apps/web/src/lib/session-chat.js";

describe("contextRingState", () => {
  it("is null with nothing recorded, undefined or a non-number", () => {
    assert.equal(contextRingState(null, null), null);
    assert.equal(contextRingState(undefined, undefined), null);
    assert.equal(contextRingState(Number.NaN, 100), null);
    assert.equal(contextRingState(10, undefined)?.label, "10 tokenů");
  });
  it("percent under the threshold is not a warning; at 80 % it is", () => {
    assert.deepEqual(contextRingState(79_000, 100_000), {
      used: 79_000,
      max: 100_000,
      fraction: 0.79,
      warn: false,
      label: "79 %",
    });
    assert.equal(contextRingState(80_000, 100_000)?.warn, true);
    assert.equal(contextRingState(500, 200_000)?.label, "<1 %");
  });
  it("without a max it shows the count", () => {
    const s = contextRingState(12_345, null);
    assert.ok(s);
    assert.equal(s.fraction, null);
    assert.equal(s.warn, false);
    assert.equal(s.label, "12,3 k tokenů");
  });
});

describe("latestContextUsage", () => {
  const ev = (seq: number, used: number, max: number | null): ChatEvent => ({
    seq,
    event: {
      kind: "context_usage",
      payload: { run_id: "R", model: null, used_tokens: used, max_tokens: max, input_tokens: used, cached_tokens: 0, output_tokens: 3 },
    },
  });
  it("returns the newest event's counters", () => {
    assert.deepEqual(latestContextUsage([ev(1, 10, null), ev(2, 20, 100)]), { used: 20, max: 100, input: 20, cached: 0, output: 3 });
    assert.equal(latestContextUsage([]), null);
  });
});

describe("formatTokens", () => {
  it("compact with a Czech decimal", () => {
    assert.equal(formatTokens(950), "950");
    assert.equal(formatTokens(12_345), "12,3 k");
    assert.equal(formatTokens(200_000), "200 k");
  });
});
