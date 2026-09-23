// #457: a thread is its owner's -- and so is the handoff pointer a node's
// orientation (PORTUNI_SCOPE.md, a run's provisioning, GET
// /nodes/:id/orientation) carries. Another user's suspended thread on the
// same node never lends its name or handoff path to this user's
// orientation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { insertIgnore } from "../apps/server/infra/sql.js";
import { createSession } from "../apps/server/domain/sessions.js";
import { orientationForNode } from "../apps/server/domain/scope-materialize.js";
import { makeSharedDb } from "./helpers/shared-db.js";

test("a node's orientation points at the caller's own suspended thread only", async () => {
  const { db, nodeId } = await makeSharedDb();
  setDbForTesting(db);
  try {
    await db.execute({
      sql: insertIgnore(db.dialect, "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)"),
      args: ["U2", "u2@x.com", "U2"],
    });
    const suspend = async (user: string, name: string, at: string) => {
      const s = await createSession(db, user, { node_id: nodeId, session_type: "interactive_task" });
      await db.execute({
        sql: "UPDATE sessions SET state = 'suspended', name = ?, handoff_path = ?, last_active_at = ? WHERE id = ?",
        args: [name, `wip/sessions/${s.id}-handoff.md`, at, s.id],
      });
      return s.id;
    };
    const mine = await suspend("U1", "Moje vlákno", "2026-09-20 08:00:00");
    // The other user's thread is the newer one: without the owner filter it
    // would be the pointer.
    await suspend("U2", "Cizí vlákno", "2026-09-21 08:00:00");

    const orientation = await orientationForNode(nodeId, "U1");
    assert.equal(orientation?.handoff?.sessionName, "Moje vlákno");
    assert.equal(orientation?.handoff?.handoffPath, `wip/sessions/${mine}-handoff.md`);

    const nobody = await orientationForNode(nodeId, "U3");
    assert.equal(nobody?.handoff, null);
  } finally {
    setDbForTesting(null);
  }
});
