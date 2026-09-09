// Per-key async mutex serializing every read-then-write of one path: a
// push, a pull, and an editor save all race each other otherwise, and a
// check that is not atomic with the write it gates loses whichever edit
// lands in the gap. Keyed by local absolute path, or by
// `remote_name:remote_path` on the adapter-direct central path that has no
// local mirror.
//
// NOT reentrant -- taking the same key twice in one call chain deadlocks.
// In-process only: it does not order writes coming from another device or
// process to the same remote object. That needs storage-level
// preconditions (Drive ETag/If-Match) and remains a gap.
const chains = new Map<string, Promise<void>>();

export async function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  const priorSettled = prior.then(
    () => undefined,
    () => undefined,
  );
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = priorSettled.then(() => mine);
  chains.set(key, chained);
  await priorSettled;
  try {
    return await fn();
  } finally {
    release();
    // Only clear the map entry if nobody queued behind us -- otherwise the
    // next waiter's own registration (already stored under this key) would
    // be dropped.
    if (chains.get(key) === chained) chains.delete(key);
  }
}
