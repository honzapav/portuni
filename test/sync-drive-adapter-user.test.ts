import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createDriveAdapter, __setDriveFetchForTests } from "../apps/server/domain/sync/drive-adapter.js";
import { __setUserTokenFetchForTests, resetUserTokenCacheForTests } from "../apps/server/domain/sync/drive-user-auth.js";

const REMOTE = { name: "gdrive", type: "gdrive" as const, config: { root_folder_id: "ROOT" } };
const TOKENS = { gdrive: { mode: "refresh_token" as const, refresh_token: "R1", client_id: "C", client_secret: "S" } };

beforeEach(() => resetUserTokenCacheForTests());

describe("drive adapter in refresh-token mode", () => {
  it("lists without driveId/corpora=drive and with the user access token", async () => {
    __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));
    const seen: string[] = [];
    __setDriveFetchForTests((async (url: string, init?: RequestInit) => {
      seen.push(url);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer UAT");
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }) as typeof fetch);
    const adapter = createDriveAdapter(REMOTE, TOKENS);
    await adapter.list("");
    assert.ok(seen.length >= 1);
    const q = new URL(seen[0]).searchParams;
    assert.equal(q.get("driveId"), null);
    assert.notEqual(q.get("corpora"), "drive");
  });

  it("still refuses SA tokens without shared_drive_id", () => {
    const saTokens = { gdrive: { mode: "service_account" as const, service_account_json: "{}" } };
    assert.throws(() => createDriveAdapter(REMOTE, saTokens), /Personal My Drive is not supported/);
  });

  it("refuses a remote with no usable credentials", () => {
    assert.throws(() => createDriveAdapter(REMOTE, {}), /no credentials/i);
  });
});
