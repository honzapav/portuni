import { test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
import { NODE_VISIBILITIES } from "../apps/server/shared/popp.js";

test("NODE_VISIBILITIES includes group", () => {
  assert.ok((NODE_VISIBILITIES as readonly string[]).includes("group"));
});

test("nodes accept visibility='group' after migration", async () => {
  const { db, orgId } = await makeSharedDb();
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
          VALUES (?, 'project', 'Secret', 'active', 'group', ?, '01SOLO0000000000000000000')`,
    args: [id, `project:secret-${id}`],
  });
  await db.execute({
    sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by)
          VALUES (?, ?, ?, 'belongs_to', '01SOLO0000000000000000000')`,
    args: [ulid(), id, orgId],
  });
  const r = await db.execute({
    sql: "SELECT visibility FROM nodes WHERE id = ?",
    args: [id],
  });
  assert.equal(r.rows[0].visibility, "group");
});

test("invalid visibility still rejected", async () => {
  const { db } = await makeSharedDb();
  await assert.rejects(
    db.execute({
      sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
            VALUES (?, 'project', 'Bad', 'active', 'nonsense', ?, '01SOLO0000000000000000000')`,
      args: [ulid(), `project:bad-${Date.now()}`],
    }),
  );
});

test("org-invariant triggers survive the rebuild", async () => {
  const { db } = await makeSharedDb();
  const r = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='trigger'",
  );
  const names = r.rows.map((x) => String(x.name));
  assert.ok(
    names.some((n) => n.includes("prevent_multi_parent_org") || n.includes("prevent_orphan_on_edge_delete")),
    `expected org triggers, got: ${names.join(", ")}`,
  );
});
