// Generic per-key async mutex (#277 finding 4/7 "one per-path mutation
// coordinator" ask). A push (storeFile/storeFileCentral/pushEntryCentral)
// and a pull (pullFile/pullFileCentral) -- or two overlapping editor saves
// (writeFileContent/writeFileContentRemote) -- each read-then-write the same
// local path (or, for the adapter-direct central editor path with no local
// mirror, the same remote path) with no coordination between them. Without
// serialization, a pull's "is the local copy dirty" check and its overwrite
// are not atomic against a concurrent write to that same path: an edit
// landing in the gap is silently destroyed (finding 4), and a push's
// pre/post-stat mid-push-edit detection (finding 7, #266's storeFileCentral
// pattern) only protects against an edit racing that ONE push -- not a
// second push or a pull touching the same path at the same time.
//
// This does not add real storage-level preconditions (an ETag/If-Match
// conditional write against Drive, for instance) -- it only serializes
// operations that go through THIS process. A genuinely concurrent write
// from another device or process to the same remote object is a real gap
// that remains; see the writeFileContentRemote/writeFileBytesRemote call
// sites for the documented limitation.
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
