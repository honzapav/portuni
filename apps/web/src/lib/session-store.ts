// The window's one record per thread (#464, spec
// docs/superpowers/specs/2026-09-22-web-session-state-design.md, "The
// store"): every fact about a session -- name, state, waiting, runner,
// instance, model, effort, node, host -- lives here once and every surface
// reads it. No React, no library, so the backend node-test runner exercises
// it directly (test/session-store.test.ts).
//
// Two rules carry the design:
//   - the server is the truth: a REST answer is `put` verbatim, the live
//     channel only `applyFrame`s state/waiting/name into what is there;
//   - identity means "unchanged": `put` keeps the existing object when
//     every field is equal, and the map is copied on write, so a snapshot
//     reference changing is exactly "something changed". The selectors in
//     session-selectors.ts and useSyncExternalStore both rely on it.

import type { SessionSummary } from "../types";
import type { SessionStateMessage } from "./sessions-client";

// A record known only from a live frame (a session this window never
// fetched) is marked `partial`: its name and runner are unknown, and the
// next `put` -- the list refetch the frame triggers -- replaces it whole.
export type StoredSession = SessionSummary & { partial?: true };

export interface SessionStore {
  get(id: string): StoredSession | undefined;
  put(row: SessionSummary): void;
  putMany(rows: readonly SessionSummary[]): void;
  remove(id: string): void;
  applyFrame(frame: SessionStateMessage): void;
  subscribe(listener: () => void): () => void;
  snapshot(): ReadonlyMap<string, StoredSession>;
}

function shallowEqualSession(a: StoredSession, b: StoredSession): boolean {
  const aKeys = Object.keys(a) as (keyof StoredSession)[];
  const bKeys = Object.keys(b) as (keyof StoredSession)[];
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!(key in b)) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// The stub a frame for an unknown id creates. Everything the frame does not
// carry is the zero value, never a guess: `session_type`/`cli` say "a thread
// of this app" so the row is visible in its node the moment it is heard of,
// which is what the partial record is for.
function stubFromFrame(frame: SessionStateMessage): StoredSession {
  return {
    partial: true,
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
  };
}

export function createSessionStore(): SessionStore {
  let records = new Map<string, StoredSession>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  // One copy-on-write per operation, not per row: a list refetch that
  // changes nothing leaves the snapshot reference alone, so no selector and
  // no subscriber re-runs.
  function write(apply: (next: Map<string, StoredSession>) => boolean): void {
    const next = new Map(records);
    if (!apply(next)) return;
    records = next;
    notify();
  }

  function putInto(next: Map<string, StoredSession>, row: StoredSession): boolean {
    const existing = next.get(row.id);
    if (existing && shallowEqualSession(existing, row)) return false;
    next.set(row.id, row);
    return true;
  }

  return {
    get(id) {
      return records.get(id);
    },
    put(row) {
      write((next) => putInto(next, row));
    },
    putMany(rows) {
      write((next) => {
        let changed = false;
        for (const row of rows) changed = putInto(next, row) || changed;
        return changed;
      });
    },
    remove(id) {
      write((next) => next.delete(id));
    },
    // The live channel updates a record, it never replaces one: runner,
    // instance, model and everything else the frame does not carry stay as
    // they were (spec principle 3).
    applyFrame(frame) {
      write((next) => {
        const existing = next.get(frame.session_id);
        if (!existing) return putInto(next, stubFromFrame(frame));
        const folded: StoredSession = {
          ...existing,
          state: frame.state,
          waiting_since: frame.waiting_since,
          ...(frame.name !== undefined ? { name: frame.name } : {}),
        };
        return putInto(next, folded);
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot() {
      return records;
    },
  };
}
