import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { createClient } from "@libsql/client";
import { DDL } from "../apps/server/infra/schema-triggers.js";
import { runMigrations } from "../apps/server/infra/schema-migrations.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("migration 019 node_access", () => {
  it("creates node_access on fresh install (DDL)", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    const t = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='node_access'",
    );
    assert.equal(t.rows.length, 1);
  });
});

// Uses the shared-db fixture (full ensureSchemaOn, migration 019 already
// applied on an empty DB) then simulates a pre-migration DB by inserting a
// node with the legacy meta.access_group key and re-running the migrations
// loop with the 019 marker removed -- same trick as
// files-unique-remote.test.ts's dedupe-repair case.
test("migration 019 backfills meta.access_group into node_access and strips the key", async () => {
  const { db } = await makeSharedDb();
  const id = ulid();
  const email = "partners@tempo.ooo";

  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, sync_key, created_by, visibility, meta)
          VALUES (?, 'project', 'Access Group Node', ?, 'U1', 'group', ?)`,
    args: [id, `project:access-group-${id}`, JSON.stringify({ access_group: email, other: 1 })],
  });

  await db.execute({
    sql: "DELETE FROM migrations WHERE id = ?",
    args: ["019_node_access"],
  });

  await runMigrations(db);

  const accessRows = await db.execute({
    sql: "SELECT kind, principal, display_email, added_by FROM node_access WHERE node_id = ?",
    args: [id],
  });
  assert.equal(accessRows.rows.length, 1, "expected exactly one backfilled node_access row");
  assert.equal(accessRows.rows[0].kind, "group");
  assert.equal(accessRows.rows[0].principal, email);
  assert.equal(accessRows.rows[0].display_email, email);
  assert.equal(accessRows.rows[0].added_by, "migration");

  const nodeRow = await db.execute({
    sql: "SELECT meta, visibility FROM nodes WHERE id = ?",
    args: [id],
  });
  const meta = JSON.parse(String(nodeRow.rows[0].meta));
  assert.equal(meta.access_group, undefined, "access_group key must be stripped from meta");
  assert.equal(meta.other, 1, "unrelated meta keys must survive the migration");
  assert.equal(nodeRow.rows[0].visibility, "group", "visibility is untouched by the backfill");
});

// Task 14 point 5: mixed-case access_group email must be lowercased on
// backfill (node_access.principal / display_email are compared
// case-sensitively elsewhere, so a mixed-case leftover would silently break
// group matching for every member).
test("migration 019 lowercases a mixed-case access_group email on backfill", async () => {
  const { db } = await makeSharedDb();
  const id = ulid();
  const mixedCaseEmail = "Partners@Tempo.ooo";

  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, sync_key, created_by, visibility, meta)
          VALUES (?, 'project', 'Mixed Case Node', ?, 'U1', 'group', ?)`,
    args: [id, `project:mixed-case-${id}`, JSON.stringify({ access_group: mixedCaseEmail })],
  });

  await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["019_node_access"] });
  await runMigrations(db);

  const accessRows = await db.execute({
    sql: "SELECT principal, display_email FROM node_access WHERE node_id = ?",
    args: [id],
  });
  assert.equal(accessRows.rows.length, 1);
  assert.equal(accessRows.rows[0].principal, "partners@tempo.ooo", "principal must be lowercased");
  assert.equal(accessRows.rows[0].display_email, "partners@tempo.ooo", "display_email must be lowercased");
});

// Task 14 point 5: a node with valid meta but no access_group key must not
// be touched by the backfill (no node_access row created, meta untouched).
test("migration 019 leaves a node with meta but no access_group untouched", async () => {
  const { db } = await makeSharedDb();
  const id = ulid();

  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, sync_key, created_by, meta)
          VALUES (?, 'project', 'No Access Group Node', ?, 'U1', ?)`,
    args: [id, `project:no-access-group-${id}`, JSON.stringify({ unrelated: "value" })],
  });

  await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["019_node_access"] });
  await runMigrations(db);

  const accessRows = await db.execute({
    sql: "SELECT principal FROM node_access WHERE node_id = ?",
    args: [id],
  });
  assert.equal(accessRows.rows.length, 0, "no node_access row should be created");

  const nodeRow = await db.execute({ sql: "SELECT meta FROM nodes WHERE id = ?", args: [id] });
  const meta = JSON.parse(String(nodeRow.rows[0].meta));
  assert.equal(meta.unrelated, "value", "meta must be untouched");
});

// Task 14 point 5: a node with an INVALID JSON meta column must not abort
// the whole migration -- json_extract() throws on malformed JSON, and
// without the json_valid() guard in the backfill WHERE clause that
// exception propagates out of runMigrations() and no node gets backfilled,
// not just the offending one.
test("migration 019 skips a node with invalid JSON meta without aborting the backfill for others", async () => {
  const { db } = await makeSharedDb();
  const badId = ulid();
  const goodId = ulid();
  const goodEmail = "goodgroup@tempo.ooo";

  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, sync_key, created_by, meta)
          VALUES (?, 'project', 'Bad Meta Node', ?, 'U1', ?)`,
    // Not valid JSON -- a bare unquoted string.
    args: [badId, `project:bad-meta-${badId}`, "not valid json {"],
  });
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, sync_key, created_by, visibility, meta)
          VALUES (?, 'project', 'Good Meta Node', ?, 'U1', 'group', ?)`,
    args: [goodId, `project:good-meta-${goodId}`, JSON.stringify({ access_group: goodEmail })],
  });

  await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["019_node_access"] });
  await assert.doesNotReject(runMigrations(db), "invalid meta on one node must not abort the migration");

  const badRows = await db.execute({
    sql: "SELECT principal FROM node_access WHERE node_id = ?",
    args: [badId],
  });
  assert.equal(badRows.rows.length, 0, "the node with invalid meta gets no backfilled row");

  const goodRows = await db.execute({
    sql: "SELECT principal FROM node_access WHERE node_id = ?",
    args: [goodId],
  });
  assert.equal(goodRows.rows.length, 1, "other nodes must still be backfilled");
  assert.equal(goodRows.rows[0].principal, goodEmail);

  const badNodeRow = await db.execute({ sql: "SELECT meta FROM nodes WHERE id = ?", args: [badId] });
  assert.equal(badNodeRow.rows[0].meta, "not valid json {", "the invalid meta column itself is left untouched");
});
