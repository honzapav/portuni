import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  signJwt, getDriveAccessToken, __setTokenFetchForTests, resetSaTokenCacheForTests,
} from "../src/sync/drive-sa-auth.js";
import type { ServiceAccountKey } from "../src/sync/drive-config.js";

const { privateKey: pk } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = pk.export({ type: "pkcs8", format: "pem" }) as string;

const sa: ServiceAccountKey = {
  type: "service_account",
  client_email: "test@proj.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY_PEM,
  token_uri: "https://oauth2.googleapis.com/token",
};

beforeEach(() => { resetSaTokenCacheForTests(); });
afterEach(() => { resetSaTokenCacheForTests(); });

describe("signJwt", () => {
  it("produces three base64url segments with header.alg=RS256 + payload", async () => {
    const jwt = await signJwt({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: sa.token_uri,
      privateKey: PRIVATE_KEY_PEM,
    });
    const parts = jwt.split(".");
    assert.equal(parts.length, 3);
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    assert.equal(header.alg, "RS256");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    assert.equal(payload.iss, sa.client_email);
    assert.equal(payload.scope, "https://www.googleapis.com/auth/drive");
    assert.equal(payload.aud, sa.token_uri);
    assert.ok(payload.exp > payload.iat);
  });
});

describe("getDriveAccessToken", () => {
  it("fetches and caches an access token", async () => {
    let calls = 0;
    __setTokenFetchForTests(async (url, jwt) => {
      calls++;
      assert.ok(url.includes("oauth2.googleapis.com"));
      assert.ok(jwt.split(".").length === 3);
      return { access_token: "ya29.abc", expires_in: 3600 };
    });
    const t1 = await getDriveAccessToken(sa);
    const t2 = await getDriveAccessToken(sa);
    assert.equal(t1, "ya29.abc");
    assert.equal(t2, "ya29.abc");
    assert.equal(calls, 1, "second call hit cache");
  });

  it("re-fetches once cache is invalidated", async () => {
    let calls = 0;
    __setTokenFetchForTests(async () => { calls++; return { access_token: `t${calls}`, expires_in: 3600 }; });
    await getDriveAccessToken(sa);
    resetSaTokenCacheForTests();
    await getDriveAccessToken(sa);
    assert.equal(calls, 2);
  });
});
