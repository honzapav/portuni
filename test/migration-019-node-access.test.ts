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
