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

import type { CompleteSession, SessionStore, StoredSession } from "./session-store";
import type { SessionStateMessage } from "./sessions-client";
import { isChatSessionState, isThreadSession, pickOpenChatSession } from "./session-views";

type CacheEntry = { snapshot: object; variant: string; value: unknown };

// Per store, per selector key: the last snapshot it was computed against,
// the arguments it was computed for (`variant`) and the value it produced.
// A copy-on-write store hands out a new snapshot object exactly when
// something changed, so an unchanged store queried the same way is a cache
// hit; anything else recomputes and, when the fresh value holds the same
// records in the same order, hands back the previous array so a subscriber
// does not re-render on somebody else's put.
//
// The cache is bounded: **one entry per key**. A selector whose arguments
// vary at runtime -- the open-node set, the shown thread -- keeps them in
// `variant`, not in the key, so switching threads a hundred times replaces
// one entry a hundred times instead of leaving a hundred behind. The only
// key that carries an argument is the per-node thread list, which the
// per-node map and the mount set both read, so the nodes open side by side
// need their entries at the same time.
const caches = new WeakMap<SessionStore, Map<string, CacheEntry>>();

function cached<T>(
  store: SessionStore,
  key: string,
  variant: string,
  compute: () => T,
  equal: (a: T, b: T) => boolean,
): T {
  const snapshot = store.snapshot();
  let byKey = caches.get(store);
  if (!byKey) {
    byKey = new Map();
    caches.set(store, byKey);
  }
  const hit = byKey.get(key);
  if (hit && hit.snapshot === snapshot && hit.variant === variant) return hit.value as T;
  const fresh = compute();
  const value = hit && equal(hit.value as T, fresh) ? (hit.value as T) : fresh;
  byKey.set(key, { snapshot, variant, value });
  return value;
}

// How many entries this store's selector cache holds. Exported for
// test/session-store.test.ts, which holds the bound above; nothing in the
// app reads it.
export function selectorCacheSize(store: SessionStore): number {
  return caches.get(store)?.size ?? 0;
}

