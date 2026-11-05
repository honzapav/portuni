// The window-wide 429 cooldown (client traffic contract, rule 5): once the
// server has answered RATE_LIMITED, every background poll in the window
// waits out the Retry-After it sent instead of asking again.

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isRateLimited,
  noteRateLimited,
  rateLimitedUntil,
  resetRateLimitCooldownForTesting,
  retryAfterFromBody,
} from "../apps/web/src/lib/rate-limit-cooldown.js";

describe("rate-limit cooldown", () => {
  beforeEach(() => resetRateLimitCooldownForTesting());

  it("is inactive until a 429 is noted", () => {
    assert.equal(isRateLimited(1000), false);
    assert.equal(rateLimitedUntil(), 0);
  });

  it("holds for Retry-After seconds", () => {
    noteRateLimited(28, 1_000);
    assert.equal(isRateLimited(28_999), true);
    assert.equal(isRateLimited(29_000), false);
    assert.equal(rateLimitedUntil(), 29_000);
  });

  it("defaults to 30 s when the body carries no value", () => {
    noteRateLimited(null, 0);
    assert.equal(rateLimitedUntil(), 30_000);
    noteRateLimited(undefined, 0);
    assert.equal(rateLimitedUntil(), 30_000);
  });

  it("never shortens a longer cooldown", () => {
    noteRateLimited(60, 0);
    noteRateLimited(5, 1_000);
    assert.equal(rateLimitedUntil(), 60_000);
  });

  it("reads retryAfterSeconds from an error body", () => {
    assert.equal(retryAfterFromBody('{"code":"RATE_LIMITED","params":{"retryAfterSeconds":28}}'), 28);
    assert.equal(retryAfterFromBody('{"code":"RATE_LIMITED"}'), null);
    assert.equal(retryAfterFromBody("not json"), null);
    assert.equal(retryAfterFromBody('{"params":{"retryAfterSeconds":0}}'), null);
    assert.equal(retryAfterFromBody('{"params":{"retryAfterSeconds":"28"}}'), null);
  });
});
