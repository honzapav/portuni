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

// Content search: Drive's `fullText contains` answers with flat file objects,
// so the adapter must rebuild each hit's path by walking `parents` up to the
// remote root and drop anything whose ancestry never reaches it.
describe("DriveAdapter search (fullText contains)", () => {
  it("sends fullText contains + trashed=false with shared-drive params and resolves paths to the root", async () => {
    const { FakeDrive } = await import("./helpers/fake-drive.js");
    const { __setUserTokenFetchForTests, resetUserTokenCacheForTests } = await import(
      "../apps/server/domain/sync/drive-user-auth.js"
    );
    const drive = new FakeDrive();
    __setDriveFetchForTests(drive.fetch);
    resetUserTokenCacheForTests();
    __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));

    const org = drive.addFolder("workflow", drive.rootId);
    const projects = drive.addFolder("projects", org);
    const node = drive.addFolder("stan-gws", projects);
    const wip = drive.addFolder("wip", node);
    drive.addFile("notes.md", wip, "quarterly budget review\nsecond line\n");
    drive.addFile("other.md", wip, "nothing relevant here\n");
    // A file whose ancestry does not reach the remote root: dropped.
    const elsewhere = drive.addFolder("elsewhere", "NOT-A-KNOWN-FOLDER");
    drive.addFile("stray.md", elsewhere, "quarterly budget elsewhere\n");

    const userRemote: RemoteConfig = { name: "dw", type: "gdrive", config: { shared_drive_id: "ROOT" } };
    const userTokens: DeviceTokens = {
      dw: { mode: "refresh_token", refresh_token: "r", client_id: "c", client_secret: "s" },
    };
    const adapter = createDriveAdapter(userRemote, userTokens);
    assert.ok(adapter.search, "Drive adapter must implement search");
    const hits = await adapter.search!("quarterly budget", { limit: 10 });

    const search = drive.requests.find((r) => r.url.includes("fullText"));
    assert.ok(search, "expected a fullText files.list call");
    const url = new URL(search!.url);
    assert.equal(url.searchParams.get("q"), "fullText contains 'quarterly budget' and trashed = false");
    assert.equal(url.searchParams.get("supportsAllDrives"), "true");
    assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true");
    assert.equal(url.searchParams.get("driveId"), "ROOT");
    assert.equal(url.searchParams.get("corpora"), "drive");
    assert.ok(url.searchParams.get("fields")!.includes("parents"));

    assert.deepEqual(
      hits.map((h) => h.path),
      ["workflow/projects/stan-gws/wip/notes.md"],
    );
    assert.equal(hits[0].name, "notes.md");
    assert.equal(hits[0].mimeType, "application/octet-stream");
    assert.ok(hits[0].modifiedTime);
    // #209: Drive search used to return no snippet at all -- the agent had
    // to read every hit in full to judge relevance. The match's line is now
    // fetched (a bounded alt=media read for a plain file) and extracted.
    assert.equal(hits[0].snippet, "quarterly budget review");
  });

  it("escapes single quotes in the query", async () => {
    const { FakeDrive } = await import("./helpers/fake-drive.js");
    const { __setUserTokenFetchForTests, resetUserTokenCacheForTests } = await import(
      "../apps/server/domain/sync/drive-user-auth.js"
    );
    const drive = new FakeDrive();
    __setDriveFetchForTests(drive.fetch);
    resetUserTokenCacheForTests();
    __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));
    const adapter = createDriveAdapter(
      { name: "dw", type: "gdrive", config: { shared_drive_id: "ROOT" } },
      { dw: { mode: "refresh_token", refresh_token: "r", client_id: "c", client_secret: "s" } },
    );
    await adapter.search!("o'neill");
    const search = drive.requests.find((r) => r.url.includes("fullText"));
    assert.equal(new URL(search!.url).searchParams.get("q"), "fullText contains 'o\\'neill' and trashed = false");
  });

  it("memoises ancestor lookups: many hits under one folder cost one files.get per distinct ancestor", async () => {
    const { FakeDrive } = await import("./helpers/fake-drive.js");
    const { __setUserTokenFetchForTests, resetUserTokenCacheForTests } = await import(
      "../apps/server/domain/sync/drive-user-auth.js"
    );
    const drive = new FakeDrive();
    __setDriveFetchForTests(drive.fetch);
    resetUserTokenCacheForTests();
    __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));
    const org = drive.addFolder("workflow", drive.rootId);
    const wip = drive.addFolder("wip", org);
    for (let i = 0; i < 5; i++) drive.addFile(`f${i}.md`, wip, "needle");
    const adapter = createDriveAdapter(
      { name: "dw", type: "gdrive", config: { shared_drive_id: "ROOT" } },
      { dw: { mode: "refresh_token", refresh_token: "r", client_id: "c", client_secret: "s" } },
    );
    const hits = await adapter.search!("needle", { limit: 10 });
    assert.equal(hits.length, 5);
    // Excludes the per-hit alt=media snippet fetch (#209, one per hit,
    // unrelated to ancestor memoization) so this keeps testing only what it
    // says: one files.get per distinct ancestor folder, not per hit.
    const gets = drive.requests.filter(
      (r) => r.method === "GET" && /\/drive\/v3\/files\/[^/?]+/.test(r.url) && !r.url.includes("alt=media"),
    );
    assert.equal(gets.length, 2, `expected one files.get per ancestor (wip, workflow), got ${gets.map((g) => g.url).join("\n")}`);
  });

  it("leaves snippet undefined when the match sits outside the bounded fetch window", async () => {
    const { FakeDrive } = await import("./helpers/fake-drive.js");
    const { __setUserTokenFetchForTests, resetUserTokenCacheForTests } = await import(
      "../apps/server/domain/sync/drive-user-auth.js"
    );
    const drive = new FakeDrive();
    __setDriveFetchForTests(drive.fetch);
    resetUserTokenCacheForTests();
    __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));
    const org = drive.addFolder("workflow", drive.rootId);
    const wip = drive.addFolder("wip", org);
    // Padding well past the adapter's bounded snippet-fetch window, with the
    // match only appearing after it -- Drive's own full-text index covers
    // the whole file, the bounded snippet fetch deliberately does not.
    const padding = "filler ".repeat(20_000);
    drive.addFile("huge.md", wip, `${padding}needle at the very end\n`);
    const adapter = createDriveAdapter(
      { name: "dw", type: "gdrive", config: { shared_drive_id: "ROOT" } },
      { dw: { mode: "refresh_token", refresh_token: "r", client_id: "c", client_secret: "s" } },
    );
    const hits = await adapter.search!("needle", { limit: 10 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].snippet, undefined);
  });

  it("leaves snippet undefined for a Google-native format (no plain-text export in this fake)", async () => {
    const { FakeDrive } = await import("./helpers/fake-drive.js");
    const { __setUserTokenFetchForTests, resetUserTokenCacheForTests } = await import(
      "../apps/server/domain/sync/drive-user-auth.js"
    );
    const drive = new FakeDrive();
    __setDriveFetchForTests(drive.fetch);
    resetUserTokenCacheForTests();
    __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));
    const org = drive.addFolder("workflow", drive.rootId);
    const wip = drive.addFolder("wip", org);
    const docId = drive.addFile("doc.gdoc", wip, "needle inside a google doc\n");
    drive.files.get(docId)!.mimeType = "application/vnd.google-apps.document";
    const adapter = createDriveAdapter(
      { name: "dw", type: "gdrive", config: { shared_drive_id: "ROOT" } },
      { dw: { mode: "refresh_token", refresh_token: "r", client_id: "c", client_secret: "s" } },
    );
    const hits = await adapter.search!("needle", { limit: 10 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].snippet, undefined);
  });

  // #211 cleanup: snippet fetches (the per-hit alt=media reads) used to run
  // one at a time inside the paging loop. Wrap the fake fetch to track how
  // many alt=media requests are in flight simultaneously and assert it goes
  // above 1 (genuinely concurrent) without exceeding the adapter's cap.
  it("fetches snippets with bounded concurrency, not one request at a time", async () => {
    const { FakeDrive } = await import("./helpers/fake-drive.js");
    const { __setUserTokenFetchForTests, resetUserTokenCacheForTests } = await import(
      "../apps/server/domain/sync/drive-user-auth.js"
    );
    const drive = new FakeDrive();
    resetUserTokenCacheForTests();
    __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));

    const org = drive.addFolder("workflow", drive.rootId);
    const wip = drive.addFolder("wip", org);
    const HIT_COUNT = 8;
    for (let i = 0; i < HIT_COUNT; i++) drive.addFile(`f${i}.md`, wip, "needle content\n");

    let inFlight = 0;
    let maxInFlight = 0;
    __setDriveFetchForTests(async (url, init) => {
      const isSnippetFetch = url.toString().includes("alt=media");
      if (!isSnippetFetch) return drive.fetch(url, init);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // Small delay so overlapping requests actually overlap in time
        // instead of the event loop trivially serializing them.
        await new Promise((r) => setTimeout(r, 5));
        return await drive.fetch(url, init);
      } finally {
        inFlight--;
      }
    });

    const adapter = createDriveAdapter(
      { name: "dw", type: "gdrive", config: { shared_drive_id: "ROOT" } },
      { dw: { mode: "refresh_token", refresh_token: "r", client_id: "c", client_secret: "s" } },
    );
    const hits = await adapter.search!("needle", { limit: 10 });
    assert.equal(hits.length, HIT_COUNT);
    assert.ok(hits.every((h) => h.snippet === "needle content"));
    assert.ok(maxInFlight > 1, `expected overlapping snippet fetches, saw max ${maxInFlight} in flight`);
    assert.ok(maxInFlight <= 5, `expected the concurrency cap to hold, saw max ${maxInFlight} in flight`);
  });
});
