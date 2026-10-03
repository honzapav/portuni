import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSyncPending } from "../api";
import { startBackoffPoll } from "./backoff-poll";
import {
  applyOverrides,
  applyPendingNode,
  pruneOverrides,
  residualPendingNode,
  type PendingOverride,
} from "./sync-pending-residual";
import type { SyncPendingResponse, SyncRunResponse } from "../types";

const EMPTY: SyncPendingResponse = { nodes: [], total: 0, decisions: 0 };

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
//
// `enabled` is false in a personal workspace (and while the data mode is
// still unknown): there is no remote, so nothing is ever unsynced and the
// hook neither fetches nor polls (#575); `pending` stays empty.
export function useSyncPending(enabled: boolean) {
  const [pending, setPending] = useState<SyncPendingResponse>(EMPTY);
  // Supersede guard: overlapping polls (mount + 30s + focus) can let an older
  // response clobber a newer one. Only the latest in-flight request wins.
  const reqRef = useRef(0);
  const lastFetchAtRef = useRef(0);
  const failureCountRef = useRef(0);
  // Latest value, readable synchronously by applyRun (which needs the node's
  // current row to build its residual).
  const pendingRef = useRef<SyncPendingResponse>(EMPTY);
  // Per-node results applied ahead of the next scan, so a scan that was
  // already in flight when a sync finished cannot resurrect a cleared node.
  const overridesRef = useRef<Map<string, PendingOverride>>(new Map());

  const store = useCallback((next: SyncPendingResponse) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const refresh = useCallback(() => {
    const myId = ++reqRef.current;
    const startedAt = Date.now();
    lastFetchAtRef.current = startedAt;
    fetchSyncPending()
      .then((r) => {
        failureCountRef.current = 0;
        if (myId !== reqRef.current) return;
        const kept = pruneOverrides(overridesRef.current, startedAt);
        overridesRef.current = kept;
        store(applyOverrides(r, kept));
      })
      .catch(() => {
        failureCountRef.current += 1;
      });
  }, [store]);

  // A finished sync run updates its node immediately; the aggregate scan it
  // triggers takes seconds and only reconciles.
  const applyRun = useCallback(
    (nodeId: string, run: SyncRunResponse) => {
      const prev = pendingRef.current.nodes.find((n) => n.node_id === nodeId);
      const residual = prev ? residualPendingNode(prev, run) : null;
      overridesRef.current.set(nodeId, { node: residual, since: Date.now() });
      store(applyPendingNode(pendingRef.current, nodeId, residual));
    },
    [store],
  );

  useEffect(() => {
    if (!enabled) {
      // Supersede anything still in flight and drop what it had shown.
      reqRef.current += 1;
      store(EMPTY);
      return;
    }
    // Backoff: 30s -> 60s -> 120s ... capped at 5 min.
    return startBackoffPoll({
      refresh,
      pollMs: POLL_MS,
      focusMinMs: FOCUS_MIN_INTERVAL_MS,
      backoffMaxMs: BACKOFF_MAX_MS,
      lastFetchAtRef,
      failureCountRef,
    });
  }, [enabled, refresh, store]);

  return { pending, refresh, applyRun };
}
