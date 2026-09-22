// Reading the session store (#464, spec
// docs/superpowers/specs/2026-09-22-web-session-state-design.md,
// "Reading"): lists are derived, never stored, so "threads of node X",
// "the shown thread", "the mounted threads" and "the running count" are
// pure functions of the store's records plus what is selected.
//
// The one rule every selector here obeys: **its result is reference-stable
// while the store has not changed**, and stays reference-stable across a
// change that does not touch what it selects. `useSessionStore` feeds these
// to `useSyncExternalStore`'s `getSnapshot`, which force-re-renders whenever
// the value it reads back differs by `Object.is` -- a selector that builds a
// fresh array or object per call loops until React throws. Every new
// selector goes through `cached()` below and gets a reference-stability test
// in test/session-store.test.ts.

import type { SessionStore, StoredSession } from "./session-store";
import type { SessionStateMessage } from "./sessions-client";
import { isChatSessionState, isThreadSession, pickOpenChatSession } from "./session-views";

type CacheEntry = { snapshot: object; value: unknown };

// Per store, per selector key: the last snapshot it was computed against and
// the value it produced. A copy-on-write store hands out a new snapshot
// object exactly when something changed, so an unchanged store is a cache
// hit; a changed one recomputes and, when the fresh value holds the same
// records in the same order, hands back the previous array so a subscriber
// does not re-render on somebody else's put.
const caches = new WeakMap<SessionStore, Map<string, CacheEntry>>();

function cached<T>(store: SessionStore, key: string, compute: () => T, equal: (a: T, b: T) => boolean): T {
  const snapshot = store.snapshot();
  let byKey = caches.get(store);
  if (!byKey) {
    byKey = new Map();
    caches.set(store, byKey);
  }
  const hit = byKey.get(key);
  if (hit && hit.snapshot === snapshot) return hit.value as T;
  const fresh = compute();
  const value = hit && equal(hit.value as T, fresh) ? (hit.value as T) : fresh;
  byKey.set(key, { snapshot, value });
  return value;
}

