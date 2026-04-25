import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createDriveAdapter, __setDriveFetchForTests } from "../src/sync/drive-adapter.js";
import type { RemoteConfig, DeviceTokens } from "../src/sync/types.js";
import { generateKeyPairSync } from "node:crypto";
import { resetSaTokenCacheForTests } from "../src/sync/drive-sa-auth.js";

const { privateKey: pk } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = pk.export({ type: "pkcs8", format: "pem" }) as string;

const sa = JSON.stringify({
  type: "service_account",
  client_email: "sa@proj.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY_PEM,
  token_uri: "https://oauth2.googleapis.com/token",
});
const remote: RemoteConfig = { name: "dw", type: "gdrive", config: { shared_drive_id: "0AXy" } };
const tokens: DeviceTokens = { dw: { mode: "service_account", service_account_json: sa } };

describe("DriveAdapter REST contract", () => {
  let calls: Array<{ url: string; init: RequestInit }>;
  beforeEach(() => {
    resetSaTokenCacheForTests();
    calls = [];
    __setDriveFetchForTests(async (url, init) => {
      calls.push({ url: url.toString(), init: init ?? {} });
      const u = url.toString();
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "A", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("/files?q=")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
  });

  it("search calls include supportsAllDrives + driveId + corpora=drive", async () => {
    const adapter = createDriveAdapter(remote, tokens);
    await adapter.list("projects/stan-gws/").catch(() => undefined);
    const search = calls.find((c) => c.url.includes("/files?q="));
    assert.ok(search, "expected a files search call");
    assert.ok(search!.url.includes("supportsAllDrives=true"));
    assert.ok(search!.url.includes("includeItemsFromAllDrives=true"));
    assert.ok(search!.url.includes("driveId=0AXy"));
    assert.ok(search!.url.includes("corpora=drive"));
  });

  it("rename invalidates descendant paths from the cache", async () => {
    __setDriveFetchForTests(async (url) => {
      const u = url.toString();
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "A", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("/files?q=") && decodeURIComponent(u).includes("application/vnd.google-apps.folder")) {
        return new Response(JSON.stringify({ files: [{ id: "folderId", name: "any", mimeType: "application/vnd.google-apps.folder" }] }), { status: 200 });
      }
      if (u.includes("/files?q=")) {
        return new Response(JSON.stringify({ files: [{ id: "fileId", name: "any", mimeType: "application/octet-stream" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "fileId", name: "any", parents: [] }), { status: 200 });
    });
    const adapter = createDriveAdapter(remote, tokens);
    await adapter.stat("wip/research/a.md").catch(() => undefined);
    await adapter.stat("wip/research/sub/b.md").catch(() => undefined);
    await adapter.rename("wip/research", "wip/archive/research");
    let oldWasSearched = false;
    __setDriveFetchForTests(async (url) => {
      const u = url.toString();
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "A", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("/files?q=") && decodeURIComponent(u).includes("'research'")) {
        oldWasSearched = true;
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const after = await adapter.stat("wip/research/a.md");
    assert.equal(after, null);
    assert.ok(oldWasSearched);
  });

  it("delete invalidates descendant paths from the cache", async () => {
    __setDriveFetchForTests(async (url) => {
      const u = url.toString();
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "A", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("/files?q=")) {
        return new Response(JSON.stringify({ files: [{ id: "fx", name: "f", mimeType: "application/octet-stream" }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const adapter = createDriveAdapter(remote, tokens);
    await adapter.stat("wip/research/a.md").catch(() => undefined);
    await adapter.delete("wip/research");
    __setDriveFetchForTests(async (url) => {
      const u = url.toString();
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "A", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("/files?q=")) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const after = await adapter.stat("wip/research/a.md");
    assert.equal(after, null);
  });
});
