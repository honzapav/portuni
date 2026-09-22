// Subscribing a component to the session store (#464, spec
// docs/superpowers/specs/2026-09-22-web-session-state-design.md,
// "Reading"). One hook, `useSyncExternalStore`, no library.
//
// The selector must return a reference-stable value while the store has not
// changed: React re-reads `getSnapshot` in its post-commit consistency check
// and force-re-renders whenever the value differs by `Object.is`, so a
// selector that builds a fresh object or array per call re-renders until
// React throws "Maximum update depth exceeded". The selectors in
// session-selectors.ts are memoized per store for exactly this reason --
// call them, never an inline `{...}` or `[...]` built in the selector body.

import { useCallback, useSyncExternalStore } from "react";
import type { SessionStore } from "./session-store";

export function useSessionStore<T>(store: SessionStore, selector: (store: SessionStore) => T): T {
  const getSnapshot = useCallback(() => selector(store), [store, selector]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
