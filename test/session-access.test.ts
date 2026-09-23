// Unit tests for auth/session-access.ts's sessionAccess rule (spec:
// docs/superpowers/specs/2026-09-22-local-sessions-design.md, "Access"):
// one line, every action the owner's, against makeSharedDb fixtures.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { setDbForTesting } from "../apps/server/infra/db.js";
import {
  sessionAccess,
  SessionAccessError,
  type SessionAccessAction,
} from "../apps/server/auth/session-access.js";
import { createSession } from "../apps/server/domain/sessions.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { insertIgnore } from "../apps/server/infra/sql.js";

const OWNER = "U1";
const OTHER = "U2";
const ACTIONS: readonly SessionAccessAction[] = ["read", "message", "stop", "resume"];

afterEach(() => {
  setDbForTesting(null);
});

function identity(userId: string, globalScope: RequestIdentity["globalScope"] = "write"): RequestIdentity {
  return {
    userId,
    email: `${userId.toLowerCase()}@x.com`,
    name: userId,
    globalScope,
    groups: [],
    groupIds: [],
    via: "env",
  };
}

async function shared(): Promise<SharedDb> {
  const s = await makeSharedDb();
  await s.db.execute({
    sql: insertIgnore(s.db.dialect, "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)"),
    args: [OTHER, "u2@x.com", "U2"],
  });
  setDbForTesting(s.db);
  return s;
}

async function expectNotFound(promise: Promise<unknown>) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof SessionAccessError);
    assert.equal(err.code, "SESSION_NOT_FOUND");
    return true;
  });
}

describe("sessionAccess: a thread is its owner's", () => {
  it("the owner may do every action", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    for (const action of ACTIONS) {
      const row = await sessionAccess(s.db, identity(OWNER), session.id, action);
      assert.equal(row.id, session.id);
    }
  });

  it("a non-owner who can see the anchor node gets SESSION_NOT_FOUND for every action", async () => {
    const s = await shared();
    // makeSharedDb's node is visible to everyone; seeing it no longer says
    // anything about the threads anchored on it.
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    for (const action of ACTIONS) {
      await expectNotFound(sessionAccess(s.db, identity(OTHER), session.id, action));
    }
  });

  it("manage scope grants nothing -- SESSION_NOT_FOUND for every action, stop included", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    for (const action of ACTIONS) {
      await expectNotFound(sessionAccess(s.db, identity(OTHER, "manage"), session.id, action));
    }
  });

  it("admin scope grants nothing either", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: s.nodeId, session_type: "interactive_task" });
    await expectNotFound(sessionAccess(s.db, identity(OTHER, "admin"), session.id, "stop"));
  });

  it("a node-less session (interactive_chat) is the owner's too, and hidden from everyone else", async () => {
    const s = await shared();
    const session = await createSession(s.db, OWNER, { node_id: null, session_type: "interactive_chat" });
    assert.equal((await sessionAccess(s.db, identity(OWNER), session.id, "read")).id, session.id);
    for (const action of ACTIONS) {
      await expectNotFound(sessionAccess(s.db, identity(OTHER, "manage"), session.id, action));
    }
  });

  it("an unknown session id is SESSION_NOT_FOUND", async () => {
    const s = await shared();
    await expectNotFound(sessionAccess(s.db, identity(OWNER), ulid(), "read"));
  });
});
