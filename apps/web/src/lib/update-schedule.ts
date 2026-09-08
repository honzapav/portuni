// Pure scheduling logic for useAppUpdate (lib/updater.ts, #274). Split out
// so the "first check delayed, then periodic, and a repeat trigger resets
// rather than stacks the timers" behavior is testable without a browser or
// Tauri -- the timer functions are injected, so a test can supply fakes and
// assert on call order/counts directly (same DI seam pattern
// mirror-watcher.ts uses for its watchFactory/reconcile).
//
// The update check itself has no dependency on the sidecar at all (it only
// talks to the GitHub releases endpoint), which is why this schedule starts
// from the hook's own mount -- backend-ready is only an ADDITIONAL trigger
// that resets the schedule, never the sole starting point (that was the bug:
// backend-ready can fire before the webview's listener is attached, in which
// case the schedule never started at all).

export interface UpdateScheduleDeps {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
  checkDelayMs: number;
  checkIntervalMs: number;
}

export interface UpdateScheduler {
  // (Re)starts the delayed-first-check + periodic-interval schedule,
  // cancelling any timers a previous call left running -- so calling this
  // again (e.g. a second backend-ready) replaces rather than stacks them.
  schedule(onCheck: () => void): void;
  stop(): void;
}

export function createUpdateScheduler(deps: UpdateScheduleDeps): UpdateScheduler {
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    if (checkTimer !== null) {
      deps.clearTimeout(checkTimer);
      checkTimer = null;
    }
    if (intervalTimer !== null) {
      deps.clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  return {
    schedule(onCheck) {
      stop();
      checkTimer = deps.setTimeout(() => {
        checkTimer = null;
        onCheck();
        intervalTimer = deps.setInterval(onCheck, deps.checkIntervalMs);
      }, deps.checkDelayMs);
    },
    stop,
  };
}

// Whether a window regaining focus should trigger an immediate check: never
// checked yet, or the last one was long enough ago that the periodic
// interval would have fired again anyway by now -- the case a machine that
// slept for days (or a window that sat in the background through several
// missed intervals) needs, since a suspended OS does not fire JS timers.
export function shouldCheckOnFocus(
  lastCheckedAtMs: number | null,
  nowMs: number,
  intervalMs: number,
): boolean {
  return lastCheckedAtMs === null || nowMs - lastCheckedAtMs >= intervalMs;
}
