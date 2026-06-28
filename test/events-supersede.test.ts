import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
import { supersedeEventInternal } from "../apps/server/domain/events.js";

async function seedEvent(
  db: Awaited<ReturnType<typeof makeSharedDb>>["db"],
  nodeId: string,
): Promise<string> {
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO events (id, node_id, type, content, created_by)
          VALUES (?, ?, 'note', 'original', 'U1')`,
    args: [id, nodeId],
  });
  return id;
}

describe("supersedeEventInternal", () => {
  it("marks the old event superseded and links the replacement", async () => {
    const { db, nodeId } = await makeSharedDb();
    const oldId = await seedEvent(db, nodeId);

    const r = await supersedeEventInternal(db, "U1", {
      eventId: oldId,
      newContent: "replacement",
    });
    assert.equal(r.superseded_id, oldId);
    assert.equal(r.node_id, nodeId);

    const oldRow = await db.execute({
      sql: "SELECT status FROM events WHERE id = ?",
      args: [oldId],
    });
    assert.equal(oldRow.rows[0].status, "superseded");
    const newRow = await db.execute({
      sql: "SELECT content, status, refs FROM events WHERE id = ?",
      args: [r.new_id],
    });
    assert.equal(newRow.rows[0].content, "replacement");
    assert.equal(newRow.rows[0].status, "active");
    assert.deepEqual(JSON.parse(newRow.rows[0].refs as string), [oldId]);
  });

  it("leaves the old event active when the replacement insert fails", async () => {
    const { db, nodeId } = await makeSharedDb();
    const oldId = await seedEvent(db, nodeId);

    // Orphan the event (pre-FK-era data): with foreign_keys back ON the
    // replacement INSERT hits an FK violation. The supersede UPDATE must
    // roll back with it -- sequential statements would strand the old
    // event as superseded with no successor.
    await db.execute("PRAGMA foreign_keys = OFF");
    // Node first: once the node row is gone the orphan-prevention edge
    // trigger's type-subquery is NULL and stays quiet.
    await db.execute({ sql: "DELETE FROM nodes WHERE id = ?", args: [nodeId] });
    await db.execute({ sql: "DELETE FROM edges WHERE source_id = ?", args: [nodeId] });
    await db.execute("PRAGMA foreign_keys = ON");

    await assert.rejects(() =>
      supersedeEventInternal(db, "U1", { eventId: oldId, newContent: "won't land" }),
    );
    const oldRow = await db.execute({
      sql: "SELECT status FROM events WHERE id = ?",
      args: [oldId],
    });
    assert.equal(
      oldRow.rows[0].status,
      "active",
      "old event must stay active when the replacement was not created",
    );
  });

  it("throws for an unknown event id", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(
      () => supersedeEventInternal(db, "U1", { eventId: "NOPE", newContent: "x" }),
      /not found/,
    );
  });
});
