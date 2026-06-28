import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSyncPending } from "../api";
import type { SyncPendingResponse } from "../types";

const EMPTY: SyncPendingResponse = { nodes: [], total: 0 };

// Polls the cross-mirror unsynced aggregate. On mount, every 30s (paused
// when the tab is hidden), and on window focus. Cheap (fast + name-only
// discovery server-side); failures keep the last good value.
export function useSyncPending() {
  const [pending, setPending] = useState<SyncPendingResponse>(EMPTY);
  // Supersede guard: overlapping polls (mount + 30s + focus) can let an older
  // response clobber a newer one. Only the latest in-flight request wins.
  const reqRef = useRef(0);

  const refresh = useCallback(() => {
    const myId = ++reqRef.current;
    fetchSyncPending()
      .then((r) => { if (myId === reqRef.current) setPending(r); })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 30000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { pending, refresh };
}
