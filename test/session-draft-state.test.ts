// #374 ("the task canvas, threads in the left column, and the draft
// state"): domain-level coverage for the draft session state --
// createDraftSession/deleteDraftSession/pruneStaleDraftSessions, the
// draft -> running transition, and the name-from-first-message helper
// (mirrored server- and web-side, see domain/sessions.ts and
// apps/web/src/lib/session-chat.ts's own comments).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDraftSession,
  deleteDraftSession,
  pruneStaleDraftSessions,
  transitionSessionState,
  getSession,
  threadNameFromFirstMessage as serverThreadName,
} from "../apps/server/domain/sessions.js";
import { threadNameFromFirstMessage as webThreadName } from "../apps/web/src/lib/session-chat.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("createDraftSession", () => {
  it("creates a session in state 'draft' with no brief/runner and the default name", async () => {
    const { db, nodeId } = await makeSharedDb();
    const draft = await createDraftSession(db, "U1", nodeId);
    assert.equal(draft.state, "draft");
    assert.equal(draft.name, "Nový úkol");
    assert.equal("brief" in draft, false);
    assert.equal(draft.runner, null);
    assert.equal(draft.instance_id, null);
  });
});

// The session runtime never writes SQL itself (rule 1): a draft reaches
// the db through the store it is bound to, which is what lets agent mode
// create one on central instead.
describe("DbSessionStore.createDraft", () => {
  it("creates the same draft row createDraftSession does, carrying model/effort", async () => {
    const { db, nodeId } = await makeSharedDb();
    const draft = await new DbSessionStore(db).createDraft({
      node_id: nodeId,
      user_id: "U1",
      model: "sonnet",
      effort: "medium",
    });
    assert.equal(draft.state, "draft");
    assert.equal(draft.runner, null);
    assert.equal(draft.model, "sonnet");
    assert.equal(draft.effort, "medium");
  });

  // v2 rule 5: the device resolves the organisation's default runner and
  // instance before the request; the store only records, nulls included.
  it("records the runner and instance the device resolved, or nulls", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);
    const withRunner = await store.createDraft({ node_id: nodeId, user_id: "U1", runner: "claude", instance_id: "01INST" });
    assert.equal(withRunner.state, "draft");
    assert.equal(withRunner.runner, "claude");
    assert.equal(withRunner.instance_id, "01INST");
    const bare = await store.createDraft({ node_id: nodeId, user_id: "U1" });
    assert.equal(bare.runner, null);
    assert.equal(bare.instance_id, null);
  });
});

describe("draft -> running transition", () => {
  it("allows draft -> running", async () => {
    const { db, nodeId } = await makeSharedDb();
    const draft = await createDraftSession(db, "U1", nodeId);
    const updated = await transitionSessionState(db, "U1", draft.id, "running");
    assert.equal(updated.state, "running");
  });

  it("rejects draft -> closed (a draft is deleted, never closed)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const draft = await createDraftSession(db, "U1", nodeId);
    await assert.rejects(() => transitionSessionState(db, "U1", draft.id, "closed"));
  });
});

describe("deleteDraftSession", () => {
  it("removes a draft", async () => {
    const { db, nodeId } = await makeSharedDb();
    const draft = await createDraftSession(db, "U1", nodeId);
    await deleteDraftSession(db, "U1", draft.id);
    assert.equal(await getSession(db, draft.id), null);
  });

  it("refuses a non-draft session", async () => {
    const { db, nodeId } = await makeSharedDb();
    const draft = await createDraftSession(db, "U1", nodeId);
    await transitionSessionState(db, "U1", draft.id, "running");
    await assert.rejects(() => deleteDraftSession(db, "U1", draft.id));
    assert.ok(await getSession(db, draft.id), "the non-draft row must survive the refused delete");
  });
});

describe("pruneStaleDraftSessions", () => {
  it("deletes only drafts older than the cutoff, leaving recent drafts and non-drafts alone", async () => {
    const { db, nodeId } = await makeSharedDb();
    const old = await createDraftSession(db, "U1", nodeId);
    const recent = await createDraftSession(db, "U1", nodeId);
    const runningOld = await createDraftSession(db, "U1", nodeId);
    await transitionSessionState(db, "U1", runningOld.id, "running");

    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await db.execute({ sql: "UPDATE sessions SET created_at = ? WHERE id = ?", args: [oldTimestamp, old.id] });
    await db.execute({ sql: "UPDATE sessions SET created_at = ? WHERE id = ?", args: [oldTimestamp, runningOld.id] });

    const pruned = await pruneStaleDraftSessions(db, 24 * 60 * 60 * 1000);
    assert.equal(pruned, 1);
    assert.equal(await getSession(db, old.id), null);
    assert.ok(await getSession(db, recent.id), "a fresh draft must survive the sweep");
    assert.ok(await getSession(db, runningOld.id), "an old but non-draft session must survive the sweep");
  });
});

describe("threadNameFromFirstMessage (server + web copies)", () => {
  for (const [label, threadNameFromFirstMessage] of [
    ["server", serverThreadName],
    ["web", webThreadName],
  ] as const) {
    describe(label, () => {
      it("uses the first line, trimmed", () => {
        assert.equal(threadNameFromFirstMessage("  Fix the bug  \nmore detail here"), "Fix the bug");
      });

      it("collapses internal whitespace", () => {
        assert.equal(threadNameFromFirstMessage("Fix   the    bug"), "Fix the bug");
      });

      it("leaves a short message untouched", () => {
        assert.equal(threadNameFromFirstMessage("Short task"), "Short task");
      });

      it("truncates at ~60 chars on a word boundary with an ellipsis", () => {
        const long =
          "Please investigate why the nightly sync job fails intermittently on the staging environment";
        const name = threadNameFromFirstMessage(long);
        assert.ok(name.endsWith("…"));
        assert.ok(name.length <= 61, `expected <=61 chars, got ${name.length}: ${name}`);
        assert.ok(!name.slice(0, -1).endsWith(" "), "must not cut mid-word onto a trailing space");
      });
    });
  }
});
