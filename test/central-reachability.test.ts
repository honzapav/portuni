import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CentralHttpError } from "../apps/server/domain/sync/central/client.js";
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  backoffMsFor,
  initialBackoff,
  isUnreachableError,
  recordReachable,
  recordUnreachable,
  shouldAttempt,
} from "../apps/server/domain/sync/central/reachability.js";

describe("central reachability backoff", () => {
  it("tells a network failure apart from an answered request", () => {
    // Central answered -- it is up, and the mirror-level failure is real.
    assert.equal(isUnreachableError(new CentralHttpError("nope", 404, "NOT_FOUND")), false);
    assert.equal(isUnreachableError(new CentralHttpError("boom", 500)), false);
    // Nothing answered: DNS, no route, refused, aborted timeout.
    assert.equal(isUnreachableError(new TypeError("getaddrinfo ENOTFOUND api.example.com")), true);
    assert.equal(isUnreachableError(new Error("Unable to connect.")), true);
  });

  it("doubles from the normal interval and caps out", () => {
    assert.equal(backoffMsFor(0), 0);
    assert.equal(backoffMsFor(1), BASE_BACKOFF_MS);
    assert.equal(backoffMsFor(2), BASE_BACKOFF_MS * 2);
    assert.equal(backoffMsFor(3), BASE_BACKOFF_MS * 4);
    assert.equal(backoffMsFor(50), MAX_BACKOFF_MS);
  });

  it("holds off further rounds while unreachable, then reopens", () => {
    const t0 = 1_000_000;
    let s = initialBackoff();
    assert.equal(shouldAttempt(s, t0), true, "a fresh state always attempts");

    s = recordUnreachable(s, t0);
    assert.equal(shouldAttempt(s, t0 + 1), false);
    assert.equal(shouldAttempt(s, t0 + BASE_BACKOFF_MS - 1), false);
    assert.equal(shouldAttempt(s, t0 + BASE_BACKOFF_MS), true);

    // Still down at the retry -- the window widens rather than staying at 10m.
    s = recordUnreachable(s, t0 + BASE_BACKOFF_MS);
    assert.equal(shouldAttempt(s, t0 + BASE_BACKOFF_MS * 2), false);
    assert.equal(shouldAttempt(s, t0 + BASE_BACKOFF_MS * 3), true);
  });

  it("a single success clears the whole backoff", () => {
    let s = initialBackoff();
    for (let i = 0; i < 6; i++) s = recordUnreachable(s, 0);
    assert.equal(s.consecutiveFailures, 6);
    assert.equal(shouldAttempt(s, 1), false);

    s = recordReachable(s);
    assert.deepEqual(s, initialBackoff());
    assert.equal(shouldAttempt(s, 1), true);
  });

  it("an overnight offline stretch costs a handful of rounds, not one per 10 min", () => {
    // Twelve hours asleep. Before the backoff this was 72 rounds x 26 mirrors
    // x 2 (client retry) doomed connects, each writing a stack trace.
    const TWELVE_HOURS = 12 * 60 * 60_000;
    let s = initialBackoff();
    let now = 0;
    let rounds = 0;
    while (now < TWELVE_HOURS) {
      if (shouldAttempt(s, now)) {
        rounds++;
        s = recordUnreachable(s, now);
      }
      now += BASE_BACKOFF_MS; // the timer still ticks every 10 minutes
    }
    assert.ok(rounds <= 15, `expected a handful of attempts, got ${rounds}`);
    assert.ok(rounds >= 10, `must keep retrying hourly once capped, got ${rounds}`);
  });
});
