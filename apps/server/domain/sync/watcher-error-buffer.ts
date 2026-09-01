// Bounded in-memory buffer of recent mirror-watcher failures (#202).
//
// mirror-watcher.ts's reconcile/backfill failures used to only reach
// console.error -- a misconfiguration (a local-only workspace before #201,
// an unreadable file, a moved-away mirror) read to the user as "files are
// not there" with nothing short of the sidecar log to diagnose it from.
// This module is the shared record both the REST layer (api/sync-health.ts,
// the watcher_errors field on GET /nodes/:id/sync-status) and the watcher
// itself read/write.
//
// Process-local and never persisted, same as session-projection.ts's
// registry: on restart it starts empty, which is fine -- a still-broken
// path re-records itself on the next reconcile attempt.

import type { WatcherErrorEntry } from "../../shared/api-types.js";

// One entry per (node_id, path): a repeated failure for the same path
// refreshes `at` (and `message`, in case the failure mode changed) rather
// than growing the buffer -- this is the "dedupe" the spec asks for, for
// free from being keyed this way.
interface WatcherErrorRecord {
  path: string;
  message: string;
  at: string;
}

// Cap per node, not globally: one badly-behaved mirror (e.g. a permissions
// problem hitting every file in it) must not push out the history of an
// unrelated node's single failure. Oldest-by-insertion is evicted first --
// exact LRU precision does not matter for a diagnostic buffer.
const MAX_ENTRIES_PER_NODE = 50;

const buffer = new Map<string, Map<string, WatcherErrorRecord>>();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function recordWatcherError(nodeId: string, path: string, error: unknown): void {
  let byPath = buffer.get(nodeId);
  if (!byPath) {
    byPath = new Map();
    buffer.set(nodeId, byPath);
  }
  const isNewPath = !byPath.has(path);
  byPath.set(path, { path, message: messageOf(error), at: new Date().toISOString() });
  if (isNewPath && byPath.size > MAX_ENTRIES_PER_NODE) {
    const oldest = byPath.keys().next().value;
    if (oldest !== undefined) byPath.delete(oldest);
  }
}

export function clearWatcherError(nodeId: string, path: string): void {
  buffer.get(nodeId)?.delete(path);
}

// All currently-tracked errors, optionally restricted to one node. Sorted
// newest-first so both the per-node list and the workspace-wide banner
// read most-recent-problem-first without the caller having to sort.
export function getWatcherErrors(nodeId?: string): WatcherErrorEntry[] {
  const out: WatcherErrorEntry[] = [];
  const nodeIds = nodeId !== undefined ? [nodeId] : [...buffer.keys()];
  for (const id of nodeIds) {
    const byPath = buffer.get(id);
    if (!byPath) continue;
    for (const rec of byPath.values()) {
      out.push({ node_id: id, path: rec.path, message: rec.message, at: rec.at });
    }
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out;
}

export function clearWatcherErrorBufferForTests(): void {
  buffer.clear();
}
