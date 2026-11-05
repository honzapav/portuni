// The change feed (docs/superpowers/specs/2026-11-05-client-traffic-contract.md,
// rule 3): every graph and file write publishes the node it touched, and a
// reader asks "what happened since my cursor" -- waiting for the next change
// if nothing has -- instead of polling the nodes it shows.
//
// In memory, per process. On the central server the feed is central's; the
// sync agent long-polls it (boot/change-poller.ts) and republishes into its
// own feed, which the device's live channel (api/sessions-ws.ts) fans out to
// every window as `node_changed` frames. A personal workspace is one process:
// its feed goes straight to its windows. The cursor names the process
// instance, so a restart answers `reset` and the reader refetches what it
// shows once; a cursor older than the ring keeps answers `reset` too.

import { ulid } from "ulid";

export type NodeChangeKind = "node" | "files";

export type NodeChangeEvent = { seq: number; node_id: string; kind: NodeChangeKind; at: number };

export type ChangesSince = {
  cursor: string;
  reset: boolean;
  changes: NodeChangeEvent[];
};

export const CHANGE_FEED_RING = 2000;

let instance = ulid();
let seq = 0;
let ring: NodeChangeEvent[] = [];
const listeners = new Set<(change: NodeChangeEvent) => void>();
const waiters = new Set<() => void>();

function cursorOf(n: number): string {
  return `${instance}:${n}`;
}

function parseCursor(cursor: string | null): number | null {
  if (cursor === null) return null;
  const sep = cursor.indexOf(":");
  if (sep === -1 || cursor.slice(0, sep) !== instance) return null;
  const n = Number(cursor.slice(sep + 1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function publishNodeChange(nodeId: string, kind: NodeChangeKind, now = Date.now()): void {
  seq += 1;
  const change: NodeChangeEvent = { seq, node_id: nodeId, kind, at: now };
  ring.push(change);
  if (ring.length > CHANGE_FEED_RING) ring = ring.slice(ring.length - CHANGE_FEED_RING);
  for (const cb of listeners) cb(change);
  for (const resolve of waiters) resolve();
  waiters.clear();
}

// The changes after `cursor`, at most `max`, and the cursor to continue
// from. `reset` when the cursor is unknown to this process or older than
// the ring: the reader refetches what it shows and continues from the
// returned cursor.
export function changesSince(cursor: string | null, max = 500): ChangesSince {
  const after = parseCursor(cursor);
  const oldest = ring.length > 0 ? ring[0].seq : seq + 1;
  if (after === null || (after < oldest - 1 && ring.length > 0) || (ring.length === 0 && after < seq)) {
    return { cursor: cursorOf(seq), reset: true, changes: [] };
  }
  const changes = ring.filter((c) => c.seq > after).slice(0, max);
  const last = changes.length > 0 ? changes[changes.length - 1].seq : after;
  return { cursor: cursorOf(Math.max(last, after)), reset: false, changes };
}

// Resolves true as soon as something is published after `cursor`, false
// when `timeoutMs` passes first or `signal` aborts (the reader went away).
// The timer never holds the process open.
export function waitForChanges(cursor: string | null, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const after = parseCursor(cursor);
  if (after === null || after < seq) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (woken: boolean) => {
      clearTimeout(timer);
      waiters.delete(onChange);
      signal?.removeEventListener("abort", onAbort);
      resolve(woken);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    const onChange = () => finish(true);
    const onAbort = () => finish(false);
    waiters.add(onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function subscribeChanges(cb: (change: NodeChangeEvent) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function resetChangeFeedForTesting(): void {
  instance = ulid();
  seq = 0;
  ring = [];
  listeners.clear();
  for (const resolve of waiters) resolve();
  waiters.clear();
}
