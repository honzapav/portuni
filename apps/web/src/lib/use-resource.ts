// Binding a window-level resource (lib/resource.ts) to a component: the
// stored value through useSyncExternalStore, a load when there is none.
// A mount never decides freshness -- it reads what the window has and asks
// once only when the window has nothing.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { KeyedResource, Resource } from "./resource";

export type ResourceState<T> = { value: T | null; error: unknown | null; loading: boolean };

// `wanted` false reads what the window has without asking for it (a
// closed picker that will need the list once it opens).
export function useResourceState<T>(res: Resource<T>, wanted = true): ResourceState<T> {
  const value = useSyncExternalStore(res.subscribe, res.peek, res.peek);
  const error = useSyncExternalStore(res.subscribe, res.error, res.error);
  useEffect(() => {
    if (wanted && value === null && error === null) res.get().catch(() => undefined);
  }, [res, value, error, wanted]);
  return { value, error, loading: wanted && value === null && error === null };
}

export function useResource<T>(res: Resource<T>, wanted = true): T | null {
  return useResourceState(res, wanted).value;
}

export function useKeyedResourceState<K extends string, T>(
  res: KeyedResource<K, T>,
  key: K | null,
): ResourceState<T> {
  const peek = useCallback(() => (key === null ? null : res.peek(key)), [res, key]);
  const peekError = useCallback(() => (key === null ? null : res.error(key)), [res, key]);
  const value = useSyncExternalStore(res.subscribe, peek, peek);
  const error = useSyncExternalStore(res.subscribe, peekError, peekError);
  useEffect(() => {
    if (key !== null && value === null && error === null) res.get(key).catch(() => undefined);
  }, [res, key, value, error]);
  return { value, error, loading: key !== null && value === null && error === null };
}

export function useKeyedResource<K extends string, T>(res: KeyedResource<K, T>, key: K | null): T | null {
  return useKeyedResourceState(res, key).value;
}
