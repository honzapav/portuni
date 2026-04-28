import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { generateSyncKey, slugifyForSyncKey } from "../src/domain/sync/sync-key.js";

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
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
