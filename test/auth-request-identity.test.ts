import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSharedDb } from "./helpers/shared-db.js";
import { resolveRequestIdentity } from "../src/auth/request-identity.js";
import { mintDeviceToken } from "../src/auth/device-tokens.js";
import { signSessionToken } from "../src/auth/session-token.js";
import { EnvAdapter } from "../src/auth/env-adapter.js";

const SECRET = "test-secret-at-least-32-chars-long!!";
const SOLO = "01SOLO0000000000000000000";

function ctx(db: Awaited<ReturnType<typeof makeSharedDb>>["db"], mode: "env" | "google") {
  return {
    db,
    mode,
    jwtSecret: SECRET,
    adapter: new EnvAdapter({} as NodeJS.ProcessEnv),
    soloUserId: SOLO,
  };
}

test("env mode yields solo admin identity regardless of header", async () => {
  const { db } = await makeSharedDb();
  const id = await resolveRequestIdentity(ctx(db, "env"), undefined);
  assert.ok(id);
  assert.equal(id.userId, SOLO);
  assert.equal(id.globalScope, "admin");
  assert.equal(id.via, "env");
});

test("google mode accepts a valid session JWT", async () => {
  const { db } = await makeSharedDb();
  const token = await signSessionToken(
    { userId: "u1", email: "a@x.com", name: "A", globalScope: "write", groups: ["g@x.com"] },
    SECRET,
  );
  const id = await resolveRequestIdentity(ctx(db, "google"), `Bearer ${token}`);
  assert.ok(id);
  assert.equal(id.userId, "u1");
  assert.equal(id.globalScope, "write");
  assert.equal(id.via, "session_jwt");
});

test("google mode accepts a device token and resolves access via adapter", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintDeviceToken(db, SOLO, "test");
  const id = await resolveRequestIdentity(ctx(db, "google"), `Bearer ${minted.token}`);
  assert.ok(id);
  assert.equal(id.userId, SOLO);
  assert.equal(id.via, "device_token");
  assert.equal(id.globalScope, "admin"); // EnvAdapter resolveAccess
});

test("google mode rejects garbage and missing header", async () => {
  const { db } = await makeSharedDb();
  assert.equal(await resolveRequestIdentity(ctx(db, "google"), undefined), null);
  assert.equal(await resolveRequestIdentity(ctx(db, "google"), "Bearer nonsense"), null);
});
