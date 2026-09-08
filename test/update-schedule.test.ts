// Pure scheduling logic behind useAppUpdate (#274): the update check has no
// dependency on the sidecar, so it must be scheduled from the hook's own
// mount, not solely from the backend-ready event (which can fire before the
// webview's listener attaches, in which case the schedule never started at
// all). Tested with fake timer functions injected via createUpdateScheduler's
// DI seam -- no browser, no React needed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createUpdateScheduler, shouldCheckOnFocus } from "../apps/web/src/lib/update-schedule.js";

// Minimal fake timer queue: setTimeout/setInterval just record a callback
// + delay and hand back an incrementing id; advance() runs every timer
// whose delay has now elapsed (repeating for interval timers), the same
// shape a real fake-timer library provides but self-contained here.
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timeouts = new Map<number, { fn: () => void; at: number }>();
  const intervals = new Map<number, { fn: () => void; every: number; nextAt: number }>();

  return {
    deps: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++;
        timeouts.set(id, { fn, at: now + ms });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (id: ReturnType<typeof setTimeout>) => {
        timeouts.delete(id as unknown as number);
      },
      setInterval: (fn: () => void, ms: number) => {
        const id = nextId++;
        intervals.set(id, { fn, every: ms, nextAt: now + ms });
        return id as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: (id: ReturnType<typeof setInterval>) => {
        intervals.delete(id as unknown as number);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timeouts]) {
        if (t.at <= now) {
          timeouts.delete(id);
          t.fn();
        }
      }
      for (const t of intervals.values()) {
        while (t.nextAt <= now) {
          t.fn();
          t.nextAt += t.every;
        }
      }
    },
    pendingTimeoutCount: () => timeouts.size,
    pendingIntervalCount: () => intervals.size,
  };
}

describe("createUpdateScheduler", () => {
  it("schedules the first check after the delay, without any external trigger", () => {
    const timers = fakeTimers();
    const scheduler = createUpdateScheduler({
      ...timers.deps,
      checkDelayMs: 10_000,
      checkIntervalMs: 3600_000,
    });
    let calls = 0;
    scheduler.schedule(() => calls++);

    timers.advance(9_999);
    assert.equal(calls, 0, "must not fire before the delay elapses");
    timers.advance(1);
    assert.equal(calls, 1, "fires once the delay elapses, with no backend-ready ever received");
  });

  it("then checks periodically at the interval", () => {
    const timers = fakeTimers();
    const scheduler = createUpdateScheduler({
      ...timers.deps,
      checkDelayMs: 10_000,
      checkIntervalMs: 100_000,
    });
    let calls = 0;
    scheduler.schedule(() => calls++);
    timers.advance(10_000);
    assert.equal(calls, 1);
    timers.advance(100_000);
    assert.equal(calls, 2);
    timers.advance(100_000);
    assert.equal(calls, 3);
  });

  it("a repeat schedule() call (e.g. backend-ready firing again) replaces the pending timer instead of adding a second one", () => {
    const timers = fakeTimers();
    const scheduler = createUpdateScheduler({
      ...timers.deps,
      checkDelayMs: 10_000,
      checkIntervalMs: 3600_000,
    });
    let calls = 0;
    scheduler.schedule(() => calls++);
    timers.advance(5_000);
    assert.equal(timers.pendingTimeoutCount(), 1);

    // backend-ready fires again mid-delay -- must reset the 10s wait, not
    // stack a second timer alongside the first.
    scheduler.schedule(() => calls++);
    assert.equal(timers.pendingTimeoutCount(), 1, "still exactly one pending timeout, not two");

    timers.advance(5_000); // total 10s since the reset would not yet be enough from the ORIGINAL schedule
    assert.equal(calls, 0, "the original timer must not have fired -- it was replaced");
    timers.advance(5_000); // now 10s since the reset
    assert.equal(calls, 1, "exactly one check ran, not two");
  });

  it("a repeat schedule() call also replaces the periodic interval, not stacking a second one", () => {
    const timers = fakeTimers();
    const scheduler = createUpdateScheduler({
      ...timers.deps,
      checkDelayMs: 1_000,
      checkIntervalMs: 10_000,
    });
    let calls = 0;
    scheduler.schedule(() => calls++);
    timers.advance(1_000);
    assert.equal(calls, 1);
    assert.equal(timers.pendingIntervalCount(), 1);

    scheduler.schedule(() => calls++);
    assert.equal(timers.pendingIntervalCount(), 0, "the old interval is cleared immediately");
    timers.advance(1_000);
    assert.equal(calls, 2);
    assert.equal(timers.pendingIntervalCount(), 1, "exactly one new interval, not stacked with the old");
  });

  it("stop() cancels both the pending delay and the running interval", () => {
    const timers = fakeTimers();
    const scheduler = createUpdateScheduler({
      ...timers.deps,
      checkDelayMs: 1_000,
      checkIntervalMs: 10_000,
    });
    let calls = 0;
    scheduler.schedule(() => calls++);
    timers.advance(1_000);
    assert.equal(calls, 1);
    scheduler.stop();
    timers.advance(100_000);
    assert.equal(calls, 1, "no further checks after stop()");
  });
});

describe("shouldCheckOnFocus", () => {
  const interval = 6 * 3600_000;

  it("is true when never checked before", () => {
    assert.equal(shouldCheckOnFocus(null, Date.now(), interval), true);
  });

  it("is false shortly after a check", () => {
    const now = 1_000_000;
    assert.equal(shouldCheckOnFocus(now - 60_000, now, interval), false);
  });

  it("is true once at least a full interval has passed (e.g. the machine slept)", () => {
    const now = 1_000_000_000;
    assert.equal(shouldCheckOnFocus(now - interval, now, interval), true);
    assert.equal(shouldCheckOnFocus(now - interval - 1, now, interval), true);
    assert.equal(shouldCheckOnFocus(now - interval + 1, now, interval), false);
  });
});