function sameRows(a: readonly StoredSession[], b: readonly StoredSession[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// The bucket order sortInboxSessions gives Přehled's Relace card -- waiting
// ("Čeká na mě") first, then running, then suspended -- with drafts last,
// where mergeDraftsIntoNodeMap appended them. sortInboxSessions itself is
// not reusable here: it takes the overview's own row shape and filters by
// the caller's user id, and a node's threads are not filtered by owner.
function bucket(s: StoredSession): number {
  if (s.state === "running") return s.waiting_since !== null ? 0 : 1;
  if (s.state === "suspended") return 2;
  return 3;
}

// Newest activity first inside a bucket, as every server list orders; a row
// with no timestamp yet (a partial record from a live frame) sorts last
// within its bucket rather than jumping to the top.
function byLastActive(a: StoredSession, b: StoredSession): number {
  return (b.last_active_at || "").localeCompare(a.last_active_at || "");
}

// Shared empty result, so "this node has no threads" is one reference for
// every node and every call.
const EMPTY: StoredSession[] = [];

export function selectSession(store: SessionStore, id: string | null): StoredSession | undefined {
  return id === null ? undefined : store.get(id);
}

// The node's threads as the Práce sidebar lists them: a thread of this app
// (a hand-opened CLI session belongs to Relace, v2 rule 7) that is still
// steerable -- running, waiting, suspended or draft.
export function selectNodeThreads(store: SessionStore, nodeId: string | null): StoredSession[] {
  if (nodeId === null) return EMPTY;
  return cached(
    store,
    `nodeThreads:${nodeId}`,
    () => {
      const rows: StoredSession[] = [];
      for (const s of store.snapshot().values()) {
        if (s.node_id !== nodeId) continue;
        if (!isThreadSession(s) || !isChatSessionState(s.state)) continue;
        rows.push(s);
      }
      return rows.sort((a, b) => bucket(a) - bucket(b) || byLastActive(a, b));
    },
    sameRows,
  );
}

// The thread Práce shows for a node: the requested one while it is still
// live, else the newest live one, else nothing.
export function selectShownThread(
  store: SessionStore,
  nodeId: string | null,
  requestedId: string | null,
): StoredSession | null {
  return pickOpenChatSession(selectNodeThreads(store, nodeId), requestedId);
}

// Every thread that keeps a mounted SessionChat in this window: the
// chat-eligible threads of every open node, in open-node order, plus the
// shown one when its node's list has not come back yet.
export function selectMountedThreads(
  store: SessionStore,
  openNodeIds: readonly string[],
  shownId: string | null,
): StoredSession[] {
  return cached(
    store,
    `mounted:${openNodeIds.join(",")}|${shownId ?? ""}`,
    () => {
      const mounted: StoredSession[] = [];
      const seen = new Set<string>();
      for (const nodeId of openNodeIds) {
        for (const s of selectNodeThreads(store, nodeId)) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          mounted.push(s);
        }
      }
      const shown = shownId === null ? undefined : store.get(shownId);
      if (shown && isChatSessionState(shown.state) && !seen.has(shown.id)) mounted.push(shown);
      return mounted;
    },
    sameRows,
  );
}

// StatusFooter's running count: sessions currently in `running`, this
// window's node open or not -- a live frame alone creates the record
// (partial), so a run started elsewhere counts the moment it is heard of.
export function selectRunningCount(store: SessionStore): number {
  let count = 0;
  for (const s of store.snapshot().values()) if (s.state === "running") count++;
  return count;
}

// The Práce sidebar's per-node map (#465): the same rows selectNodeThreads
// gives, keyed by node, for every open node. Memoized like everything here,
// because `useSyncExternalStore` force-re-renders whenever `getSnapshot`
// returns a value that differs by `Object.is` -- an inline map built in a
// component body would loop until React throws.
export function selectThreadsByNode(
  store: SessionStore,
  openNodeIds: readonly string[],
): Record<string, StoredSession[]> {
  return cached(
    store,
    `threadsByNode:${openNodeIds.join(",")}`,
    () => {
      const byNode: Record<string, StoredSession[]> = {};
      for (const nodeId of openNodeIds) byNode[nodeId] = selectNodeThreads(store, nodeId);
      return byNode;
    },
    // Per-node arrays are themselves reference-stable, so the map is
    // unchanged exactly when every node's array is the same object.
    (a, b) => {
      const aKeys = Object.keys(a);
      if (aKeys.length !== Object.keys(b).length) return false;
      for (const key of aKeys) if (a[key] !== b[key]) return false;
      return true;
    },
  );
}

// The live-state map the surfaces that fetch their own lists still take
// (Přehled's Relace card, the node detail's Relace tab): the store projected
// down to what a `session_state` frame carries, so those lists overlay the
// records this window already has instead of a second live map. Only the
// projected fields count for identity -- a refetch that changes nothing but
// `last_active_at` must not restamp a list's refetch effect.
function liveChannelState(state: StoredSession["state"]): SessionStateMessage["state"] | null {
  return state === "running" || state === "suspended" || state === "closed" || state === "archived" ? state : null;
}

export function selectLiveStates(store: SessionStore): Readonly<Record<string, SessionStateMessage>> {
  return cached(
    store,
    "liveStates",
    () => {
      const states: Record<string, SessionStateMessage> = {};
      for (const s of store.snapshot().values()) {
        const state = liveChannelState(s.state);
        // A draft has no live state -- the channel never reports one -- so
        // it is absent from the map, exactly as it was when the map came
        // from frames alone. A list that shows drafts shows its own rows.
        if (state === null) continue;
        states[s.id] = {
          session_id: s.id,
          state,
          waiting_since: s.waiting_since,
          node_id: s.node_id,
          name: s.name,
        };
      }
      return states;
    },
    (a, b) => {
      const aKeys = Object.keys(a);
      if (aKeys.length !== Object.keys(b).length) return false;
      for (const key of aKeys) {
        const x = a[key];
        const y = b[key];
        if (!y) return false;
        if (x.state !== y.state || x.waiting_since !== y.waiting_since) return false;
        if (x.node_id !== y.node_id || x.name !== y.name) return false;
      }
      return true;
    },
  );
}
