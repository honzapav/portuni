import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeSharedDb } from "./helpers/shared-db.js";
import {
  mintGrant,
  verifyAccessToken,
  rotateRefreshToken,
  revokeGrant,
  listGrantsForUser,
} from "../apps/server/auth/oauth/grants.js";

const USER = "U1";
const INPUT = {
  userId: USER,
  clientId: "https://claude.ai/.well-known/client-metadata.json",
  clientName: "Claude",
  resource: "https://api.portuni.com/mcp",
  scope: "portuni offline_access",
};

test("mint returns plaintext once; verify resolves the grant", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintGrant(db, INPUT);
  assert.ok(minted.accessToken.startsWith("poa_"));
  assert.ok(minted.refreshToken.startsWith("por_"));
  const hit = await verifyAccessToken(db, minted.accessToken);
  assert.ok(hit);
  assert.equal(hit.userId, USER);
  assert.equal(hit.grantId, minted.grantId);
  assert.equal(hit.resource, INPUT.resource);
});

test("plaintext tokens are not stored", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintGrant(db, INPUT);
  const r = await db.execute({
    sql: "SELECT access_token_hash, refresh_token_hash FROM oauth_grants WHERE id = ?",
    args: [minted.grantId],
  });
  assert.equal(
    r.rows[0].access_token_hash,
    createHash("sha256").update(minted.accessToken).digest("hex"),
  );
  assert.equal(
    r.rows[0].refresh_token_hash,
    createHash("sha256").update(minted.refreshToken).digest("hex"),
  );
});

test("unknown access token verifies to null", async () => {
  const { db } = await makeSharedDb();
  assert.equal(await verifyAccessToken(db, "poa_does-not-exist"), null);
});

test("revoked grant stops verifying access", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintGrant(db, INPUT);
  assert.ok(await revokeGrant(db, USER, minted.grantId));
  assert.equal(await verifyAccessToken(db, minted.accessToken), null);
});

test("revoke is ownership-scoped", async () => {
  const { db } = await makeSharedDb();
  await db.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)",
    args: ["U2", "other@x.com", "Other"],
  });
  const minted = await mintGrant(db, INPUT);
  const ok = await revokeGrant(db, "U2", minted.grantId);
  assert.equal(ok, false);
  assert.ok(await verifyAccessToken(db, minted.accessToken), "token still valid");
});

test("refresh rotation mints new tokens and invalidates the old access token check stays live", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintGrant(db, INPUT);
  const result = await rotateRefreshToken(db, minted.refreshToken);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.notEqual(result.grant.accessToken, minted.accessToken);
  assert.notEqual(result.grant.refreshToken, minted.refreshToken);
  assert.equal(result.grant.grantId, minted.grantId);
  // Old access token no longer verifies; new one does.
  assert.equal(await verifyAccessToken(db, minted.accessToken), null);
  assert.ok(await verifyAccessToken(db, result.grant.accessToken));
});

test("replay of the superseded refresh token revokes the grant", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintGrant(db, INPUT);
  const first = await rotateRefreshToken(db, minted.refreshToken);
  assert.ok(first.ok);
  if (!first.ok) return;

  // Reusing the original (now-superseded) refresh token is theft evidence.
  const replay = await rotateRefreshToken(db, minted.refreshToken);
  assert.equal(replay.ok, false);

  // The grant is revoked outright -- even the freshly rotated refresh token
  // (which was valid a moment ago) no longer works.
  const afterRevoke = await rotateRefreshToken(db, first.grant.refreshToken);
  assert.equal(afterRevoke.ok, false);
  assert.equal(await verifyAccessToken(db, first.grant.accessToken), null);
});

test("older refresh generations fail without revoking the grant", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintGrant(db, INPUT);
  const first = await rotateRefreshToken(db, minted.refreshToken);
  assert.ok(first.ok);
  if (!first.ok) return;
  const second = await rotateRefreshToken(db, first.grant.refreshToken);
  assert.ok(second.ok);
  if (!second.ok) return;

  // `minted.refreshToken` is now two generations old: matches neither
  // refresh_token_hash nor prev_refresh_token_hash. Plain invalid_grant,
  // no revocation -- the current (second-generation) tokens still work.
  const stale = await rotateRefreshToken(db, minted.refreshToken);
  assert.equal(stale.ok, false);
  assert.ok(await verifyAccessToken(db, second.grant.accessToken));
});

test("expired refresh token fails absolute, regardless of activity", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintGrant(db, INPUT);
  // Simulate the 180-day absolute expiry having passed.
  await db.execute({
    sql: "UPDATE oauth_grants SET refresh_expires_at = datetime('now', '-1 second') WHERE id = ?",
    args: [minted.grantId],
  });
  const result = await rotateRefreshToken(db, minted.refreshToken);
  assert.equal(result.ok, false);
});

test("unknown refresh token fails without touching any grant", async () => {
  const { db } = await makeSharedDb();
  await mintGrant(db, INPUT);
  const result = await rotateRefreshToken(db, "por_does-not-exist");
  assert.equal(result.ok, false);
});

test("listGrantsForUser excludes revoked grants and scopes by user", async () => {
  const { db } = await makeSharedDb();
  await db.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)",
    args: ["U2", "other@x.com", "Other"],
  });
  const mine = await mintGrant(db, INPUT);
  await mintGrant(db, { ...INPUT, userId: "U2" });
  const revoked = await mintGrant(db, INPUT);
  await revokeGrant(db, USER, revoked.grantId);

  const rows = await listGrantsForUser(db, USER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, mine.grantId);
});
