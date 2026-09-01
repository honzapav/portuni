// Tests for apps/server/domain/sessions.ts: session CRUD, the state
// machine, auto-archive, and the session_scope read/write cache functions.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  getSession,
  listSessions,
  touchSession,
  transitionSessionState,
  autoArchiveClosedSessions,
  upsertSessionScopeRead,
  setSessionScopeWritable,
  getSessionScope,
  getSessionWriteCount,
  renameSession,
  computeDefaultSessionName,
  loadResumableSession,
} from "../apps/server/domain/sessions.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("createSession / getSession / listSessions", () => {
  it("creates a session row and reads it back", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    assert.equal(row.node_id, nodeId);
    assert.equal(row.user_id, "U1");
    assert.equal(row.session_type, "interactive_task");
    assert.equal(row.state, "running");
    assert.equal(row.closed_at, null);

    const fetched = await getSession(db, row.id);
    assert.deepEqual(fetched, row);
  });

  it("allows a null node_id for interactive_chat (no anchor)", async () => {
    const { db } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: null, session_type: "interactive_chat" });
    assert.equal(row.node_id, null);
  });

  it("getSession returns null for an unknown id", async () => {
    const { db } = await makeSharedDb();
    assert.equal(await getSession(db, "nope"), null);
  });

  it("uses a caller-supplied preassignedId instead of minting one (#208 follow-up)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const preassigned = "N000000000000000PREASSIGN1";
    assert.equal(preassigned.length, 26);
    const row = await createSession(
      db,
      "U1",
      { node_id: nodeId, session_type: "interactive_task" },
      preassigned,
    );
    assert.equal(row.id, preassigned);
    assert.ok(await getSession(db, preassigned));
  });

  it("listSessions filters by node_id, user_id, and state", async () => {
    const { db, nodeId } = await makeSharedDb();
    await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await createSession(db, "U1", { node_id: null, session_type: "interactive_chat" });
    const otherNode = "N0000000000000000000000OTH";
    await db.execute({
      sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
      args: [otherNode, "project", "Other", "other", "U1"],
    });
    await createSession(db, "U1", { node_id: otherNode, session_type: "headless" });

    const forNode = await listSessions(db, { node_id: nodeId });
    assert.equal(forNode.length, 1);
    assert.equal(forNode[0].node_id, nodeId);

    const forUser = await listSessions(db, { user_id: "U1" });
    assert.equal(forUser.length, 3);

    const headlessOnly = await listSessions(db, { state: "running", user_id: "U1" });
    assert.equal(headlessOnly.length, 3); // all still running

    const all = await listSessions(db);
    assert.ok(all.length >= 3);
  });
});

describe("computeDefaultSessionName", () => {
  it("formats '<node name> · <date>' from an ISO timestamp", () => {
    assert.equal(computeDefaultSessionName("Stan GWS", "2026-05-01T10:00:00.000Z"), "Stan GWS · 2026-05-01");
  });

  it("falls back to 'Chat' when there is no anchor node", () => {
    assert.equal(computeDefaultSessionName(null, "2026-05-01T10:00:00.000Z"), "Chat · 2026-05-01");
  });
});

describe("createSession: default name", () => {
  it("names a new session '<node name> · <today>'", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    assert.equal(row.name, computeDefaultSessionName("Stan GWS", row.created_at));
    assert.equal(row.name_is_custom, 0);
  });

  it("names an anchor-less interactive_chat session 'Chat · <today>'", async () => {
    const { db } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: null, session_type: "interactive_chat" });
    assert.equal(row.name, computeDefaultSessionName(null, row.created_at));
  });
});

describe("renameSession", () => {
  it("renames a session and marks name_is_custom", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    const renamed = await renameSession(db, "U1", row.id, "  My renamed session  ");
    assert.equal(renamed.name, "My renamed session");
    assert.equal(renamed.name_is_custom, 1);
  });

  it("rejects an empty (or whitespace-only) name", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await assert.rejects(renameSession(db, "U1", row.id, "   "), /must not be empty/);
  });

  it("throws for an unknown session id", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(renameSession(db, "U1", "nope", "x"), /not found/);
  });
});

