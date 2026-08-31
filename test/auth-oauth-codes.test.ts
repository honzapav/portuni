import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSharedDb } from "./helpers/shared-db.js";
import {
  mintAuthorizationCode,
  redeemAuthorizationCode,
  attachGrantToCode,
} from "../apps/server/auth/oauth/codes.js";
import { mintGrant, verifyAccessToken } from "../apps/server/auth/oauth/grants.js";

const USER = "U1";
const CODE_INPUT = {
  userId: USER,
  clientId: "https://claude.ai/.well-known/client-metadata.json",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  codeChallenge: "abc123",
  resource: "https://api.portuni.com/mcp",
  scope: "portuni offline_access",
};

test("mint returns plaintext once; redeem resolves it", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintAuthorizationCode(db, CODE_INPUT);
  const result = await redeemAuthorizationCode(db, minted.code);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.code.codeId, minted.codeId);
  assert.equal(result.code.userId, USER);
  assert.equal(result.code.clientId, CODE_INPUT.clientId);
  assert.equal(result.code.redirectUri, CODE_INPUT.redirectUri);
  assert.equal(result.code.codeChallenge, CODE_INPUT.codeChallenge);
});

test("unknown code fails to redeem", async () => {
  const { db } = await makeSharedDb();
  const result = await redeemAuthorizationCode(db, "does-not-exist");
  assert.equal(result.ok, false);
});

test("expired code fails to redeem", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintAuthorizationCode(db, CODE_INPUT);
  await db.execute({
    sql: "UPDATE oauth_codes SET expires_at = datetime('now', '-1 second') WHERE id = ?",
    args: [minted.codeId],
  });
  const result = await redeemAuthorizationCode(db, minted.code);
  assert.equal(result.ok, false);
});

test("second redemption is single-use: fails, and revokes the attached grant", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintAuthorizationCode(db, CODE_INPUT);

  const first = await redeemAuthorizationCode(db, minted.code);
  assert.ok(first.ok);
  if (!first.ok) return;

  const grant = await mintGrant(db, {
    userId: USER,
    clientId: CODE_INPUT.clientId,
    clientName: "Claude",
    resource: CODE_INPUT.resource,
    scope: CODE_INPUT.scope,
  });
  await attachGrantToCode(db, first.code.codeId, grant.grantId);
  assert.ok(await verifyAccessToken(db, grant.accessToken));

  const replay = await redeemAuthorizationCode(db, minted.code);
  assert.equal(replay.ok, false);
  assert.equal(await verifyAccessToken(db, grant.accessToken), null);
});

test("second redemption without an attached grant still fails, without crashing", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintAuthorizationCode(db, CODE_INPUT);
  const first = await redeemAuthorizationCode(db, minted.code);
  assert.ok(first.ok);
  const replay = await redeemAuthorizationCode(db, minted.code);
  assert.equal(replay.ok, false);
});