function sameRows(a: readonly CompleteSession[], b: readonly CompleteSession[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// The bucket order sortInboxSessions gives Přehled's Relace card -- waiting
// ("Čeká na mě") first, then running, then suspended -- with drafts last,
// where mergeDraftsIntoNodeMap appended them. sortInboxSessions itself is
// not reusable here: it takes the overview's own row shape and filters by
// the caller's user id, and a node's threads are not filtered by owner.
function bucket(s: CompleteSession): number {
  if (s.state === "running") return s.waiting_since !== null ? 0 : 1;
  if (s.state === "suspended") return 2;
  return 3;
}

// Newest activity first inside a bucket, as every server list orders; a row
// with no timestamp yet sorts last within its bucket rather than jumping to
// the top.
function byLastActive(a: CompleteSession, b: CompleteSession): number {
  return (b.last_active_at || "").localeCompare(a.last_active_at || "");
}

// Shared empty results, so "this node has no threads" and "nothing is open"
// are one reference for every node and every call -- and cost no cache
// entry, which is what keeps the cache's one-entry-per-key bound from
// having to hold "nothing open" and "these nodes open" at once.
const EMPTY: CompleteSession[] = [];
const EMPTY_BY_NODE: Record<string, CompleteSession[]> = {};

export function selectSession(store: SessionStore, id: string | null): StoredSession | undefined {
  return id === null ? undefined : store.get(id);
}

// The node's threads as the Práce sidebar lists them: a thread of this app
// (a hand-opened CLI session belongs to Relace, v2 rule 7) that is still
// steerable -- running, waiting, suspended or draft.
export function selectNodeThreads(store: SessionStore, nodeId: string | null): CompleteSession[] {
  if (nodeId === null) return EMPTY;
  return cached(
    store,
    `nodeThreads:${nodeId}`,
    "",
    () => {
      const rows: CompleteSession[] = [];
      for (const s of store.snapshot().values()) {
        if (s.node_id !== nodeId) continue;
        // A record known only from a live frame is not a thread yet: the
        // initial burst carries every running session the caller can see,
        // a hand-opened CLI session included, and its own `put` is what
        // says whether it belongs in this list at all.
        if (s.partial) continue;
        if (!isThreadSession(s) || !isChatSessionState(s.state)) continue;
        rows.push(s);
      }
      return rows.sort((a, b) => bucket(a) - bucket(b) || byLastActive(a, b));
    },
    sameRows,
  );
}

// The thread Práce shows for a node: the requested one while it is still
// live, else the newest row of the first non-empty bucket, which is what
// selectNodeThreads orders (waiting, running, suspended, draft), else
// nothing.
//
// #498: a closed thread is not among those, but one the user opened on
// purpose (Relace's Otevřít chat, `openedClosedId`) is shown while it is the
// requested one and still closed -- writing into it reopens it, and from
// then on it is an ordinary live thread. A thread closed while on screen
// (Uzavřít) was never opened as closed, so it leaves the surface as before.
export function selectShownThread(
  store: SessionStore,
  nodeId: string | null,
  requestedId: string | null,
  openedClosedId: string | null = null,
): CompleteSession | null {
  if (requestedId !== null && requestedId === openedClosedId) {
    const s = store.get(requestedId);
    if (s && !s.partial && s.node_id === nodeId && s.state === "closed" && isThreadSession(s)) return s;
  }
  return pickOpenChatSession(selectNodeThreads(store, nodeId), requestedId);
}

// Every thread that keeps a mounted SessionChat in this window: the
// chat-eligible threads of every open node, in open-node order, plus the
// shown one when its node's list has not come back yet.
export function selectMountedThreads(
  store: SessionStore,
  openNodeIds: readonly string[],
  shownId: string | null,
  // #498: the closed thread opened from Relace (selectShownThread's own).
  openedClosedId: string | null = null,
): CompleteSession[] {
  if (openNodeIds.length === 0 && shownId === null) return EMPTY;
  return cached(
    store,
    "mounted",
    `${openNodeIds.join(",")}|${shownId ?? ""}|${openedClosedId ?? ""}`,
    () => {
      const mounted: CompleteSession[] = [];
      const seen = new Set<string>();
      for (const nodeId of openNodeIds) {
        for (const s of selectNodeThreads(store, nodeId)) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          mounted.push(s);
        }
      }
      const shown = shownId === null ? undefined : store.get(shownId);
      // The shown one may be a closed thread opened from Relace (#498).
      const openable =
        shown !== undefined &&
        (isChatSessionState(shown.state) || (shown.state === "closed" && shown.id === openedClosedId));
      if (shown && !shown.partial && openable && !seen.has(shown.id)) mounted.push(shown);
      return mounted;
    },
    sameRows,
  );
}

// StatusFooter's running count: sessions currently in `running`, this
// window's node open or not, and a partial record counts too -- a live
// frame alone creates it, so a run started elsewhere (another node, a
// hand-opened CLI) is counted the moment it is heard of, which is exactly
// what this footer says.
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
): Record<string, CompleteSession[]> {
  if (openNodeIds.length === 0) return EMPTY_BY_NODE;
  return cached(
    store,
    "threadsByNode",
    openNodeIds.join(","),
    () => {
      const byNode: Record<string, CompleteSession[]> = {};
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
    "",
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
          // Absent, never blank: a record this window only ever heard of
          // through a frame that carried no name (a server older than the
          // field) must not overlay `""` onto the name the list the
          // surface fetched already shows.
          ...(s.name !== undefined ? { name: s.name } : {}),
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

// The records a node takes with it when it is closed in Práce (what
// `pruneNodeSessions` decided before the store existed): everything
// anchored on that node except the thread still on screen, which survives
// because closing its node does not close the thread. Not memoized and not
// a render-path selector -- it answers one question, once, for the click
// that closes the node, and its answer goes straight into `removeMany`.
export function selectNodeRecordIds(store: SessionStore, nodeId: string, keepId: string | null): string[] {
  const ids: string[] = [];
  for (const s of store.snapshot().values()) {
    if (s.node_id !== nodeId || s.id === keepId) continue;
    ids.push(s.id);
  }
  return ids;
}