describe("getSessionWriteCount", () => {
  it("counts only writable session_scope rows", async () => {
    const { db, nodeId } = await makeSharedDb();
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    assert.equal(await getSessionWriteCount(db, session.id), 0);

    await upsertSessionScopeRead(db, session.id, nodeId, "seed", null);
    assert.equal(await getSessionWriteCount(db, session.id), 0, "readable but not yet writable");

    await setSessionScopeWritable(db, session.id, nodeId);
    assert.equal(await getSessionWriteCount(db, session.id), 1);
  });
});

describe("touchSession", () => {
  it("bumps last_active_at", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await new Promise((r) => setTimeout(r, 5));
    await touchSession(db, row.id);
    const fetched = await getSession(db, row.id);
    assert.ok(fetched);
    assert.ok(new Date(fetched!.last_active_at).getTime() >= new Date(row.last_active_at).getTime());
  });
});

describe("transitionSessionState: the state machine", () => {
  it("running -> suspended -> running -> closed -> archived is a valid path", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });

    const suspended = await transitionSessionState(db, "U1", row.id, "suspended");
    assert.equal(suspended.state, "suspended");
    assert.equal(suspended.closed_at, null);

    const resumed = await transitionSessionState(db, "U1", row.id, "running");
    assert.equal(resumed.state, "running");

    const closed = await transitionSessionState(db, "U1", row.id, "closed");
    assert.equal(closed.state, "closed");
    assert.ok(closed.closed_at);

    const archived = await transitionSessionState(db, "U1", row.id, "archived");
    assert.equal(archived.state, "archived");
  });

  it("rejects an invalid transition (running -> archived directly)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });
    await assert.rejects(
      transitionSessionState(db, "U1", row.id, "archived"),
      /not a valid transition/,
    );
  });

  it("rejects any transition out of archived (terminal)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });
    await transitionSessionState(db, "U1", row.id, "closed");
    await transitionSessionState(db, "U1", row.id, "archived");
    await assert.rejects(
      transitionSessionState(db, "U1", row.id, "running"),
      /not a valid transition/,
    );
  });

  it("is a no-op (not an error) when the target state equals the current state", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });
    const result = await transitionSessionState(db, "U1", row.id, "running");
    assert.equal(result.state, "running");
  });

  it("throws for an unknown session id", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(transitionSessionState(db, "U1", "nope", "closed"), /not found/);
  });
});

describe("loadResumableSession: resume authorization gate (#204)", () => {
  it("returns the row when owned by the caller, anchored to the node, and suspended", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await transitionSessionState(db, "U1", row.id, "suspended");

    const resumable = await loadResumableSession(db, "U1", nodeId, row.id);
    assert.ok(resumable);
    assert.equal(resumable?.id, row.id);
  });

  it("refuses when owned by a different user", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await transitionSessionState(db, "U1", row.id, "suspended");

    assert.equal(await loadResumableSession(db, "U2", nodeId, row.id), null);
  });

  it("refuses when the requested node does not match the session's anchor", async () => {
    const { db, nodeId, orgId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await transitionSessionState(db, "U1", row.id, "suspended");

    assert.equal(await loadResumableSession(db, "U1", orgId, row.id), null);
  });

  it("refuses when the session is not suspended (e.g. still running)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });

    assert.equal(await loadResumableSession(db, "U1", nodeId, row.id), null);
  });

  it("refuses for an unknown session id", async () => {
    const { db, nodeId } = await makeSharedDb();
    assert.equal(await loadResumableSession(db, "U1", nodeId, "nope"), null);
  });
});

describe("autoArchiveClosedSessions", () => {
  it("archives closed sessions older than the cutoff, leaves recent ones alone", async () => {
    const { db, nodeId } = await makeSharedDb();
    const old = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });
    const recent = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });

    await transitionSessionState(db, "U1", old.id, "closed");
    await transitionSessionState(db, "U1", recent.id, "closed");
    // Backdate `old`'s closed_at well past the cutoff; leave `recent` as-is.
    await db.execute({
      sql: "UPDATE sessions SET closed_at = ? WHERE id = ?",
      args: [new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(), old.id],
    });

    const archivedCount = await autoArchiveClosedSessions(db, 1000 * 60 * 60 * 24 * 30);
    assert.equal(archivedCount, 1);

    const oldFetched = await getSession(db, old.id);
    const recentFetched = await getSession(db, recent.id);
    assert.equal(oldFetched?.state, "archived");
    assert.equal(recentFetched?.state, "closed");
  });

  it("never touches running/suspended sessions", async () => {
    const { db, nodeId } = await makeSharedDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });
    const count = await autoArchiveClosedSessions(db, 0);
    assert.equal(count, 0);
    const fetched = await getSession(db, row.id);
    assert.equal(fetched?.state, "running");
  });
});

