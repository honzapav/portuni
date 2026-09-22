// Pure selectors over the session store (docs/superpowers/specs/2026-09-22-web-session-state-design.md,
// "Reading"). Every selector reads `store.snapshot()` plus its own
// arguments and returns the same array reference when nothing relevant
// changed, so a `useSessionStore` subscriber keyed on one of these does not
// re-render on an unrelated put. Where session-views.ts already carries the
// rule (ordering, the open-thread pick, the mounted-thread merge), these
// selectors call it rather than reimplementing it.

import type { SessionStore, SessionRecord } from "./session-store";
import { isThreadSession, mountedChatSessions, pickOpenChatSession } from "./session-views";
import type { SessionStateMessage } from "./sessions-client";

export function selectSession(store: SessionStore, id: string): SessionRecord | undefined {
  return store.get(id);
}

function arraysShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Caches the last result per store and argument key so a selector called
// again with the same arguments, against an unchanged store, returns the
// same array reference -- keyed per store (a WeakMap, so a store that goes
// out of scope, e.g. between tests, is not held onto) and, within a store,
// unbounded only in the number of distinct argument combinations a session
// window actually visits (node ids, open-node sets), which is small and
// does not grow with every put.
function memoize<R>(byStore: WeakMap<SessionStore, Map<string, R[]>>, store: SessionStore, key: string, compute: () => R[]): R[] {
  let cache = byStore.get(store);
  if (!cache) {
    cache = new Map();
    byStore.set(store, cache);
  }
  const next = compute();
  const prev = cache.get(key);
  if (prev && arraysShallowEqual(prev, next)) return prev;
  cache.set(key, next);
  return next;
}

const nodeThreadsCache = new WeakMap<SessionStore, Map<string, SessionRecord[]>>();

// A node's threads: running (waiting first), suspended, then draft -- the
// same bucket order sortInboxSessions uses for Přehled, extended with
// draft (principle 5: a draft is a thread, not a separate local map).
export function selectNodeThreads(store: SessionStore, nodeId: string): SessionRecord[] {
  return memoize(nodeThreadsCache, store, nodeId, () => {
    const rows = [...store.snapshot().values()].filter((s) => s.node_id === nodeId && isThreadSession(s));
    const waiting = rows.filter((s) => s.state === "running" && s.waiting_since !== null);
    const running = rows.filter((s) => s.state === "running" && s.waiting_since === null);
    const suspended = rows.filter((s) => s.state === "suspended");
    const draft = rows.filter((s) => s.state === "draft");
    return [...waiting, ...running, ...suspended, ...draft];
  });
}

export function selectShownThread(
  store: SessionStore,
  nodeId: string | null,
  requestedId: string | null,
): SessionRecord | null {
  if (!nodeId) return null;
  return pickOpenChatSession(selectNodeThreads(store, nodeId), requestedId);
}

const mountedThreadsCache = new WeakMap<SessionStore, Map<string, SessionRecord[]>>();

export function selectMountedThreads(
  store: SessionStore,
  openNodeIds: readonly string[],
  shownId: string | null,
): SessionRecord[] {
  const key = JSON.stringify([openNodeIds, shownId]);
  return memoize(mountedThreadsCache, store, key, () => {
    const byNode: Record<string, SessionRecord[]> = {};
    for (const nodeId of openNodeIds) byNode[nodeId] = selectNodeThreads(store, nodeId);
    const shown = shownId ? (store.get(shownId) ?? null) : null;
    return mountedChatSessions(byNode, openNodeIds, shown);
  });
}

export function selectRunningCount(store: SessionStore): number {
  let count = 0;
  for (const s of store.snapshot().values()) {
    if (s.state === "running") count++;
  }
  return count;
}

const liveStatesCache = new WeakMap<
  SessionStore,
  { snapshot: ReadonlyMap<string, SessionRecord>; value: Record<string, SessionStateMessage> }
>();

// A SessionStateMessage-shaped view of the store: what Přehled
// (OverviewView) and the Relace tab (DetailPane.sessions.tsx) still
// overlay onto their own REST-fetched rows (OverviewSessionRow, a node's
// own session list) -- those predate one-record-per-thread and are out of
// this batch's scope, so they keep their own overlay, just now reading it
// off the store instead of a second map App.tsx folded itself. Recomputed
// only when the store actually changed. A draft never produces a real
// session_state frame (SessionStateMessage's own state excludes it, since
// the runtime has no live run to report on), so a draft record is skipped
// here too -- neither Overview nor the Relace tab ever lists one to overlay.
export function selectLiveStates(store: SessionStore): Record<string, SessionStateMessage> {
  const snapshot = store.snapshot();
  const cached = liveStatesCache.get(store);
  if (cached && cached.snapshot === snapshot) return cached.value;
  const value: Record<string, SessionStateMessage> = {};
  for (const record of snapshot.values()) {
    if (record.state === "draft") continue;
    value[record.id] = {
      session_id: record.id,
      node_id: record.node_id,
      state: record.state,
      waiting_since: record.waiting_since,
      name: record.name,
    };
  }
  liveStatesCache.set(store, { snapshot, value });
  return value;
}
