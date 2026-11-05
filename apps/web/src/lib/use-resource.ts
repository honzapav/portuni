// Binding a window-level resource (lib/resource.ts) to a component: the
// stored value through useSyncExternalStore, a load when there is none.
// A mount never decides freshness -- it reads what the window has and asks
// once only when the window has nothing.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { KeyedResource, Resource } from "./resource";

export function useResource<T>(res: Resource<T>): T | null {
  const value = useSyncExternalStore(res.subscribe, res.peek, res.peek);
  useEffect(() => {
    if (value === null) res.get().catch(() => undefined);
  }, [res, value]);
  return value;
}

export function useKeyedResource<K extends string, T>(res: KeyedResource<K, T>, key: K | null): T | null {
  const peek = useCallback(() => (key === null ? null : res.peek(key)), [res, key]);
  const value = useSyncExternalStore(res.subscribe, peek, peek);
  useEffect(() => {
    if (key !== null && value === null) res.get(key).catch(() => undefined);
  }, [res, key, value]);
  return value;
}