describe("session_scope: read cache + writable flag", () => {
  it("upsertSessionScopeRead inserts a row with writable=0, addedVia/reason as given", async () => {
    const { db, nodeId } = await makeSharedDb();
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await upsertSessionScopeRead(db, session.id, nodeId, "seed", "session_init seed");
    const rows = await getSessionScope(db, session.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].node_id, nodeId);
    assert.equal(rows[0].added_via, "seed");
    assert.equal(rows[0].reason, "session_init seed");
    assert.equal(rows[0].writable, 0);
  });

  it("re-adding the same node updates added_via/reason without touching writable", async () => {
    const { db, nodeId } = await makeSharedDb();
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await upsertSessionScopeRead(db, session.id, nodeId, "seed", "session_init seed");
    await setSessionScopeWritable(db, session.id, nodeId);
    await upsertSessionScopeRead(db, session.id, nodeId, "edge", "edge-reachable");

    const rows = await getSessionScope(db, session.id);
    assert.equal(rows.length, 1, "still one row, not a duplicate");
    assert.equal(rows[0].added_via, "edge");
    assert.equal(rows[0].reason, "edge-reachable");
    assert.equal(rows[0].writable, 1, "writable survives the re-add");
  });

  it("setSessionScopeWritable marks an existing row writable", async () => {
    const { db, nodeId } = await makeSharedDb();
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await upsertSessionScopeRead(db, session.id, nodeId, "created", "node created by this session");
    await setSessionScopeWritable(db, session.id, nodeId);
    const rows = await getSessionScope(db, session.id);
    assert.equal(rows[0].writable, 1);
  });

  it("getSessionScope returns an empty array for a session with no scope yet", async () => {
    const { db, nodeId } = await makeSharedDb();
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_chat" });
    assert.deepEqual(await getSessionScope(db, session.id), []);
  });

  // #208: a node reached via a disconnected jump (privileged, requires a
  // declared reason) must not have that classification erased by a later,
  // routine edge-reachable re-touch -- the spec's "repeated disconnected
  // jumps to the same node" signal depends on it staying visible.
  it("a disconnected-then-edge sequence keeps reporting disconnected (never downgrades)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });
    await upsertSessionScopeRead(db, session.id, nodeId, "disconnected", "headless jump: investigating an incident");
    await upsertSessionScopeRead(db, session.id, nodeId, "edge", "edge-reachable");

    const rows = await getSessionScope(db, session.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].added_via, "disconnected", "must not be downgraded to edge");
    assert.equal(rows[0].reason, "headless jump: investigating an incident");
  });

  it("an edge-then-disconnected sequence upgrades to disconnected", async () => {
    const { db, nodeId } = await makeSharedDb();
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });
    await upsertSessionScopeRead(db, session.id, nodeId, "edge", "edge-reachable");
    await upsertSessionScopeRead(db, session.id, nodeId, "disconnected", "headless jump: investigating an incident");

    const rows = await getSessionScope(db, session.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].added_via, "disconnected");
    assert.equal(rows[0].reason, "headless jump: investigating an incident");
  });

  it("elicited and disconnected are equally privileged -- a later elicited re-touch still upgrades over seed", async () => {
    const { db, nodeId } = await makeSharedDb();
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await upsertSessionScopeRead(db, session.id, nodeId, "seed", "session_init seed");
    await upsertSessionScopeRead(db, session.id, nodeId, "elicited", "user confirmed via dialog");

    const rows = await getSessionScope(db, session.id);
    assert.equal(rows[0].added_via, "elicited");
    assert.equal(rows[0].reason, "user confirmed via dialog");
  });
});
