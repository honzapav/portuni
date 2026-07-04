import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  signSessionToken,
  verifySessionToken,
} from "../apps/server/auth/session-token.js";

const SECRET = "test-secret-at-least-32-chars-long!!";

test("round-trips claims", async () => {
  const token = await signSessionToken(
    {
      userId: "01USER0000000000000000000",
      email: "a@x.com",
      name: "A",
      globalScope: "manage",
      groups: ["apollo@x.com"],
      groupIds: ["01abc"],
    },
    SECRET,
  );
  const claims = await verifySessionToken(token, SECRET);
  assert.ok(claims);
  assert.equal(claims.userId, "01USER0000000000000000000");
  assert.equal(claims.globalScope, "manage");
  assert.deepEqual(claims.groups, ["apollo@x.com"]);
  assert.deepEqual(claims.groupIds, ["01abc"]);
});

test("rejects wrong secret", async () => {
  const token = await signSessionToken(
    {
      userId: "u",
      email: "a@x.com",
      name: "A",
      globalScope: "read",
      groups: [],
      groupIds: [],
    },
    SECRET,
  );
  assert.equal(await verifySessionToken(token, "other-secret-32-chars-long!!!!!!"), null);
});

test("rejects expired token", async () => {
  const token = await signSessionToken(
    {
      userId: "u",
      email: "a@x.com",
      name: "A",
      globalScope: "read",
      groups: [],
      groupIds: [],
    },
    SECRET,
    -10, // already expired
  );
  assert.equal(await verifySessionToken(token, SECRET), null);
});

test("rejects garbage", async () => {
  assert.equal(await verifySessionToken("not-a-jwt", SECRET), null);
});

test("old tokens without a groupIds claim verify with an empty array", async () => {
  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(SECRET);
  const token = await new SignJWT({
    email: "a@x.com",
    name: "A",
    scope: "manage",
    groups: ["apollo@x.com"],
    // no groupIds claim -- simulates a token signed before this field existed
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("01USER0000000000000000000")
    .setIssuer("portuni")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const claims = await verifySessionToken(token, SECRET);
  assert.ok(claims);
  assert.deepEqual(claims.groupIds, []);
});
