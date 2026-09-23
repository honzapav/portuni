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
  closeSessionIfRunning,
  suspendStaleRunningSessionsOnBoot,
} from "../apps/server/domain/sessions.js";
import { parseServerHandoffReason } from "../apps/server/domain/session-handoff.js";
import { makeSharedDb } from "./helpers/shared-db.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
import { installTestContentDb } from "./helpers/content-db.js";

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
  it("formats '<node name> · <date> <time>' from an ISO timestamp", () => {
    assert.equal(
      computeDefaultSessionName("Stan GWS", "2026-05-01T10:00:00.000Z"),
      "Stan GWS · 2026-05-01 10:00",
    );
  });

  it("falls back to 'Chat' when there is no anchor node", () => {
    assert.equal(computeDefaultSessionName(null, "2026-05-01T10:00:00.000Z"), "Chat · 2026-05-01 10:00");
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

// #456: the inline summary is content -- the record keeps only the hash,
// the text goes to this device's content.db.
describe("closeSessionIfRunning (#218, GC backstop; #329 suspends)", () => {
  it("suspends a running session with a disconnect handoff", async () => {
    const { db, nodeId } = await makeSharedDb();
    const { content } = await installTestContentDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await closeSessionIfRunning(db, row.id, "disconnect");
    const updated = await getSession(db, row.id);
    assert.equal(updated?.state, "suspended");
    assert.equal(updated?.handoff_inline, null, "nothing content-shaped stays on the record");
    const inline = (await content.getContent(row.id))?.handoff_inline ?? null;
    assert.equal(parseServerHandoffReason(inline), "disconnect");
  });

  it("records idle as the reason when that is the caller's reason", async () => {
    const { db, nodeId } = await makeSharedDb();
    const { content } = await installTestContentDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await closeSessionIfRunning(db, row.id, "idle");
    const inline = (await content.getContent(row.id))?.handoff_inline ?? null;
    assert.equal(parseServerHandoffReason(inline), "idle");
  });

  it("never touches a suspended session", async () => {
    const { db, nodeId } = await makeSharedDb();
    const { content } = await installTestContentDb();
    const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await transitionSessionState(db, "U1", row.id, "suspended");
    await closeSessionIfRunning(db, row.id, "disconnect");
    const updated = await getSession(db, row.id);
    assert.equal(updated?.state, "suspended");
    assert.equal(
      (await content.getContent(row.id))?.handoff_inline ?? null,
      null,
      "an already-suspended session's handoff is left alone",
    );
  });

  it("is a no-op for an unknown session id", async () => {
    const { db } = await makeSharedDb();
    await installTestContentDb();
    await assert.doesNotReject(closeSessionIfRunning(db, "nope", "disconnect"));
  });
});

describe("suspendStaleRunningSessionsOnBoot (#272; #329 suspends)", () => {
  // A restart never reaches the runtime's own run_ended, so the run row
  // stays open and the log ends on run_started -- which every client
  // replays as a live run (working row, stop button) on a session the
  // server says is suspended. The sweep ends the run and says so.
  it("ends the dangling run and appends run_ended + state_changed, so a replay sees no live run", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);
    const { content } = await installTestContentDb();
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    const run = await store.createRun({ session_id: session.id, runner: "fake", instance_id: null, host_id: null });
    await content.appendEvents(session.id, run.id, [
      { kind: "run_started", payload: { run_id: run.id, runner: "fake", instance_id: null, resume: null } },
    ]);

    await suspendStaleRunningSessionsOnBoot(db);

    const [runRow] = await store.listRuns(session.id);
    assert.ok(runRow.ended_at, "the run row is ended");
    assert.equal(runRow.end_reason, "suspended");
    const kinds = (await content.listEvents(session.id)).map((e) => `${e.kind}:${(JSON.parse(e.payload) as { run_id?: string; to?: string }).run_id ?? (JSON.parse(e.payload) as { to?: string }).to ?? ""}`);
    assert.deepEqual(kinds, [`run_started:${run.id}`, `run_ended:${run.id}`, "state_changed:suspended"]);
    assert.equal((await getSession(db, session.id))?.state, "suspended");
  });

  it("appends nothing extra for a session whose run the runtime already ended", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);
    const { content } = await installTestContentDb();
    const session = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    const run = await store.createRun({ session_id: session.id, runner: "fake", instance_id: null, host_id: null });
    await store.patchRun(run.id, { ended_at: new Date().toISOString(), end_reason: "completed" });
    const before = (await content.listEvents(session.id)).length;
    await suspendStaleRunningSessionsOnBoot(db);
    assert.equal((await content.listEvents(session.id)).length, before);
    assert.equal((await store.listRuns(session.id))[0].end_reason, "completed", "an ended run is left alone");
  });


  it("suspends every running row with a boot_sweep handoff, process-wide, leaving suspended untouched", async () => {
    const { db, nodeId } = await makeSharedDb();
    const { content } = await installTestContentDb();
    const running1 = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    const running2 = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });
    const suspended = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await transitionSessionState(db, "U1", suspended.id, "suspended");

    const swept = await suspendStaleRunningSessionsOnBoot(db);
    assert.equal(swept, 2);

    const row1 = await getSession(db, running1.id);
    const row2 = await getSession(db, running2.id);
    assert.equal(row1?.state, "suspended");
    assert.equal(row2?.state, "suspended");
    const inline1 = (await content.getContent(running1.id))?.handoff_inline ?? null;
    const inline2 = (await content.getContent(running2.id))?.handoff_inline ?? null;
    assert.equal(parseServerHandoffReason(inline1), "boot_sweep");
    assert.equal(parseServerHandoffReason(inline2), "boot_sweep");
    assert.equal((await getSession(db, suspended.id))?.state, "suspended");
  });

  it("is a no-op when nothing is running", async () => {
    const { db } = await makeSharedDb();
    await installTestContentDb();
    assert.equal(await suspendStaleRunningSessionsOnBoot(db), 0);
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

  // #317 retention: the event log of an archived session is dropped once
  // closed_at is older than the retention window; runs, the row and the
  // handoff stay, and a younger archived session or a merely closed one
  // keeps its events.
  it("deletes session_events only of archived sessions closed longer ago than the retention window", async () => {
    const { db, nodeId } = await makeSharedDb();
    // The retention sweep prunes the graph db's own `session_events`, which
    // stays until the central migration (#462) even though nothing writes
    // it after #456 -- a content store over the graph db writes exactly
    // that table, which is what makes this assertable at all.
    const legacyEvents = new SessionContentStore(db);
    const oldArchived = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });
    const youngArchived = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });
    const closedOnly = await createSession(db, "U1", { node_id: nodeId, session_type: "headless" });
    for (const s of [oldArchived, youngArchived, closedOnly]) {
      await legacyEvents.appendEvents(s.id, null, [{ kind: "assistant_message", payload: { text: "hi" } }]);
      await transitionSessionState(db, "U1", s.id, "closed");
    }
    const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    await db.execute({ sql: "UPDATE sessions SET closed_at = ? WHERE id = ?", args: [days(120), oldArchived.id] });
    await db.execute({ sql: "UPDATE sessions SET closed_at = ? WHERE id = ?", args: [days(45), youngArchived.id] });
    await db.execute({ sql: "UPDATE sessions SET closed_at = ? WHERE id = ?", args: [days(120), closedOnly.id] });
    for (const id of [oldArchived.id, youngArchived.id]) {
      await db.execute({ sql: "UPDATE sessions SET state = 'archived' WHERE id = ?", args: [id] });
    }
    // Archive window longer than any closed_at here, so this pass archives
    // nothing and only the retention step acts.
    await autoArchiveClosedSessions(db, 365 * 24 * 60 * 60 * 1000, 90 * 24 * 60 * 60 * 1000);

    assert.equal((await getSession(db, oldArchived.id))?.state, "archived");
    assert.equal((await getSession(db, youngArchived.id))?.state, "archived");
    assert.equal((await getSession(db, closedOnly.id))?.state, "closed");
    assert.equal((await legacyEvents.listEvents(oldArchived.id)).length, 0);
    assert.equal((await legacyEvents.listEvents(youngArchived.id)).length, 1);
    assert.equal((await legacyEvents.listEvents(closedOnly.id)).length, 1);
  });
});

