// The poll loop useSyncPending and useSyncHealth share: refresh now, then
// every `pollMs` while the tab is visible, and on window focus (throttled to
// `focusMinMs`). After N consecutive failures the effective interval doubles
// per failure, capped at `backoffMaxMs`, so an unreachable server is not
// hammered at full cadence. Returns the cleanup for a useEffect.

type Ref<T> = { current: T };

export function startBackoffPoll(opts: {
  refresh: () => void;
  pollMs: number;
  focusMinMs: number;
  backoffMaxMs: number;
  lastFetchAtRef: Ref<number>;
  failureCountRef: Ref<number>;
}): () => void {
  const { refresh, pollMs, focusMinMs, backoffMaxMs, lastFetchAtRef, failureCountRef } = opts;
  refresh();
  const id = setInterval(() => {
    if (document.hidden) return;
    const backoff = Math.min(pollMs * 2 ** failureCountRef.current, backoffMaxMs);
    if (Date.now() - lastFetchAtRef.current < backoff) return;
    refresh();
  }, pollMs);
  const onFocus = () => {
    if (Date.now() - lastFetchAtRef.current < focusMinMs) return;
    refresh();
  };
  window.addEventListener("focus", onFocus);
  return () => {
    clearInterval(id);
    window.removeEventListener("focus", onFocus);
  };
}
