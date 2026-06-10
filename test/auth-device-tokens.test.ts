import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSharedDb } from "./helpers/shared-db.js";
import {
  mintDeviceToken,
  verifyDeviceToken,
  revokeDeviceToken,
  listDeviceTokens,
} from "../src/auth/device-tokens.js";

const USER = "01SOLO0000000000000000000";

test("mint returns plaintext once; verify resolves the user", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintDeviceToken(db, USER, "MacBook – Claude Code");
  assert.ok(minted.token.startsWith("ptk_"));
  const hit = await verifyDeviceToken(db, minted.token);
  assert.ok(hit);
  assert.equal(hit.userId, USER);
  assert.equal(hit.tokenId, minted.id);
});

test("plaintext token is not stored", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintDeviceToken(db, USER, "x");
  const r = await db.execute({
    sql: "SELECT token_hash FROM device_tokens WHERE id = ?",
    args: [minted.id],
  });
  assert.notEqual(r.rows[0].token_hash, minted.token);
});

test("revoked token stops verifying; list shows revoked_at", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintDeviceToken(db, USER, "x");
  await revokeDeviceToken(db, USER, minted.id);
  assert.equal(await verifyDeviceToken(db, minted.token), null);
  const rows = await listDeviceTokens(db, USER);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].revoked_at);
});

test("expired token stops verifying", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintDeviceToken(db, USER, "x", { ttlDays: -1 });
  assert.equal(await verifyDeviceToken(db, minted.token), null);
});

test("unknown token verifies to null", async () => {
  const { db } = await makeSharedDb();
  assert.equal(await verifyDeviceToken(db, "ptk_does-not-exist"), null);
});
