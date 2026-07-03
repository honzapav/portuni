import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSyncPending } from "../api";
import type { SyncPendingResponse } from "../types";

const EMPTY: SyncPendingResponse = { nodes: [], total: 0 };

const POLL_MS = 30_000;
// Window-focus refreshes are throttled: alt-tabbing around the desktop used
// to fire the full cross-mirror aggregate on every focus event with no
// minimum interval (perf review M7).
const FOCUS_MIN_INTERVAL_MS = 10_000;
// Exponential backoff cap for consecutive failures, so an unreachable
// server is not hammered at full poll cadence.
const BACKOFF_MAX_MS = 300_000;

// Polls the cross-mirror unsynced aggregate. On mount, every 30s (paused
// when the tab is hidden), and on window focus (throttled). Failures keep
// the last good value and back the cadence off exponentially.
export function useSyncPending() {
  const [pending, setPending] = useState<SyncPendingResponse>(EMPTY);
  // Supersede guard: overlapping polls (mount + 30s + focus) can let an older
  // response clobber a newer one. Only the latest in-flight request wins.
  const reqRef = useRef(0);
  const lastFetchAtRef = useRef(0);
  const failureCountRef = useRef(0);

  const refresh = useCallback(() => {
    const myId = ++reqRef.current;
    lastFetchAtRef.current = Date.now();
    fetchSyncPending()
      .then((r) => {
        failureCountRef.current = 0;
        if (myId === reqRef.current) setPending(r);
      })
      .catch(() => {
        failureCountRef.current += 1;
      });
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (document.hidden) return;
      // Backoff: after N consecutive failures the effective interval doubles
      // per failure (30s -> 60s -> 120s ... capped at 5 min).
      const backoff = Math.min(POLL_MS * 2 ** failureCountRef.current, BACKOFF_MAX_MS);
      if (Date.now() - lastFetchAtRef.current < backoff) return;
      refresh();
    }, POLL_MS);
    const onFocus = () => {
      if (Date.now() - lastFetchAtRef.current < FOCUS_MIN_INTERVAL_MS) return;
      refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { pending, refresh };
}