// #329, the file branch: with a mirror registered on this device the
// server-generated handoff is a real file at the same path the agent's own
// portuni_session_suspend would use, not handoff_inline.
describe("closeSessionIfRunning with a local mirror (#329)", () => {
  it("writes the handoff file into the mirror and records its path and reason", async () => {
    const { db, nodeId } = await makeSharedDb();
    const { mkdtemp, mkdir, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { setDbForTesting } = await import("../apps/server/infra/db.js");
    const { registerMirror } = await import("../apps/server/domain/sync/mirror-registry.js");
    const { resetLocalDbForTests } = await import("../apps/server/domain/sync/local-db.js");
    const workspace = await mkdtemp(join(tmpdir(), "portuni-sessions-handoff-"));
    const previousRoot = process.env.PORTUNI_WORKSPACE_ROOT;
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    setDbForTesting(db);
    try {
      const mirrorRoot = join(workspace, "mirror");
      await mkdir(mirrorRoot, { recursive: true });
      await registerMirror("U1", nodeId, mirrorRoot);
      const row = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });

      await closeSessionIfRunning(db, row.id, "disconnect");

      const after = await getSession(db, row.id);
      assert.equal(after?.state, "suspended");
      assert.ok(after?.handoff_path, "a mirror on this device means a real handoff file");
      assert.equal(after?.handoff_inline, null);
      const content = await readFile(join(mirrorRoot, after!.handoff_path!), "utf8");
      assert.equal(parseServerHandoffReason(content), "disconnect");
      assert.match(content, /Konverzace nebyla uložena/);
    } finally {
      setDbForTesting(null);
      resetLocalDbForTests();
      if (previousRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
      else process.env.PORTUNI_WORKSPACE_ROOT = previousRoot;
      await rm(workspace, { recursive: true, force: true });
    }
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
