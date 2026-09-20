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

const FOLDER_MIME = "application/vnd.google-apps.folder";

// projects/stan-gws/ under the shared drive root, as Drive reports it:
// flat objects with a single `parents` entry each.
const FOLDERS: Record<string, { id: string; name: string; mimeType: string; parents: string[] }> = {
  fProjects: { id: "fProjects", name: "projects", mimeType: FOLDER_MIME, parents: ["0AXy"] },
  fNode: { id: "fNode", name: "stan-gws", mimeType: FOLDER_MIME, parents: ["fProjects"] },
  // Same shape, but its ancestry stops before the drive root.
  fElsewhere: { id: "fElsewhere", name: "someone-else", mimeType: FOLDER_MIME, parents: [] },
};

interface DrivePage {
  changes?: unknown[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

// One fetch hook covering the three endpoints changes() touches: the SA token
// exchange, changes.getStartPageToken / changes.list, and the files.get the
// ancestor walk makes. `pages` are served in order, one per changes.list call.
function mockDrive(opts: {
  calls: string[];
  pages?: DrivePage[];
  startTokens?: string[];
  changesStatus?: number[];
}): void {
  const pages = [...(opts.pages ?? [])];
  const startTokens = [...(opts.startTokens ?? ["START"])];
  const changesStatus = [...(opts.changesStatus ?? [])];
  __setDriveFetchForTests(async (url) => {
    const u = url.toString();
    if (u.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "A", expires_in: 3600 }), { status: 200 });
    }
    opts.calls.push(u);
    if (u.includes("/changes/startPageToken")) {
      const token = startTokens.shift() ?? "START";
      return new Response(JSON.stringify({ startPageToken: token }), { status: 200 });
    }
    if (u.includes("/changes?")) {
      const status = changesStatus.shift();
      if (status !== undefined && status !== 200) return new Response("gone", { status });
      const page = pages.shift() ?? {};
      return new Response(JSON.stringify(page), { status: 200 });
    }
    const idMatch = /\/files\/([^?]+)\?/.exec(u);
    const folder = idMatch ? FOLDERS[idMatch[1]] : undefined;
    if (folder) return new Response(JSON.stringify(folder), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

function fileGets(calls: string[]): string[] {
  return calls.filter((c) => /\/files\/[^?]+\?/.test(c));
}

describe("DriveAdapter changes()", () => {
  let calls: string[];
  beforeEach(() => {
    resetSaTokenCacheForTests();
    calls = [];
  });

  it("a null cursor takes a start page token and reports no changes", async () => {
    mockDrive({ calls, startTokens: ["T1"] });
    const adapter = createDriveAdapter(remote, tokens);
    const out = await adapter.changes!(null);
    assert.equal(out.cursor, "T1");
    assert.deepEqual(out.changes, []);
    assert.equal(out.reset, false);
    const start = calls.find((c) => c.includes("/changes/startPageToken"));
    assert.ok(start, "expected a startPageToken call");
    assert.ok(start!.includes("driveId=0AXy"), start);
    assert.ok(start!.includes("supportsAllDrives=true"), start);
    // changes.list/getStartPageToken take no `corpora` parameter; sending one
    // makes Drive reject the request.
    assert.ok(!start!.includes("corpora="), start);
  });

  it("a page with an upsert and a remove reports both and advances the cursor", async () => {
    mockDrive({
      calls,
      pages: [{
        changes: [
          {
            fileId: "f1",
            file: {
              id: "f1", name: "a.md", mimeType: "text/markdown", parents: ["fNode"],
              md5Checksum: "h1", modifiedTime: "2026-09-01T10:00:00.000Z",
            },
          },
          { fileId: "f2", removed: true },
        ],
        newStartPageToken: "T2",
      }],
    });
    const adapter = createDriveAdapter(remote, tokens);
    const out = await adapter.changes!("T1");
    assert.equal(out.reset, false);
    assert.equal(out.cursor, "T2");
    assert.deepEqual(out.changes, [
      {
        kind: "upsert",
        path: "projects/stan-gws/a.md",
        hash: "h1",
        modified_at: new Date("2026-09-01T10:00:00.000Z"),
        is_folder: false,
      },
      // A hard delete carries no file metadata, so there is no path to report.
      { kind: "remove", path: null, file_id: "f2" },
    ]);
    const list = calls.find((c) => c.includes("/changes?"));
    assert.ok(list!.includes("includeItemsFromAllDrives=true"), list);
    assert.ok(list!.includes("includeRemoved=true"), list);
    assert.ok(list!.includes("driveId=0AXy"), list);
    assert.ok(list!.includes("pageToken=T1"), list);
  });

  it("pages through nextPageToken and returns the last page's start token", async () => {
    mockDrive({
      calls,
      pages: [
        {
          changes: [{
            fileId: "f1",
            file: { id: "f1", name: "a.md", mimeType: "text/markdown", parents: ["fNode"], md5Checksum: "h1", modifiedTime: "2026-09-01T10:00:00.000Z" },
          }],
          nextPageToken: "P2",
        },
        {
          changes: [{
            fileId: "f2",
            file: { id: "f2", name: "b.md", mimeType: "text/markdown", parents: ["fNode"], md5Checksum: "h2", modifiedTime: "2026-09-01T11:00:00.000Z" },
          }],
          newStartPageToken: "T3",
        },
      ],
    });
    const adapter = createDriveAdapter(remote, tokens);
    const out = await adapter.changes!("T1");
    assert.equal(out.cursor, "T3");
    assert.deepEqual(out.changes.map((c) => (c.kind === "upsert" ? c.path : c.file_id)), [
      "projects/stan-gws/a.md",
      "projects/stan-gws/b.md",
    ]);
    const listCalls = calls.filter((c) => c.includes("/changes?"));
    assert.equal(listCalls.length, 2);
    assert.ok(listCalls[1].includes("pageToken=P2"), listCalls[1]);
  });

  it("a trashed file is a remove, with the path it still resolves to", async () => {
    mockDrive({
      calls,
      pages: [{
        changes: [{
          fileId: "f1",
          file: { id: "f1", name: "a.md", mimeType: "text/markdown", parents: ["fNode"], trashed: true, modifiedTime: "2026-09-01T10:00:00.000Z" },
        }],
        newStartPageToken: "T2",
      }],
    });
    const adapter = createDriveAdapter(remote, tokens);
    const out = await adapter.changes!("T1");
    assert.deepEqual(out.changes, [
      { kind: "remove", path: "projects/stan-gws/a.md", file_id: "f1" },
    ]);
  });

  it("an expired page token answers reset with a fresh start token", async () => {
    mockDrive({ calls, changesStatus: [410], startTokens: ["T9"] });
    const adapter = createDriveAdapter(remote, tokens);
    const out = await adapter.changes!("STALE");
    assert.equal(out.reset, true);
    assert.equal(out.cursor, "T9");
    assert.deepEqual(out.changes, []);
    assert.ok(calls.some((c) => c.includes("/changes/startPageToken")));
  });

  it("folder ancestry resolves to a path under the drive root and is cached across calls", async () => {
    mockDrive({
      calls,
      pages: [
        {
          changes: [
            { fileId: "f1", file: { id: "f1", name: "a.md", mimeType: "text/markdown", parents: ["fNode"], md5Checksum: "h1", modifiedTime: "2026-09-01T10:00:00.000Z" } },
            { fileId: "f2", file: { id: "f2", name: "b.md", mimeType: "text/markdown", parents: ["fNode"], md5Checksum: "h2", modifiedTime: "2026-09-01T10:00:00.000Z" } },
          ],
          newStartPageToken: "T2",
        },
        {
          changes: [
            { fileId: "f3", file: { id: "f3", name: "c.md", mimeType: "text/markdown", parents: ["fNode"], md5Checksum: "h3", modifiedTime: "2026-09-01T12:00:00.000Z" } },
          ],
          newStartPageToken: "T3",
        },
      ],
    });
    const adapter = createDriveAdapter(remote, tokens);
    const first = await adapter.changes!("T1");
    assert.deepEqual(first.changes.map((c) => (c.kind === "upsert" ? c.path : null)), [
      "projects/stan-gws/a.md",
      "projects/stan-gws/b.md",
    ]);
    // Two ancestors walked once each, not once per change.
    assert.deepEqual(fileGets(calls).length, 2);
    const second = await adapter.changes!("T2");
    assert.deepEqual(second.changes.map((c) => (c.kind === "upsert" ? c.path : null)), [
      "projects/stan-gws/c.md",
    ]);
    // The ancestor cache survives the tick: no further files.get.
    assert.deepEqual(fileGets(calls).length, 2);
  });

  it("a folder change refreshes the ancestor cache instead of leaving stale paths", async () => {
    mockDrive({
      calls,
      pages: [
        {
          changes: [
            { fileId: "f1", file: { id: "f1", name: "a.md", mimeType: "text/markdown", parents: ["fNode"], md5Checksum: "h1", modifiedTime: "2026-09-01T10:00:00.000Z" } },
          ],
          newStartPageToken: "T2",
        },
        {
          changes: [
            { fileId: "fNode", file: { id: "fNode", name: "stan-gws-2", mimeType: FOLDER_MIME, parents: ["fProjects"], modifiedTime: "2026-09-01T12:00:00.000Z" } },
            { fileId: "f1", file: { id: "f1", name: "a.md", mimeType: "text/markdown", parents: ["fNode"], md5Checksum: "h1", modifiedTime: "2026-09-01T12:00:00.000Z" } },
          ],
          newStartPageToken: "T3",
        },
      ],
    });
    const adapter = createDriveAdapter(remote, tokens);
    await adapter.changes!("T1");
    const getsAfterFirst = fileGets(calls).length;
    const out = await adapter.changes!("T2");
    assert.deepEqual(out.changes.map((c) => (c.kind === "upsert" ? [c.path, c.is_folder] : null)), [
      ["projects/stan-gws-2", true],
      ["projects/stan-gws-2/a.md", false],
    ]);
    // The renamed folder's own change carries its new name and parent, so
    // the cache is refreshed from it rather than re-walked over the network.
    assert.equal(fileGets(calls).length, getsAfterFirst);
  });

  it("a change whose ancestry never reaches the drive root is dropped", async () => {
    mockDrive({
      calls,
      pages: [{
        changes: [
          { fileId: "f1", file: { id: "f1", name: "other.md", mimeType: "text/markdown", parents: ["fElsewhere"], md5Checksum: "h1", modifiedTime: "2026-09-01T10:00:00.000Z" } },
          { fileId: "f2", file: { id: "f2", name: "a.md", mimeType: "text/markdown", parents: ["fNode"], md5Checksum: "h2", modifiedTime: "2026-09-01T10:00:00.000Z" } },
        ],
        newStartPageToken: "T2",
      }],
    });
    const adapter = createDriveAdapter(remote, tokens);
    const out = await adapter.changes!("T1");
    assert.deepEqual(out.changes, [
      {
        kind: "upsert",
        path: "projects/stan-gws/a.md",
        hash: "h2",
        modified_at: new Date("2026-09-01T10:00:00.000Z"),
        is_folder: false,
      },
    ]);
  });
});
