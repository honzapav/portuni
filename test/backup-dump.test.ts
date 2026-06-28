import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient, type Client } from "@libsql/client";
import { ulid } from "ulid";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { dumpDatabaseSql } from "../apps/server/infra/backup.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-backup-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seededDb(url: string): Promise<{ db: Client; orgId: string; nodeId: string }> {
  const db = createClient({ url });
  await ensureSchemaOn(db);
  const orgId = ulid();
  const nodeId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?, 'organization', 'Org', 'org', '01SOLO0000000000000000000')",
    args: [orgId],
  });
  await db.execute({
    sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?, 'project', 'Proj', 'proj', '01SOLO0000000000000000000')",
    args: [nodeId],
  });
  await db.execute({
    sql: "INSERT INTO edges (id,source_id,target_id,relation,created_by) VALUES (?, ?, ?, 'belongs_to', '01SOLO0000000000000000000')",
    args: [ulid(), nodeId, orgId],
  });
  return { db, orgId, nodeId };
}

describe("dumpDatabaseSql", () => {
  it("produces a dump that restores into a working database", async () => {
    const { db, nodeId } = await seededDb(":memory:");
    const sql = await dumpDatabaseSql(db);

    const restored = createClient({ url: ":memory:" });
    await restored.executeMultiple(sql);
    const node = await restored.execute({
      sql: "SELECT name FROM nodes WHERE id = ?",
      args: [nodeId],
    });
    assert.equal(node.rows[0].name, "Proj");
    const fk = await restored.execute("PRAGMA foreign_key_check");
    assert.equal(fk.rows.length, 0, "restored dump must have no FK violations");
    // Triggers survive the roundtrip (restore must reproduce schema, not
    // just data).
    const trg = await restored.execute(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger'",
    );
    assert.ok(Number(trg.rows[0].c) > 0, "triggers must be part of the dump");
  });

  it("is a consistent snapshot: a write landing mid-dump cannot appear in it", async () => {
    const url = `file:${join(dir, "snap.db")}`;
    const { db } = await seededDb(url);
    const writer = createClient({ url });

    const lateId = ulid();
    let writeError: unknown = null;
    let writePromise: Promise<unknown> | null = null;

    // The progress hook fires between tables (alphabetically; "actors"
    // comes long before "nodes"). The old per-query implementation read
    // each table in its own auto-commit statement, so this INSERT landed
    // inside the dump of a later table -- a snapshot that never existed.
    const sql = await dumpDatabaseSql(db, async ({ table }) => {
      if (table === "actors" && writePromise === null) {
        writePromise = writer
          .execute({
            sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?, 'organization', 'Late', 'late', '01SOLO0000000000000000000')",
            args: [lateId],
          })
          .catch((e) => {
            // Equally acceptable: the dump's read transaction blocks the
            // writer entirely (SQLITE_BUSY). Consistency either way.
            writeError = e;
            return null;
          });
        // Give the write a real chance to land mid-dump.
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    if (writePromise) await writePromise;
    writer.close();

    assert.ok(
      !sql.includes(lateId),
      `mid-dump write must not appear in the dump (writeError=${String(writeError)})`,
    );
  });
});
