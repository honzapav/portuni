// Shrinks a StatusResult down to what a caller actually asked for.
// portuni_status on a large node can serialize to hundreds of thousands of
// characters -- past the MCP response limit -- with no way to ask for just
// "what's left to fix". filterStatusResult applies a class allowlist, a
// path prefix, and pagination, while always reporting the true per-class
// counts so "how much is there" stays a cheap answer even when the
// entries themselves are filtered out or truncated.

import type {
  DeletedRemoteEntry,
  NewLocalEntry,
  NewRemoteEntry,
  StatusFileEntry,
  StatusResult,
} from "./engine.js";

// Short, caller-facing names for the StatusResult buckets. Distinct from
// the StatusResult keys themselves (push_candidates/pull_candidates/
// conflicts) -- those names are an existing public shape kept as-is;
// `classes` is a new, friendlier filter vocabulary layered on top.
export const STATUS_CLASS_VALUES = [
  "clean",
  "push",
  "pull",
  "conflict",
  "remote_missing",
  "remote_error",
  "native",
  "deleted_local",
  "new_local",
  "new_remote",
] as const;
export type StatusClass = (typeof STATUS_CLASS_VALUES)[number];

const CLASS_BUCKET: Record<StatusClass, keyof StatusResult> = {
  clean: "clean",
  push: "push_candidates",
  pull: "pull_candidates",
  conflict: "conflicts",
  remote_missing: "remote_missing",
  remote_error: "remote_error",
  native: "native",
  deleted_local: "deleted_local",
  new_local: "new_local",
  new_remote: "new_remote",
};

export interface StatusFilterOptions {
  // Restrict output to these classes (bucket stays [] for everything
  // else, but its count is still reported). Omitted/empty = no
  // restriction. deleted_remote is not selectable here -- it always
  // returns in full, since a match against a delete tombstone is exactly
  // the case a caller narrowing to "what needs a decision" wants to see.
  classes?: readonly StatusClass[];
  // Only entries whose path starts with this prefix (remote_path for a
  // tracked file, local_path for a new_local/deleted_remote entry).
  pathPrefix?: string;
  limit?: number;
  offset?: number;
}

export interface FilteredStatusResult extends StatusResult {
  counts: Record<keyof StatusResult, number>;
  truncated: boolean;
}

function entryPath(
  bucket: keyof StatusResult,
  entry: StatusFileEntry | NewLocalEntry | NewRemoteEntry | DeletedRemoteEntry,
): string | null {
  switch (bucket) {
    case "new_local":
      return (entry as NewLocalEntry).local_path;
    case "new_remote":
      return (entry as NewRemoteEntry).remote_path;
    case "deleted_remote":
      return (entry as DeletedRemoteEntry).local_path;
    default: {
      const e = entry as StatusFileEntry;
      return e.remote_path ?? e.local_path ?? null;
    }
  }
}

export function filterStatusResult(
  result: StatusResult,
  opts: StatusFilterOptions = {},
): FilteredStatusResult {
  const keys = Object.keys(result) as (keyof StatusResult)[];
  const counts = Object.fromEntries(keys.map((k) => [k, result[k].length])) as Record<
    keyof StatusResult,
    number
  >;

  const restrict = opts.classes !== undefined && opts.classes.length > 0;
  const includedBuckets = restrict
    ? new Set<keyof StatusResult>(opts.classes!.map((c) => CLASS_BUCKET[c]))
    : null;

  const prefix = opts.pathPrefix;
  const limit = opts.limit;
  const offset = Math.max(0, opts.offset ?? 0);
  let truncated = false;

  const out = {} as Record<keyof StatusResult, unknown[]>;
  for (const key of keys) {
    // deleted_remote is not part of the classes vocabulary -- it is only
    // ever excluded by class restriction when the restriction targets a
    // different, unrelated bucket set on purpose (see the field comment).
    if (restrict && key !== "deleted_remote" && !includedBuckets!.has(key)) {
      out[key] = [];
      continue;
    }
    let arr = result[key] as unknown[];
    if (prefix) {
      arr = arr.filter((e) => {
        const p = entryPath(key, e as StatusFileEntry | NewLocalEntry | NewRemoteEntry | DeletedRemoteEntry);
        return p?.startsWith(prefix) ?? false;
      });
    }
    const filteredTotal = arr.length;
    const windowed =
      limit !== undefined ? arr.slice(offset, offset + limit) : offset > 0 ? arr.slice(offset) : arr;
    if (windowed.length < filteredTotal) truncated = true;
    out[key] = windowed;
  }

  return { ...(out as unknown as StatusResult), counts, truncated };
}
