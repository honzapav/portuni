// Integration test for mcp/session-persistence.ts: SessionScope's in-memory
// read/write set stays mirrored into the sessions/session_scope tables as
// the session's live scope changes. bindSessionPersistence is deliberately
// fire-and-forget, so assertions poll rather than await a promise that
// doesn't exist at the call site -- the same shape a real caller (a test
// hitting the MCP tools, or a future consumer reading these rows) would see.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { bindSessionPersistence, resumeSessionPersistence } from "../apps/server/mcp/session-persistence.js";
import {
  createSession,
  getSession,
  getSessionScope,
  transitionSessionState,
  upsertSessionScopeRead,
  setSessionScopeWritable,
} from "../apps/server/domain/sessions.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`);
}

async function neighbourNode(shared: SharedDb, name: string): Promise<string> {
  const id = ulid();
  await shared.db.execute({
    sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
    args: [id, "project", name, name.toLowerCase(), "U1"],
  });
  return id;
}

describe("bindSessionPersistence: SessionScope as a cache over session_scope", () => {
  it("creates the sessions row and catches up on scope already seeded before binding resolved", async () => {
    const shared = await makeSharedDb();
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = shared.nodeId;

    bindSessionPersistence(shared.db, scope, { userId: "U1" });
    // Fires synchronously, immediately after construction -- exercises the
    // catch-up path: this add happens before createSession's INSERT settles.
    scope.addSeed(shared.nodeId);
    scope.recordExpansion({
      at: new Date().toISOString(),
      node_ids: [shared.nodeId],
      reason: "session_init seed (home + depth-1)",
      triggered_by: "init",
    });

    await waitUntil(() => scope.sessionId !== null);
    const sessionId = scope.sessionId!;

    const sessionRow = await getSession(shared.db, sessionId);
    assert.ok(sessionRow);
    assert.equal(sessionRow!.node_id, shared.nodeId);
    assert.equal(sessionRow!.user_id, "U1");
    assert.equal(sessionRow!.session_type, "interactive_task");

    await waitUntil(async () => (await getSessionScope(shared.db, sessionId)).length === 1);
    const rows = await getSessionScope(shared.db, sessionId);
    assert.equal(rows[0].node_id, shared.nodeId);
    assert.equal(rows[0].added_via, "seed");
  });

  it("stores the profile id (phase 3, spawn UX) when the caller passes one", async () => {
    const shared = await makeSharedDb();
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = shared.nodeId;

    bindSessionPersistence(shared.db, scope, { userId: "U1" }, "work");
    scope.addSeed(shared.nodeId);
    scope.recordExpansion({
      at: new Date().toISOString(),
      node_ids: [shared.nodeId],
      reason: "session_init seed (home + depth-1)",
      triggered_by: "init",
    });

    await waitUntil(() => scope.sessionId !== null);
    const sessionRow = await getSession(shared.db, scope.sessionId!);
    assert.equal(sessionRow!.profile_id, "work");
  });

  it("reuses a pre-assigned spawnSessionId (#208 follow-up) instead of minting a new one", async () => {
    const shared = await makeSharedDb();
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = shared.nodeId;
    const preassigned = ulid();

    bindSessionPersistence(shared.db, scope, { userId: "U1" }, null, undefined, preassigned);
    scope.addSeed(shared.nodeId);
    scope.recordExpansion({
      at: new Date().toISOString(),
      node_ids: [shared.nodeId],
      reason: "session_init seed (home + depth-1)",
      triggered_by: "init",
    });

    await waitUntil(() => scope.sessionId !== null);
    assert.equal(scope.sessionId, preassigned);
    const sessionRow = await getSession(shared.db, preassigned);
    assert.ok(sessionRow, "the row must exist under the caller-supplied id");
  });

  it("mirrors a later expansion (onAdd) into a new session_scope row, matching scope.list()", async () => {
    const shared = await makeSharedDb();
    const other = await neighbourNode(shared, "Neighbour");
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = shared.nodeId;
    bindSessionPersistence(shared.db, scope, { userId: "U1" });
    scope.addSeed(shared.nodeId);
    await waitUntil(() => scope.sessionId !== null);
    const sessionId = scope.sessionId!;
    await waitUntil(async () => (await getSessionScope(shared.db, sessionId)).length === 1);

    scope.add(other);
    scope.recordExpansion({
      at: new Date().toISOString(),
      node_ids: [other],
      reason: "edge-reachable from the current scope set",
      triggered_by: "traversal",
      addedVia: "edge",
    });

    await waitUntil(async () => (await getSessionScope(shared.db, sessionId)).length === 2);
    const rows = await getSessionScope(shared.db, sessionId);
    const nodeIds = new Set(rows.map((r) => r.node_id));
    assert.deepEqual(nodeIds, new Set(scope.list()));
    const otherRow = rows.find((r) => r.node_id === other);
    assert.equal(otherRow?.added_via, "edge");
    assert.equal(otherRow?.writable, 0);
  });

  it("mirrors addWritable (onWritable) into session_scope.writable, matching scope.writableNodes()", async () => {
    const shared = await makeSharedDb();
    const scope = new SessionScope("interactive_task");
    scope.homeNodeId = shared.nodeId;
    bindSessionPersistence(shared.db, scope, { userId: "U1" });
    scope.addSeed(shared.nodeId);
    await waitUntil(() => scope.sessionId !== null);
    const sessionId = scope.sessionId!;
    await waitUntil(async () => (await getSessionScope(shared.db, sessionId)).length === 1);

    const created = await neighbourNode(shared, "Created");
    scope.addWritable(created);
    scope.recordExpansion({
      at: new Date().toISOString(),
      node_ids: [created],
      reason: "node created by this session",
      triggered_by: "agent",
      addedVia: "created",
    });

    await waitUntil(async () => (await getSessionScope(shared.db, sessionId)).length === 2);
    await waitUntil(async () => {
      const rows = await getSessionScope(shared.db, sessionId);
      return rows.find((r) => r.node_id === created)?.writable === 1;
    });

    const rows = await getSessionScope(shared.db, sessionId);
    const writableNodeIds = new Set(rows.filter((r) => r.writable === 1).map((r) => r.node_id));
    assert.deepEqual(writableNodeIds, new Set(scope.writableNodes()));
  });

  it("a session_type=env SessionScope still gets a persisted row (not exempt from persistence, only from the scope gate)", async () => {
    const shared = await makeSharedDb();
    const scope = new SessionScope("env");
    bindSessionPersistence(shared.db, scope, { userId: "U1" });
    await waitUntil(() => scope.sessionId !== null);
    const row = await getSession(shared.db, scope.sessionId!);
    assert.equal(row?.session_type, "env");
    assert.equal(row?.node_id, null);
  });
});

