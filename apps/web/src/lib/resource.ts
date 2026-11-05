// The window-level resource cache (docs/superpowers/specs/
// 2026-11-05-client-traffic-contract.md, rule 4): data the whole window
// shares -- identity, actors, users, runner lists, per-node detail data --
// is fetched once, callers during a flight share the answer, a failure is
// not kept, and an invalidation wins over an answer already on its way.
// Plain modules, no React: use-resource.ts binds a resource to a
// component; test/web-resource.test.ts pins the rules.

export type Resource<T> = {
  // The value, else the in-flight answer, else a fresh load.
  get(): Promise<T>;
  // The stored value or null; never loads.
  peek(): T | null;
  // Stores an answer a mutation returned.
  set(value: T): void;
  // Forgets the value; an answer in flight is handed to its callers but
  // not stored.
  invalidate(): void;
  subscribe(cb: () => void): () => void;
  resetForTesting(): void;
};

export function createResource<T>(load: () => Promise<T>): Resource<T> {
  let value: T | null = null;
  let flight: { promise: Promise<T>; stale: boolean } | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const cb of listeners) cb();
  };
  return {
    get() {
      if (value !== null) return Promise.resolve(value);
      if (flight) return flight.promise;
      const entry: { stale: boolean; promise: Promise<T> } = { stale: false, promise: Promise.resolve(null as T) };
      entry.promise = load().then(
        (v) => {
          if (flight === entry) flight = null;
          if (!entry.stale) {
            value = v;
            notify();
          }
          return v;
        },
        (err: unknown) => {
          if (flight === entry) flight = null;
          throw err;
        },
      );
      flight = entry;
      return entry.promise;
    },
    peek() {
      return value;
    },
    set(v) {
      value = v;
      if (flight) flight.stale = true;
      notify();
    },
    invalidate() {
      value = null;
      if (flight) flight.stale = true;
      notify();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    resetForTesting() {
      value = null;
      if (flight) flight.stale = true;
      flight = null;
      listeners.clear();
    },
  };
}

export type KeyedResource<K extends string, T> = {
  get(key: K): Promise<T>;
  peek(key: K): T | null;
  set(key: K, value: T): void;
  // No key: every key.
  invalidate(key?: K): void;
  subscribe(cb: () => void): () => void;
  resetForTesting(): void;
};

export function createKeyedResource<K extends string, T>(load: (key: K) => Promise<T>): KeyedResource<K, T> {
  const byKey = new Map<K, Resource<T>>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const cb of listeners) cb();
  };
  const resourceFor = (key: K): Resource<T> => {
    let res = byKey.get(key);
    if (!res) {
      res = createResource(() => load(key));
      res.subscribe(notify);
      byKey.set(key, res);
    }
    return res;
  };
  return {
    get: (key) => resourceFor(key).get(),
    peek: (key) => byKey.get(key)?.peek() ?? null,
    set: (key, value) => resourceFor(key).set(value),
    invalidate(key) {
      if (key === undefined) {
        for (const res of byKey.values()) res.invalidate();
        return;
      }
      byKey.get(key)?.invalidate();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    resetForTesting() {
      for (const res of byKey.values()) res.resetForTesting();
      byKey.clear();
      listeners.clear();
    },
  };
}
