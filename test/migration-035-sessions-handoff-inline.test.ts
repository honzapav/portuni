// Validates migration 035 (#329: sessions.handoff_inline for a
// server-generated handoff with no local mirror to write a file into).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";

describe("migration 035 sessions.handoff_inline", () => {
  it("upgrades a pre-035 database by adding the column, defaulting to NULL", async () => {
    const db = createClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    await db.execute("ALTER TABLE sessions DROP COLUMN handoff_inline");
    await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: ["035_sessions_handoff_inline"] });

    const before = await db.execute("PRAGMA table_info(sessions)");
    assert.ok(!before.rows.some((r) => r.name === "handoff_inline"));

    await ensureSchemaOn(db);

    const after = await db.execute("PRAGMA table_info(sessions)");
    assert.ok(after.rows.some((r) => r.name === "handoff_inline"));
  });

  it("a fresh install already has the column", async () => {
    const db = createClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    const cols = await db.execute("PRAGMA table_info(sessions)");
    assert.ok(cols.rows.some((r) => r.name === "handoff_inline"));
  });
});
