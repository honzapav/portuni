// Binding a window-level resource (lib/resource.ts) to a component: the
// stored value through useSyncExternalStore, a load when there is none.
// A mount never decides freshness -- it reads what the window has and asks
// once only when the window has nothing. An invalidation (its `version`)
// re-runs the load; a failure is shown, and asked again after
// ERROR_RETRY_MS.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ERROR_RETRY_MS, type KeyedResource, type Resource } from "./resource";

export type ResourceState<T> = { value: T | null; error: unknown | null; loading: boolean };

function useLoadEffect(
  wanted: boolean,
  value: unknown,
  error: unknown,
  version: number,
  load: () => Promise<unknown>,
): void {
  useEffect(() => {
    if (!wanted || value !== null) return;
    if (error === null) {
      load().catch(() => undefined);
      return;
    }
    // A failure: ask again once it no longer blocks a retry.
    const timer = setTimeout(() => load().catch(() => undefined), ERROR_RETRY_MS);
    return () => clearTimeout(timer);
  }, [wanted, value, error, version, load]);
}

// `wanted` false reads what the window has without asking for it (a
// closed picker that will need the list once it opens).
export function useResourceState<T>(res: Resource<T>, wanted = true): ResourceState<T> {
  const value = useSyncExternalStore(res.subscribe, res.peek, res.peek);
  const error = useSyncExternalStore(res.subscribe, res.error, res.error);
  const version = useSyncExternalStore(res.subscribe, res.version, res.version);
  const load = useCallback(() => res.get(), [res]);
  useLoadEffect(wanted, value, error, version, load);
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
  const peekVersion = useCallback(() => (key === null ? 0 : res.version(key)), [res, key]);
  const value = useSyncExternalStore(res.subscribe, peek, peek);
  const error = useSyncExternalStore(res.subscribe, peekError, peekError);
  const version = useSyncExternalStore(res.subscribe, peekVersion, peekVersion);
  const load = useCallback(() => (key === null ? Promise.resolve(null) : res.get(key)), [res, key]);
  useLoadEffect(key !== null, value, error, version, load);
  return { value, error, loading: key !== null && value === null && error === null };
}

export function useKeyedResource<K extends string, T>(res: KeyedResource<K, T>, key: K | null): T | null {
  return useKeyedResourceState(res, key).value;
}
