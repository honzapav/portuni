import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Pinned to libsql: this file builds its own SQLite DDL and/or drives the
// libsql migration path (runMigrationNNN) directly -- neither has a
// Postgres form (schema.pg.ts's baseline already carries the end state).
import { openTestDb } from "./helpers/db.js";
import type { DbClient as Client } from "../apps/server/infra/db.js";
import { generateSyncKey, slugifyForSyncKey } from "../apps/server/domain/sync/sync-key.js";

async function freshDb(): Promise<Client> {
  const db = await openTestDb("libsql");
  await db.execute(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY, type TEXT, name TEXT, sync_key TEXT UNIQUE,
    created_by TEXT, created_at DATETIME, updated_at DATETIME
  )`);
  return db;
}

describe("sync-key", () => {
  it("slugifyForSyncKey lowercases + strips diacritics", () => {
    assert.equal(slugifyForSyncKey("Stan GWS"), "stan-gws");
    assert.equal(slugifyForSyncKey("Návrhy cenotvorby"), "navrhy-cenotvorby");
  });
  it("generateSyncKey returns slug when unique", async () => {
    const db = await freshDb();
    const k = await generateSyncKey(db, "Stan GWS");
    assert.equal(k, "stan-gws");
  });
  it("generateSyncKey appends ULID suffix on collision", async () => {
    const db = await freshDb();
    await db.execute({ sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)", args: ["N1", "project", "Stan GWS", "stan-gws", "U1"] });
    const k = await generateSyncKey(db, "Stan GWS");
    assert.ok(k.startsWith("stan-gws-"), `expected suffix, got ${k}`);
    assert.notEqual(k, "stan-gws");
  });
  it("handles empty / unslugifiable names by falling back to ULID", async () => {
    const db = await freshDb();
    const k = await generateSyncKey(db, "!!!");
    assert.ok(k.length > 0);
    assert.match(k, /^[a-z0-9-]+$/);
  });
});
