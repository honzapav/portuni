// The seam between the remote watcher loop (boot/remote-watch.ts, #338) and
// GET /sync/watch (#339). The loop is a single in-process instance started
// from index.ts on central only; the REST handler must read its live state
// without the api layer importing a boot module (and without the loop
// having to know a route exists).
//
// Unset on a server that never starts the loop -- an env-mode standalone
// server, the desktop sidecar in either of its modes -- where the route
// answers an empty list, which is exactly what a local workspace reports
// anyway (spec rule 5: central only).

import type { RemoteWatchStatus } from "../../shared/api-types.js";

export type RemoteWatchStatusSource = () => RemoteWatchStatus[];

let source: RemoteWatchStatusSource | null = null;

export function setRemoteWatchStatusSource(next: RemoteWatchStatusSource | null): void {
  source = next;
}

export function remoteWatchStatus(): RemoteWatchStatus[] {
  return source ? source() : [];
}

// remote_cursors.updated_at is stored as a zone-less UTC "YYYY-MM-DD
// HH:MM:SS" (SQLite's datetime('now'); normalizePgRow renders a Postgres
// TIMESTAMPTZ into the same shape). Every other timestamp on
// RemoteWatchStatus is ISO, and a client parsing the bare form would read
// it in its own time zone -- so normalize here rather than leave the UI to
// guess. Anything already parseable (an ISO string) passes through
// re-serialized; anything else is returned untouched.
export function isoFromDbTimestamp(raw: string | null): string | null {
  if (raw === null) return null;
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const d = new Date(utc);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}
