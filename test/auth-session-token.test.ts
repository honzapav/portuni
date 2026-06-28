import { test } from "node:test";
import assert from "node:assert/strict";
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
    },
    SECRET,
  );
  const claims = await verifySessionToken(token, SECRET);
  assert.ok(claims);
  assert.equal(claims.userId, "01USER0000000000000000000");
  assert.equal(claims.globalScope, "manage");
  assert.deepEqual(claims.groups, ["apollo@x.com"]);
});

test("rejects wrong secret", async () => {
  const token = await signSessionToken(
    { userId: "u", email: "a@x.com", name: "A", globalScope: "read", groups: [] },
    SECRET,
  );
  assert.equal(await verifySessionToken(token, "other-secret-32-chars-long!!!!!!"), null);
});

test("rejects expired token", async () => {
  const token = await signSessionToken(
    { userId: "u", email: "a@x.com", name: "A", globalScope: "read", groups: [] },
    SECRET,
    -10, // already expired
  );
  assert.equal(await verifySessionToken(token, SECRET), null);
});

test("rejects garbage", async () => {
  assert.equal(await verifySessionToken("not-a-jwt", SECRET), null);
});
