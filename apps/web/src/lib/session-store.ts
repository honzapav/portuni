// The session store (docs/superpowers/specs/2026-09-22-web-session-state-design.md,
// "The store"): one record per session id, subscribed through
// useSessionStore (use-session-store.ts). Bound to the SessionsClient and
// api.ts in App.tsx (#465); SessionChat (#466) reads its thread from it by
// id and never holds its own copy. Principle 1: every fact about a thread
// lives here once; a component or map that copies it is a bug.

import type { SessionSummary } from "../types";
import type { SessionStateMessage } from "./sessions-client";

// A record known only from a live-channel frame (no REST row has been seen
// for this id yet): every field but id/node_id/state/waiting_since/name is
// a placeholder. Completed -- and the flag cleared -- by the next `put`.
export type SessionRecord = SessionSummary & { partial?: true };

export interface SessionStore {
  get(id: string): SessionRecord | undefined;
  put(row: SessionSummary): void;
  putMany(rows: readonly SessionSummary[]): void;
  remove(id: string): void;
  applyFrame(frame: SessionStateMessage): void;
  subscribe(listener: () => void): () => void;
  snapshot(): ReadonlyMap<string, SessionRecord>;
}

function shallowEqual(a: SessionRecord, b: SessionRecord): boolean {
  const keys = new Set<keyof SessionRecord>([
    ...(Object.keys(a) as (keyof SessionRecord)[]),
    ...(Object.keys(b) as (keyof SessionRecord)[]),
  ]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// The fields a REST row carries but a session_state frame does not --
// placeholders until the row is actually fetched. `user_id`, `state` and
// `waiting_since` come from the frame itself, `name` too when it carries
// one.
function stubRecord(frame: SessionStateMessage): SessionRecord {
  return {
    id: frame.session_id,
    node_id: frame.node_id,
    user_id: "",
    session_type: "interactive_task",
    cli: null,
    instance_id: null,
    terminal_id: null,
    brief: null,
    runner: null,
    host_id: null,
    host_label: null,
    waiting_since: frame.waiting_since,
    state: frame.state,
    name: frame.name ?? "",
    name_is_custom: false,
    handoff_path: null,
    write_count: 0,
    model: null,
    effort: null,
    context_used_tokens: null,
    context_max_tokens: null,
    created_at: "",
    last_active_at: "",
    closed_at: null,
    partial: true,
  };
}

export function createSessionStore(): SessionStore {
  let records = new Map<string, SessionRecord>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function putOne(row: SessionSummary, next: Map<string, SessionRecord>): boolean {
    const existing = next.get(row.id);
    if (existing && shallowEqual(existing, row)) return false;
    next.set(row.id, row);
    return true;
  }

  function put(row: SessionSummary): void {
    const next = new Map(records);
    if (!putOne(row, next)) return;
    records = next;
    notify();
  }

  function putMany(rows: readonly SessionSummary[]): void {
    if (rows.length === 0) return;
    const next = new Map(records);
    let changed = false;
    for (const row of rows) changed = putOne(row, next) || changed;
    if (!changed) return;
    records = next;
    notify();
  }

  function remove(id: string): void {
    if (!records.has(id)) return;
    const next = new Map(records);
    next.delete(id);
    records = next;
    notify();
  }

  function applyFrame(frame: SessionStateMessage): void {
    const existing = records.get(frame.session_id);
    const updated: SessionRecord = existing
      ? {
          ...existing,
          state: frame.state,
          waiting_since: frame.waiting_since,
          ...(frame.name !== undefined ? { name: frame.name } : {}),
        }
      : stubRecord(frame);
    if (existing && shallowEqual(existing, updated)) return;
    const next = new Map(records);
    next.set(frame.session_id, updated);
    records = next;
    notify();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function snapshot(): ReadonlyMap<string, SessionRecord> {
    return records;
  }

  return {
    get: (id) => records.get(id),
    put,
    putMany,
    remove,
    applyFrame,
    subscribe,
    snapshot,
  };
}

// The optimistic-write pattern principle 2 describes ("an optimistic write
// is allowed but is always replaced by the answer; a refusal restores the
// previous record"): apply the patch before `request` settles, then let
// `request`'s own write-through (api.ts's functions already call
// store.put on their answer) replace it, or put the prior record back on a
// refusal. `request`'s rejection is rethrown unchanged so a caller can
// still say why it failed.
export async function withOptimisticPatch<T>(
  store: SessionStore,
  id: string,
  patch: Partial<SessionSummary>,
  request: () => Promise<T>,
): Promise<T> {
  const before = store.get(id);
  if (before) store.put({ ...before, ...patch });
  try {
    return await request();
  } catch (e) {
    if (before) store.put(before);
    throw e;
  }
}
