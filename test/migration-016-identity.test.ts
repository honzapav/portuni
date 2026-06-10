import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ensureSchemaOn } from "../src/infra/schema.js";

test("migration 016 adds identity columns to users", async () => {
  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  const cols = await db.execute("PRAGMA table_info(users)");
  const names = cols.rows.map((r) => r.name as string);
  assert.ok(names.includes("google_sub"));
  assert.ok(names.includes("avatar_url"));
  assert.ok(names.includes("last_login_at"));
});

test("migration 016 creates device_tokens with expected columns", async () => {
  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  const cols = await db.execute("PRAGMA table_info(device_tokens)");
  const names = cols.rows.map((r) => r.name as string);
  for (const c of [
    "id", "user_id", "label", "token_hash",
    "created_at", "expires_at", "revoked_at", "last_used_at",
  ]) {
    assert.ok(names.includes(c), `missing column ${c}`);
  }
});

test("migration 016 is idempotent (re-running ensureSchemaOn is safe)", async () => {
  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  await ensureSchemaOn(db); // must not throw
  const r = await db.execute(
    "SELECT count(*) AS n FROM migrations WHERE id = '016_users_identity'",
  );
  assert.equal(Number(r.rows[0].n), 1);
});
