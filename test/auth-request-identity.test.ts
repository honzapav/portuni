import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSharedDb } from "./helpers/shared-db.js";
import { resolveRequestIdentity } from "../apps/server/auth/request-identity.js";
import { mintDeviceToken } from "../apps/server/auth/device-tokens.js";
import { mintGrant, revokeGrant } from "../apps/server/auth/oauth/grants.js";
import { signSessionToken } from "../apps/server/auth/session-token.js";
import { EnvAdapter } from "../apps/server/auth/env-adapter.js";

const ISSUER = "https://api.portuni.test";
const GRANT_INPUT = {
  userId: "U1",
  clientId: "https://claude.ai/.well-known/oauth-client-metadata/portuni.json",
  clientName: "Claude",
  resource: `${ISSUER}/mcp`,
  scope: "portuni offline_access",
};

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
  assert.deepEqual(id.groupIds, []);
});

test("google mode accepts a valid session JWT", async () => {
  const { db } = await makeSharedDb();
  const token = await signSessionToken(
    {
      userId: "u1",
      email: "a@x.com",
      name: "A",
      globalScope: "write",
      groups: ["g@x.com"],
      groupIds: ["01group"],
    },
    SECRET,
  );
  const id = await resolveRequestIdentity(ctx(db, "google"), `Bearer ${token}`);
  assert.ok(id);
  assert.equal(id.userId, "u1");
  assert.equal(id.globalScope, "write");
  assert.equal(id.via, "session_jwt");
  assert.deepEqual(id.groupIds, ["01group"]);
});

test("google mode accepts a device token and resolves access via adapter", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintDeviceToken(db, SOLO, "test");
  const id = await resolveRequestIdentity(ctx(db, "google"), `Bearer ${minted.token}`);
  assert.ok(id);
  assert.equal(id.userId, SOLO);
  assert.equal(id.via, "device_token");
  assert.equal(id.globalScope, "admin"); // EnvAdapter resolveAccess
  assert.deepEqual(id.groupIds, []); // EnvAdapter resolveAccess has no groups
});

test("google mode rejects garbage and missing header", async () => {
  const { db } = await makeSharedDb();
  assert.equal(await resolveRequestIdentity(ctx(db, "google"), undefined), null);
  assert.equal(await resolveRequestIdentity(ctx(db, "google"), "Bearer nonsense"), null);
});

test("google mode accepts a valid poa_ token within audience and resolves oauth_grant identity", async () => {
  const { db } = await makeSharedDb();
  process.env.PORTUNI_PUBLIC_URL = ISSUER;
  try {
    const minted = await mintGrant(db, GRANT_INPUT);
    const id = await resolveRequestIdentity(ctx(db, "google"), `Bearer ${minted.accessToken}`);
    assert.ok(id);
    assert.equal(id.userId, "U1");
    assert.equal(id.email, "a@b");
    assert.equal(id.via, "oauth_grant");
    assert.equal(id.globalScope, "admin"); // EnvAdapter.resolveAccess
  } finally {
    delete process.env.PORTUNI_PUBLIC_URL;
  }
});

test("google mode rejects an expired poa_ token", async () => {
  const { db } = await makeSharedDb();
  process.env.PORTUNI_PUBLIC_URL = ISSUER;
  try {
    const minted = await mintGrant(db, GRANT_INPUT);
    await db.execute({
      sql: "UPDATE oauth_grants SET access_expires_at = datetime('now', '-1 second') WHERE id = ?",
      args: [minted.grantId],
    });
    assert.equal(await resolveRequestIdentity(ctx(db, "google"), `Bearer ${minted.accessToken}`), null);
  } finally {
    delete process.env.PORTUNI_PUBLIC_URL;
  }
});

test("google mode rejects a revoked poa_ token", async () => {
  const { db } = await makeSharedDb();
  process.env.PORTUNI_PUBLIC_URL = ISSUER;
  try {
    const minted = await mintGrant(db, GRANT_INPUT);
    assert.ok(await revokeGrant(db, "U1", minted.grantId));
    assert.equal(await resolveRequestIdentity(ctx(db, "google"), `Bearer ${minted.accessToken}`), null);
  } finally {
    delete process.env.PORTUNI_PUBLIC_URL;
  }
});

test("google mode rejects a poa_ token minted for a different resource", async () => {
  const { db } = await makeSharedDb();
  process.env.PORTUNI_PUBLIC_URL = ISSUER;
  try {
    const minted = await mintGrant(db, { ...GRANT_INPUT, resource: "https://someone-else.example/mcp" });
    assert.equal(await resolveRequestIdentity(ctx(db, "google"), `Bearer ${minted.accessToken}`), null);
  } finally {
    delete process.env.PORTUNI_PUBLIC_URL;
  }
});

test("google mode rejects a poa_ token when PORTUNI_PUBLIC_URL is not configured", async () => {
  const { db } = await makeSharedDb();
  delete process.env.PORTUNI_PUBLIC_URL;
  const minted = await mintGrant(db, GRANT_INPUT);
  assert.equal(await resolveRequestIdentity(ctx(db, "google"), `Bearer ${minted.accessToken}`), null);
});
