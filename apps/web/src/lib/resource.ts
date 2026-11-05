// The window-level resource cache (docs/superpowers/specs/
// 2026-11-05-client-traffic-contract.md, rule 4): data the whole window
// shares -- identity, actors, users, runner lists, per-node detail data --
// is fetched once, callers during a flight share the answer, a failure is
// not kept, and an invalidation wins over an answer already on its way.
// Plain modules, no React: use-resource.ts binds a resource to a
// component; test/web-resource.test.ts pins the rules.
//
// A value is never `null`: a loader whose answer can be "nothing" wraps it
// (`{ defaults: null }`), because null means "not loaded" here.

// A failure blocks a retry for this long, then a mounted view asks again
// (a sidecar still starting, a cooldown, a blip must not empty a picker
// for the rest of the window's life).
export const ERROR_RETRY_MS = 15_000;

export type Resource<T> = {
  // The value, else the in-flight answer, else a fresh load.
  get(): Promise<T>;
  // The stored value or null; never loads.
  peek(): T | null;
  // The last load's failure, until a load succeeds, the value is
  // invalidated, or ERROR_RETRY_MS has passed; a view shows it instead of
  // loading forever, and asks again after.
  error(): unknown | null;
  // Counts invalidations: a mounted view keys its load effect on it, so an
  // invalidation during its first flight loads again.
  version(): number;
  // Stores an answer a mutation returned.
  set(value: T): void;
  // Forgets the value; an answer in flight is handed to its callers but
  // not stored, and the next get starts a fresh load.
  invalidate(): void;
  subscribe(cb: () => void): () => void;
  resetForTesting(): void;
};

export function createResource<T>(load: () => Promise<T>, opts: { now?: () => number } = {}): Resource<T> {
  const now = opts.now ?? (() => Date.now());
  let value: T | null = null;
  let lastError: { error: unknown; at: number } | null = null;
  let flight: { promise: Promise<T>; stale: boolean } | null = null;
  let version = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const cb of listeners) cb();
  };
  const dropFlight = () => {
    if (flight) {
      flight.stale = true;
      flight = null;
    }
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
            lastError = null;
            notify();
          }
          return v;
        },
        (err: unknown) => {
          if (flight === entry) flight = null;
          if (!entry.stale) {
            lastError = { error: err, at: now() };
            notify();
          }
          throw err;
        },
      );
      flight = entry;
      return entry.promise;
    },
    peek() {
      return value;
    },
    error() {
      if (lastError === null) return null;
      return now() - lastError.at < ERROR_RETRY_MS ? lastError.error : null;
    },
    version() {
      return version;
    },
    set(v) {
      value = v;
      lastError = null;
      dropFlight();
      notify();
    },
    invalidate() {
      value = null;
      lastError = null;
      dropFlight();
      version += 1;
      notify();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    resetForTesting() {
      value = null;
      lastError = null;
      dropFlight();
      listeners.clear();
    },
  };
}

export type KeyedResource<K extends string, T> = {
  get(key: K): Promise<T>;
  peek(key: K): T | null;
  error(key: K): unknown | null;
  version(key: K): number;
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
    error: (key) => byKey.get(key)?.error() ?? null,
    version: (key) => byKey.get(key)?.version() ?? 0,
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
