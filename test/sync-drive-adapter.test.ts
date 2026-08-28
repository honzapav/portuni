import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createDriveAdapter, __setDriveFetchForTests } from "../apps/server/domain/sync/drive-adapter.js";
import type { RemoteConfig, DeviceTokens } from "../apps/server/domain/sync/types.js";
import { generateKeyPairSync } from "node:crypto";
import { resetSaTokenCacheForTests } from "../apps/server/domain/sync/drive-sa-auth.js";

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

  it("path resolution orders by createdTime so duplicate siblings resolve deterministically", async () => {
    // Drive allows same-name siblings (created by concurrent puts from two
    // devices). Without a stable order Drive returns them in arbitrary
    // order and files[0] flaps between the copies on every stat/get.
    const adapter = createDriveAdapter(remote, tokens);
    await adapter.stat("projects/stan-gws/wip/doc.md").catch(() => undefined);
    const search = calls.find((c) => c.url.includes("/files?q="));
    assert.ok(search, "expected a files search call");
    assert.ok(
      search!.url.includes("orderBy=createdTime"),
      `search must pin an order, got ${search!.url}`,
    );
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

// The remote sweep asks stat() whether an object is still there, and the
// adapter instance is cached for the whole process (adapter-cache.ts, no
// TTL). Two ways stat can answer "still there" about something that is not:
// Drive's trash (list() filters trashed=false, stat() did not look at it)
// and a stale pathCache entry (the id was cached under a path the file has
// since left). Both are modelled here through the fetch seam -- no Drive
// account required.
describe("DriveAdapter stat vs. trash and a stale path cache", () => {
  // A tiny Drive: `files` maps id -> metadata, `children` maps
  // "parentId/name" -> id for the non-trashed search Drive actually does.
  function fakeDrive(files: Map<string, Record<string, unknown>>) {
    __setDriveFetchForTests(async (url) => {
      const u = url.toString();
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "A", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("/files?q=")) {
        const q = decodeURIComponent(new URL(u).searchParams.get("q") ?? "");
        const nameMatch = /name = '([^']*)'/.exec(q);
        const parentMatch = /'([^']*)' in parents/.exec(q);
        const name = nameMatch?.[1];
        const parent = parentMatch?.[1];
        const hits = [...files.entries()]
          // Drive's own query carries `trashed = false`, so a trashed
          // object is simply not in the search result.
          .filter(([, f]) => f.name === name && f.parent === parent && f.trashed !== true)
          .map(([id, f]) => ({ id, name: f.name, mimeType: f.mimeType, createdTime: f.createdTime }));
        return new Response(JSON.stringify({ files: hits }), { status: 200 });
      }
      const idMatch = /\/files\/([^?]+)/.exec(u);
      const f = idMatch ? files.get(idMatch[1]) : undefined;
      if (!f) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ id: idMatch![1], ...f }), { status: 200 });
    });
  }

  beforeEach(() => {
    resetSaTokenCacheForTests();
  });

  it("reports a file trashed after it was cached as absent", async () => {
    const files = new Map<string, Record<string, unknown>>([
      ["wipId", { name: "wip", mimeType: "application/vnd.google-apps.folder", parent: "0AXy" }],
      ["fileId", { name: "a.md", mimeType: "text/markdown", parent: "wipId", md5Checksum: "abc" }],
    ]);
    fakeDrive(files);
    const adapter = createDriveAdapter(remote, tokens);
    assert.ok(await adapter.stat("wip/a.md"), "precondition: the file is there and cached");

    // The user trashes it in the Drive UI. The id still resolves (Drive
    // answers 200 for trashed files), and the path cache still points at it.
    files.get("fileId")!.trashed = true;
    assert.equal(await adapter.stat("wip/a.md"), null);
  });

  it("reports a trashed node folder as absent (the sweep's reachability guard)", async () => {
    const files = new Map<string, Record<string, unknown>>([
      ["nodeId", { name: "stan-gws", mimeType: "application/vnd.google-apps.folder", parent: "0AXy" }],
    ]);
    fakeDrive(files);
    const adapter = createDriveAdapter(remote, tokens);
    assert.ok(await adapter.stat("stan-gws"), "precondition: the node folder is there and cached");

    files.get("nodeId")!.trashed = true;
    assert.equal(
      await adapter.stat("stan-gws"),
      null,
      "a trashed node root must not read as reachable -- otherwise the sweep deletes every record of the node",
    );
  });

  it("does not answer from a path cache entry whose object has been renamed away", async () => {
    // The move retry's deadlock: a Drive rename applies but the response is
    // lost, so the cache still maps the OLD path to the id. stat(old) must
    // not keep saying yes, or runMove throws "both ... exist" forever.
    const files = new Map<string, Record<string, unknown>>([
      ["wipId", { name: "wip", mimeType: "application/vnd.google-apps.folder", parent: "0AXy" }],
      ["fileId", { name: "a.md", mimeType: "text/markdown", parent: "wipId", md5Checksum: "abc" }],
    ]);
    fakeDrive(files);
    const adapter = createDriveAdapter(remote, tokens);
    assert.ok(await adapter.stat("wip/a.md"), "precondition: cached under the old path");

    files.get("fileId")!.name = "b.md";
    assert.equal(await adapter.stat("wip/a.md"), null);
    assert.ok(await adapter.stat("wip/b.md"), "the file is findable at its new path");
  });

  it("re-resolves to a different object that has since taken the path", async () => {
    const files = new Map<string, Record<string, unknown>>([
      ["wipId", { name: "wip", mimeType: "application/vnd.google-apps.folder", parent: "0AXy" }],
      ["oldId", { name: "a.md", mimeType: "text/markdown", parent: "wipId", md5Checksum: "old" }],
    ]);
    fakeDrive(files);
    const adapter = createDriveAdapter(remote, tokens);
    assert.equal((await adapter.stat("wip/a.md"))?.hash, "old");

    // The original is renamed away and a brand new file takes the path.
    files.get("oldId")!.name = "gone.md";
    files.set("newId", { name: "a.md", mimeType: "text/markdown", parent: "wipId", md5Checksum: "new" });
    assert.equal((await adapter.stat("wip/a.md"))?.hash, "new");
  });
});
