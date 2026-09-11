// What we actually know about a tracked file's remote object.
//
// `files.current_remote_hash` used to be read as a two-state answer -- a hash
// means the object is there, NULL means it is not. That reading is wrong, and
// it is the root of a whole class of bugs: NULL is written by the record-only
// registration paths (registerLocalFile, registerFileRecordRemote) to mean
// "we have never pushed this, so we do not know what is on the remote". The
// one place that ever proves absence -- remoteSweep -- DELETES the row rather
// than nulling the hash. So on the wire NULL always means UNKNOWN, never
// ABSENT.
//
// Conflating the two strands a record: classified as if the remote were
// empty, it lands in a bucket (`push`, `remote_missing`) that offers no way
// to resolve the disagreement, while every push aborts on the object the
// classifier insisted was not there.
//
// Three states, named, so the assumption cannot be made silently again.
export type RemoteKnowledge =
  | { state: "present"; hash: string | null }
  | { state: "absent" }
  | { state: "unknown" };

export const REMOTE_UNKNOWN: RemoteKnowledge = { state: "unknown" };
export const REMOTE_ABSENT: RemoteKnowledge = { state: "absent" };

export function remotePresent(hash: string | null): RemoteKnowledge {
  return { state: "present", hash };
}

// What a cached hash column alone can tell us. A hash proves presence; the
// absence of one proves nothing at all.
export function knowledgeFromCachedHash(hash: string | null): RemoteKnowledge {
  return hash === null ? REMOTE_UNKNOWN : remotePresent(hash);
}

// Central's record first, then anything THIS device observed first-hand on an
// earlier push or pull (remote_stat_cache). Central is authoritative whenever
// it has an answer; the device observation only fills a hole.
export function knowledgeFromRecordAndObservation(
  recordHash: string | null,
  observedHash: string | null,
): RemoteKnowledge {
  if (recordHash !== null) return remotePresent(recordHash);
  if (observedHash !== null) return remotePresent(observedHash);
  return REMOTE_UNKNOWN;
}

// A live stat/listing answer: this is the only input that can prove absence.
export function knowledgeFromStat(
  stat: { hash: string | null; exists: boolean } | null,
): RemoteKnowledge | null {
  if (stat === null) return null; // stat failed -- transient, not knowledge
  return stat.exists ? remotePresent(stat.hash) : REMOTE_ABSENT;
}

// Classification needs one yes/no in the end. An unknown remote is treated as
// "nothing there" for bucketing purposes -- the same shape as before -- but
// only AFTER a reconcile pass has had its chance to resolve it, and callers
// that can act on the difference (the sync run) check `state` directly.
export function treatAsExisting(k: RemoteKnowledge): boolean {
  return k.state === "present";
}

export function hashOf(k: RemoteKnowledge): string | null {
  return k.state === "present" ? k.hash : null;
}
