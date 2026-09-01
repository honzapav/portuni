// Binds a live in-memory SessionScope (scope.ts) to the durable sessions /
// session_scope tables (domain/sessions.ts), so SessionScope becomes a cache
// over those rows rather than the sole record of a session's read/write
// scope -- the persisted row is what a session's node-detail history, review
// UI, and suspend/resume all read from.
//
// bindSessionPersistence (the fresh-session path) stays deliberately
// fire-and-forget: a DB hiccup here must never break a live MCP tool call,
// which is why every write goes through safe() rather than being awaited by
// the caller. This means the persisted cache can lag or (rarely, on a narrow
// startup race with auto-seed) miss an entry -- an acceptable trade, since
// nothing reads these rows back into a live decision on that path (a brand
// new session's in-memory scope IS the authoritative state; the DB rows are
// only a cache/audit of it).
//
// resumeSessionPersistence (#204) is different on purpose: it IS the read
// that seeds a live decision (guardNodeRead consults the rehydrated
// in-memory scope), so it is awaited by the caller instead.

import type { Client } from "@libsql/client";
import type { SessionScope, AddedVia } from "./scope.js";
import {
  createSession,
  getSessionScope,
  loadResumableSession,
  transitionSessionState,
  upsertSessionScopeRead,
  setSessionScopeWritable,
  touchSession,
} from "../domain/sessions.js";
import { getMirrorPath } from "../domain/sync/mirror-registry.js";
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

// Shared by the fresh-create and resume-attach paths: replay whatever is
// already in scope (catch-up) and wire onAdd/onWritable so every future
// scope change mirrors into session_scope. Split out so resumeSessionPersistence
// can reuse it without duplicating the listener wiring.
function wireOngoingSync(db: Client, scope: SessionScope, sessionId: string): void {
  for (const nodeId of scope.list()) {
    syncRead(db, sessionId, scope, nodeId);
  }
  for (const nodeId of scope.writableNodes()) {
    syncWritable(db, sessionId, scope, nodeId);
  }

  scope.onAdd((nodeId) => {
    syncRead(db, sessionId, scope, nodeId);
    safe(touchSession(db, sessionId), "touchSession");
  });
  scope.onWritable((nodeId) => {
    syncWritable(db, sessionId, scope, nodeId);
  });
}

// Creates the durable sessions row for a live MCP connection and binds
// scope.onAdd/onWritable so every future scope change mirrors into
// session_scope. Call once, right after constructing the SessionScope for a
// new connection (createMcpServer) -- never for a resumed connection, see
// resumeSessionPersistence.
//
// profileId comes from the X-Portuni-Profile header (Claude only for now,
// see buildClaudeMcpJson) -- null for every other CLI/connection, which is
// indistinguishable from "no profile used" and treated the same way.
//
// homeNodeId is the connection's `?home_node_id` value, read explicitly
// rather than off `scope.homeNodeId`: this function's async body is kicked
// off (fire-and-forget) by createMcpServer BEFORE the caller's subsequent
// auto-seed call sets `scope.homeNodeId` (transport.ts calls createMcpServer,
// then awaits autoSeedFromHome), so reading the property here would race and
// persist node_id=null for every interactive_task/headless session. Passing
// the raw query value sidesteps the race; omitting the parameter (existing
// test harnesses that set `scope.homeNodeId` by hand before calling this)
// falls back to the property for compatibility.
export function bindSessionPersistence(
  db: Client,
  scope: SessionScope,
  identity: Pick<RequestIdentity, "userId">,
  profileId: string | null = null,
  homeNodeId?: string | null,
): void {
  safe(
    (async () => {
      const row = await createSession(db, identity.userId, {
        node_id: homeNodeId !== undefined ? homeNodeId : scope.homeNodeId,
        session_type: scope.sessionType,
        profile_id: profileId,
      });
      scope.sessionId = row.id;

      // Catch-up: auto-seed can race ahead of this async INSERT, so persist
      // whatever is already in scope before wiring the listeners below.
      // Deferred for the same reason as syncRead/syncWritable -- a seed
      // batch's recordExpansion call may not have run yet either.
      wireOngoingSync(db, scope, row.id);
    })(),
    "createSession",
  );
}

// Resume (#204, "Resume restores the disk plane but not the graph plane"):
// attach a fresh MCP connection to an EXISTING suspended session row instead
// of minting a new one, and rehydrate the in-memory SessionScope from the
// persisted session_scope rows -- otherwise the sandbox grants the
// accumulated mirrors (sandbox-profile.ts's restart consolidation) while
// guardNodeRead refuses exactly those nodes, because a fresh in-memory scope
// starts empty.
//
// Unlike bindSessionPersistence this is AWAITED by the caller (transport.ts,
// before auto-seed and before the connection is allowed to proceed) rather
// than fire-and-forget: resume must be authorized and rehydrated before any
// tool call can be served, so a race here would be a scope bypass, not just
// a lagging audit cache. Returns the resumed session id, or null when
// resumeSessionId does not resolve to a session this user owns, anchored to
// homeNodeId, in the suspended state (domain/sessions.ts's
// loadResumableSession) -- the caller must refuse the connection rather than
// silently falling back to a fresh session, which would look like a
// successful resume to the agent while actually starting from empty scope.
export async function resumeSessionPersistence(
  db: Client,
  scope: SessionScope,
  identity: Pick<RequestIdentity, "userId">,
  resumeSessionId: string,
  homeNodeId: string | null,
): Promise<string | null> {
  if (!homeNodeId) return null;
  const resumable = await loadResumableSession(db, identity.userId, homeNodeId, resumeSessionId);
  if (!resumable) return null;

  const row = await transitionSessionState(db, identity.userId, resumable.id, "running");
  scope.sessionId = row.id;
  scope.homeNodeId = homeNodeId;

  const accumulated = await getSessionScope(db, row.id);
  for (const scopeRow of accumulated) {
    // Nodes still mirrored on this device get their real path re-granted by
    // resolveSandboxScopeForNode's restart consolidation (readMirrors widened
    // with resumeSessionId) -- mark them seed so read tools return the real
    // mirror and the disk projector does not also hardlink them. Nodes with
    // no local mirror here have no disk grant either way (spec, "Disk
    // contract": "a node with no local mirror on this device has no
    // projection either way") -- plain add() keeps them in read scope for
    // portuni_read_file / graph tools.
    const hasLocalMirror = (await getMirrorPath(identity.userId, scopeRow.node_id)) !== null;
    if (hasLocalMirror) scope.addSeed(scopeRow.node_id);
    else scope.add(scopeRow.node_id);
    if (scopeRow.writable) scope.addWritable(scopeRow.node_id);
  }
  if (accumulated.length > 0) {
    scope.recordExpansion({
      at: new Date().toISOString(),
      node_ids: accumulated.map((r) => r.node_id),
      reason: "session resumed: rehydrated from persisted session_scope",
      triggered_by: "init",
    });
  }

  wireOngoingSync(db, scope, row.id);
  return row.id;
}
