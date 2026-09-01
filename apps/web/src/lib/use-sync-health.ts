import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSyncHealth } from "../api";
import type { SyncHealthResponse } from "../types";

const EMPTY: SyncHealthResponse = { errors: [] };

// Diagnostic-only (#202), so a longer cadence than useSyncPending's 30s is
// fine -- staleness here just delays noticing a fixed misconfiguration by
// up to a minute, not silently losing data.
const POLL_MS = 60_000;
const FOCUS_MIN_INTERVAL_MS = 10_000;
const BACKOFF_MAX_MS = 300_000;

// Polls the workspace-wide mirror-watcher error buffer. Same shape as
// useSyncPending: on mount, every POLL_MS (paused when the tab is hidden),
// and on window focus (throttled). Failures keep the last good value and
// back the cadence off exponentially.
export function useSyncHealth() {
  const [health, setHealth] = useState<SyncHealthResponse>(EMPTY);
  const reqRef = useRef(0);
  const lastFetchAtRef = useRef(0);
  const failureCountRef = useRef(0);

  const refresh = useCallback(() => {
    const myId = ++reqRef.current;
    lastFetchAtRef.current = Date.now();
    fetchSyncHealth()
      .then((r) => {
        failureCountRef.current = 0;
        if (myId === reqRef.current) setHealth(r);
      })
      .catch(() => {
        failureCountRef.current += 1;
      });
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (document.hidden) return;
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

  return { health, refresh };
}
