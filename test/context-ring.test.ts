import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contextRingState, latestContextUsage } from "../apps/web/src/lib/context-ring.js";
import type { ChatEvent } from "../apps/web/src/lib/session-chat.js";
import { createI18n } from "../apps/server/shared/i18n/create.js";
import { RESOURCES } from "../apps/server/shared/i18n/resources.js";

const { i18n } = createI18n({
  lng: "en",
  resources: { en: RESOURCES.en, cs: RESOURCES.cs },
  escapeValue: false,
  initAsync: false,
});
const t = i18n.getFixedT("en", "chat");
const tCs = i18n.getFixedT("cs", "chat");

describe("contextRingState", () => {
  it("is null with nothing recorded, undefined or a non-number", () => {
    assert.equal(contextRingState(null, null, "en", t), null);
    assert.equal(contextRingState(undefined, undefined, "en", t), null);
    assert.equal(contextRingState(Number.NaN, 100, "en", t), null);
    assert.equal(contextRingState(10, undefined, "en", t)?.label, "10 tokens");
  });
  it("percent under the threshold is not a warning; at 80 % it is", () => {
    assert.deepEqual(contextRingState(79_000, 100_000, "en", t), {
      used: 79_000,
      max: 100_000,
      fraction: 0.79,
      warn: false,
      label: "79%",
    });
    assert.equal(contextRingState(80_000, 100_000, "en", t)?.warn, true);
    assert.equal(contextRingState(500, 200_000, "en", t)?.label, "<1%");
  });
  it("a count past the window still reads 100 %, never more", () => {
    // The ring is a share of the window; a number above it is a runner
    // that counted something else, and "103 %" only puzzles the reader.
    const s = contextRingState(1_032_223, 1_000_000, "en", t);
    assert.ok(s);
    assert.equal(s.label, "100%");
    assert.equal(s.warn, true);
  });
  it("Czech keeps its own typography and every plural form of the count", () => {
    assert.equal(contextRingState(79_000, 100_000, "cs", tCs)?.label, "79 %");
    assert.equal(contextRingState(500, 200_000, "cs", tCs)?.label, "<1 %");
    assert.equal(contextRingState(1, null, "cs", tCs)?.label, "1 token");
    assert.equal(contextRingState(3, null, "cs", tCs)?.label, "3 tokeny");
    assert.equal(contextRingState(12_345, null, "cs", tCs)?.label, "12,3 k tokenů");
  });
  it("without a max it shows the count", () => {
    const s = contextRingState(12_345, null, "en", t);
    assert.ok(s);
    assert.equal(s.fraction, null);
    assert.equal(s.warn, false);
    assert.equal(s.label, "12.3 k tokens");
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
