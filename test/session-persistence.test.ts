// Integration test for mcp/session-persistence.ts: SessionScope's in-memory
// read/write set stays mirrored into the sessions/session_scope tables as
// the session's live scope changes. bindSessionPersistence is deliberately
// fire-and-forget, so assertions poll rather than await a promise that
// doesn't exist at the call site -- the same shape a real caller (a test
// hitting the MCP tools, or a future consumer reading these rows) would see.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { bindSessionPersistence } from "../apps/server/mcp/session-persistence.js";
import { getSession, getSessionScope } from "../apps/server/domain/sessions.js";
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
