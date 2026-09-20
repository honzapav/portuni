import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSyncWatch } from "../api";
import type { SyncWatchResponse } from "../types";

const EMPTY: SyncWatchResponse = { remotes: [] };

// The watcher ticks once a minute, so polling faster than that shows
// nothing new. Diagnostics only: a failed fetch keeps the last good value.
const POLL_MS = 60_000;

// Polls GET /sync/watch while Nastavení › Synchronizace is open (this hook
// is mounted only there). A local workspace simply answers an empty list,
// so no caller needs to gate on the data mode.
export function useSyncWatch() {
  const [watch, setWatch] = useState<SyncWatchResponse>(EMPTY);
  const reqRef = useRef(0);

  const refresh = useCallback(() => {
    const myId = ++reqRef.current;
    fetchSyncWatch()
      .then((r) => {
        if (myId === reqRef.current) setWatch(r);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (document.hidden) return;
      refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { watch, refresh };
}