describe("resumeSessionPersistence: graph-plane reattach on resume (#204)", () => {
  let workspace: string;
  let originalRoot: string | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-resume-persist-"));
    originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
  });

  afterEach(async () => {
    resetLocalDbForTests();
    if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
    else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
    await rm(workspace, { recursive: true, force: true });
  });

  it("attaches to the existing session, rehydrates read/write scope, and transitions suspended -> running", async () => {
    const shared = await makeSharedDb();
    const other = await neighbourNode(shared, "Neighbour");
    await registerMirror("U1", shared.nodeId, join(workspace, "home"));
    await registerMirror("U1", other, join(workspace, "other"));

    const suspended = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "interactive_task",
    });
    await upsertSessionScopeRead(shared.db, suspended.id, shared.nodeId, "seed", "seed");
    await upsertSessionScopeRead(shared.db, suspended.id, other, "disconnected", "expand");
    await setSessionScopeWritable(shared.db, suspended.id, other);
    await transitionSessionState(shared.db, "U1", suspended.id, "suspended");

    const scope = new SessionScope("interactive_task");
    const resumedId = await resumeSessionPersistence(
      shared.db,
      scope,
      { userId: "U1" },
      suspended.id,
      shared.nodeId,
    );

    assert.equal(resumedId, suspended.id);
    assert.equal(scope.sessionId, suspended.id);
    assert.equal(scope.homeNodeId, shared.nodeId);
    assert.ok(scope.has(shared.nodeId));
    assert.ok(scope.has(other));
    assert.ok(scope.canWrite(other));
    assert.ok(scope.isSeed(other), "a node with a local mirror on this device is treated as seed");

    const row = await getSession(shared.db, suspended.id);
    assert.equal(row?.state, "running");
  });

  it("marks a node with no local mirror on this device as in-scope but not seed", async () => {
    const shared = await makeSharedDb();
    const noMirrorNode = await neighbourNode(shared, "NoMirror");
    await registerMirror("U1", shared.nodeId, join(workspace, "home"));

    const suspended = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "interactive_task",
    });
    await upsertSessionScopeRead(shared.db, suspended.id, noMirrorNode, "disconnected", "expand");
    await transitionSessionState(shared.db, "U1", suspended.id, "suspended");

    const scope = new SessionScope("interactive_task");
    await resumeSessionPersistence(shared.db, scope, { userId: "U1" }, suspended.id, shared.nodeId);

    assert.ok(scope.has(noMirrorNode));
    assert.ok(!scope.isSeed(noMirrorNode));
  });

  it("returns null and leaves the session row untouched when the resume id is unauthorized", async () => {
    const shared = await makeSharedDb();
    await shared.db.execute({
      sql: "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)",
      args: ["someone-else", "else@x.com", "Someone Else"],
    });
    const suspended = await createSession(shared.db, "someone-else", {
      node_id: shared.nodeId,
      session_type: "interactive_task",
    });
    await transitionSessionState(shared.db, "someone-else", suspended.id, "suspended");

    const scope = new SessionScope("interactive_task");
    const resumedId = await resumeSessionPersistence(
      shared.db,
      scope,
      { userId: "U1" },
      suspended.id,
      shared.nodeId,
    );

    assert.equal(resumedId, null);
    assert.equal(scope.sessionId, null);
    assert.equal(scope.homeNodeId, null);
    const row = await getSession(shared.db, suspended.id);
    assert.equal(row?.state, "suspended");
  });

  it("returns null when homeNodeId is absent (resume requires an explicit anchor)", async () => {
    const shared = await makeSharedDb();
    const suspended = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "interactive_task",
    });
    await transitionSessionState(shared.db, "U1", suspended.id, "suspended");

    const scope = new SessionScope("interactive_task");
    const resumedId = await resumeSessionPersistence(shared.db, scope, { userId: "U1" }, suspended.id, null);

    assert.equal(resumedId, null);
  });

  it("mirrors further scope changes after resume into session_scope, same as a fresh session", async () => {
    const shared = await makeSharedDb();
    const other = await neighbourNode(shared, "Later");
    await registerMirror("U1", shared.nodeId, join(workspace, "home"));

    const suspended = await createSession(shared.db, "U1", {
      node_id: shared.nodeId,
      session_type: "interactive_task",
    });
    await upsertSessionScopeRead(shared.db, suspended.id, shared.nodeId, "seed", "seed");
    await transitionSessionState(shared.db, "U1", suspended.id, "suspended");

    const scope = new SessionScope("interactive_task");
    await resumeSessionPersistence(shared.db, scope, { userId: "U1" }, suspended.id, shared.nodeId);

    scope.add(other);
    scope.recordExpansion({
      at: new Date().toISOString(),
      node_ids: [other],
      reason: "edge-reachable from the current scope set",
      triggered_by: "traversal",
      addedVia: "edge",
    });

    await waitUntil(async () => (await getSessionScope(shared.db, suspended.id)).some((r) => r.node_id === other));
    const rows = await getSessionScope(shared.db, suspended.id);
    assert.ok(rows.some((r) => r.node_id === other && r.added_via === "edge"));
  });
});
