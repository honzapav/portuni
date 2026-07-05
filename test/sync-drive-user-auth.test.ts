import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getUserAccessToken,
  DriveAuthError,
  __setUserTokenFetchForTests,
  resetUserTokenCacheForTests,
} from "../apps/server/domain/sync/drive-user-auth.js";

const TOKEN = { mode: "refresh_token" as const, refresh_token: "R1", client_id: "C1", client_secret: "S1" };

beforeEach(() => resetUserTokenCacheForTests());

describe("getUserAccessToken", () => {
  it("exchanges the refresh token and caches until expiry", async () => {
    let calls = 0;
    __setUserTokenFetchForTests(async (params) => {
      calls += 1;
      assert.equal(params.get("grant_type"), "refresh_token");
      assert.equal(params.get("refresh_token"), "R1");
      assert.equal(params.get("client_id"), "C1");
      return { access_token: "A1", expires_in: 3600 };
    });
    assert.equal(await getUserAccessToken(TOKEN), "A1");
    assert.equal(await getUserAccessToken(TOKEN), "A1");
    assert.equal(calls, 1);
  });

  it("throws DriveAuthError(TOKEN_INVALID) on invalid_grant", async () => {
    __setUserTokenFetchForTests(async () => {
      throw new DriveAuthError("invalid_grant: Token has been revoked");
    });
    await assert.rejects(getUserAccessToken(TOKEN), (e: unknown) => {
      assert.ok(e instanceof DriveAuthError);
      assert.equal(e.code, "TOKEN_INVALID");
      return true;
    });
  });

  it("rejects tokens missing refresh_token/client_id/client_secret", async () => {
    await assert.rejects(getUserAccessToken({ mode: "refresh_token" }), /refresh_token/);
  });
});
