// Binds a live in-memory SessionScope (scope.ts) to the durable sessions /
// session_scope tables (domain/sessions.ts), so SessionScope becomes a cache
// over those rows rather than the sole record of a session's read/write
// scope -- the persisted row is what a session's node-detail history, review
// UI, and (later, #190) suspend/resume all read from.
//
// Deliberately fire-and-forget: a DB hiccup here must never break a live
// MCP tool call, which is why every write goes through safe() rather than
// being awaited by the caller. This means the persisted cache can lag or
// (rarely, on a narrow startup race with auto-seed) miss an entry -- an
// acceptable trade for phase 2, since nothing reads these rows back into a
// live decision yet (that lands with suspend/resume in #190).

import type { Client } from "@libsql/client";
import type { SessionScope, AddedVia } from "./scope.js";
import {
  createSession,
  upsertSessionScopeRead,
  setSessionScopeWritable,
  touchSession,
} from "../domain/sessions.js";
import type { RequestIdentity } from "../auth/request-identity.js";

function safe(promise: Promise<unknown>, what: string): void {
  promise.catch((err) => {
    console.error(`[portuni:session-persistence] ${what} failed:`, err);
  });
}

// The history is a list of {node_ids, addedVia, reason} batches, not one
// entry per node -- find the most recent batch mentioning nodeId (last
// entry wins, matching "latest classification"), defaulting to "seed" for
// nodes present before any expansion was recorded.
function classifyNode(scope: SessionScope, nodeId: string): { addedVia: AddedVia; reason: string } {
  const history = scope.expansions();
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].node_ids.includes(nodeId)) {
      return { addedVia: history[i].addedVia ?? "seed", reason: history[i].reason };
    }
  }
  return { addedVia: "seed", reason: "seed" };
}

// Every scope-mutating call site does `scope.add(id)` (or addWritable/
// addSeed, which call it internally) THEN `scope.recordExpansion({...})` --
// onAdd fires synchronously from inside add(), i.e. BEFORE that following
// recordExpansion call runs, so classifyNode would see stale history if it
// ran inline. queueMicrotask defers the read to after the current
// synchronous call stack (which includes that recordExpansion call, since
// nothing awaits between the two) drains -- classification is then always
// current. Only this listener's own timing is deferred; SessionScope's
// firing mechanism itself (used synchronously by the disk projector too) is
// untouched.
function syncRead(db: Client, sessionId: string, scope: SessionScope, nodeId: string): void {
  queueMicrotask(() => {
    const { addedVia, reason } = classifyNode(scope, nodeId);
    safe(upsertSessionScopeRead(db, sessionId, nodeId, addedVia, reason), `scope(${nodeId})`);
  });
}

// Writable grants have the same before-recordExpansion ordering issue, plus
// their own: addWritable() calls add() first (queuing that row's insert)
// before firing onWritable, so the read-scope row is not guaranteed to
// exist in the DB yet when a naive UPDATE would run. Chaining the upsert
// before the writable flip inside the SAME deferred, sequenced promise
// makes this listener self-contained instead of depending on the separate
// onAdd listener's unsequenced timing.
function syncWritable(db: Client, sessionId: string, scope: SessionScope, nodeId: string): void {
  queueMicrotask(() => {
    const { addedVia, reason } = classifyNode(scope, nodeId);
    safe(
      upsertSessionScopeRead(db, sessionId, nodeId, addedVia, reason).then(() =>
        setSessionScopeWritable(db, sessionId, nodeId),
      ),
      `writable(${nodeId})`,
    );
  });
}

// Creates the durable sessions row for a live MCP connection and binds
// scope.onAdd/onWritable so every future scope change mirrors into
// session_scope. Call once, right after constructing the SessionScope for a
// new connection (createMcpServer).
//
// profileId comes from the X-Portuni-Profile header (Claude only for now,
// see buildClaudeMcpJson) -- null for every other CLI/connection, which is
// indistinguishable from "no profile used" and treated the same way.
export function bindSessionPersistence(
  db: Client,
  scope: SessionScope,
  identity: Pick<RequestIdentity, "userId">,
  profileId: string | null = null,
): void {
  safe(
    (async () => {
      const row = await createSession(db, identity.userId, {
        node_id: scope.homeNodeId,
        session_type: scope.sessionType,
        profile_id: profileId,
      });
      scope.sessionId = row.id;

      // Catch-up: auto-seed can race ahead of this async INSERT, so persist
      // whatever is already in scope before wiring the listeners below.
      // Deferred for the same reason as syncRead/syncWritable -- a seed
      // batch's recordExpansion call may not have run yet either.
      for (const nodeId of scope.list()) {
        syncRead(db, row.id, scope, nodeId);
      }
      for (const nodeId of scope.writableNodes()) {
        syncWritable(db, row.id, scope, nodeId);
      }

      scope.onAdd((nodeId) => {
        syncRead(db, row.id, scope, nodeId);
        safe(touchSession(db, row.id), "touchSession");
      });
      scope.onWritable((nodeId) => {
        syncWritable(db, row.id, scope, nodeId);
      });
    })(),
    "createSession",
  );
}
