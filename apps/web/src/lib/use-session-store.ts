import { useSyncExternalStore } from "react";
import type { SessionStore } from "./session-store";

// Subscribes a component to the session store (docs/superpowers/specs/2026-09-22-web-session-state-design.md,
// "Reading"). `selector` is called with the store itself, so it composes
// with the selectors in session-selectors.ts, e.g.
// `useSessionStore(store, (s) => selectSession(s, id))`. The selectors
// there already memoize their array results per store version, so the
// value this hook returns is reference-stable across a render caused by an
// unrelated put -- useSyncExternalStore's own Object.is check on the
// selector's result is what turns that into "no re-render".
export function useSessionStore<T>(store: SessionStore, selector: (store: SessionStore) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store));
}
