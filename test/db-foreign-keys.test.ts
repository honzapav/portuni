import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
import { purgeNodeRows } from "../apps/server/domain/nodes.js";

// SQLite ships with foreign_keys OFF per connection. The schema relies on
// ON DELETE CASCADE (files, events, responsibilities, ...) for node purge,
// so every locally created connection must enable the pragma -- otherwise
// purging a node strands child rows that keep feeding discovery forever.
// Purge must also not trip the orphan-prevention edge trigger, which aborts
// when a belongs_to edge of a still-existing non-org node is deleted.
describe("node purge row cleanup", () => {
  it("purges a project including its files, events and edges rows", async () => {
    const { db, nodeId } = await makeSharedDb();

    await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, created_by)
            VALUES (?, ?, 'doc.md', 'U1')`,
      args: [ulid(), nodeId],
    });
    await db.execute({
      sql: `INSERT INTO events (id, node_id, type, content, created_by)
            VALUES (?, ?, 'note', 'hello', 'U1')`,
      args: [ulid(), nodeId],
    });

    await purgeNodeRows(db, nodeId);

    for (const table of ["nodes", "files", "events"]) {
      const r = await db.execute({
        sql: `SELECT COUNT(*) AS c FROM ${table} WHERE ${table === "nodes" ? "id" : "node_id"} = ?`,
        args: [nodeId],
      });
      assert.equal(Number(r.rows[0].c), 0, `${table} rows must be purged`);
    }
    const edges = await db.execute({
      sql: "SELECT COUNT(*) AS c FROM edges WHERE source_id = ? OR target_id = ?",
      args: [nodeId, nodeId],
    });
    assert.equal(Number(edges.rows[0].c), 0, "edges rows must be purged");
  });

  it("rejects inserting a file for a nonexistent node", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(
      () =>
        db.execute({
          sql: `INSERT INTO files (id, node_id, filename, created_by)
                VALUES (?, 'N0000000000000000000GHOST', 'x.md', 'U1')`,
          args: [ulid()],
        }),
      /FOREIGN KEY/i,
    );
  });

  it("enforces foreign keys on a reopened db where no migration runs", async () => {
    // First boot incidentally leaves foreign_keys ON because migrations
    // toggle the pragma. The regression case is the second boot: nothing
    // to migrate, so ensureSchemaOn itself must enable enforcement.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { createClient } = await import("@libsql/client");
    const { ensureSchemaOn } = await import("../apps/server/infra/schema.js");

    const dir = await mkdtemp(join(tmpdir(), "portuni-fk-"));
    try {
      const url = `file:${join(dir, "portuni.db")}`;
      const first = createClient({ url });
      await ensureSchemaOn(first);
      first.close();

      const second = createClient({ url });
      await ensureSchemaOn(second);
      await assert.rejects(
        () =>
          second.execute({
            sql: `INSERT INTO files (id, node_id, filename, created_by)
                  VALUES (?, 'N0000000000000000000GHOST', 'x.md', 'U1')`,
            args: [ulid()],
          }),
        /FOREIGN KEY/i,
      );
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
