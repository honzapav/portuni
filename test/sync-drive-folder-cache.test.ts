// The Drive adapter's persistent ancestor cache (#419): remote_folder_cache
// as the tier below the in-process memo, invalidation by path, and the
// memo's own bound.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createDriveAdapter, __setDriveFetchForTests } from "../apps/server/domain/sync/drive-adapter.js";
import {
  createDbFolderPathStore,
  createFolderPathCache,
  folderMemoMax,
  DEFAULT_FOLDER_MEMO_MAX,
} from "../apps/server/domain/sync/drive-folder-cache.js";
import { resetSaTokenCacheForTests } from "../apps/server/domain/sync/drive-sa-auth.js";
import type { RemoteConfig, DeviceTokens } from "../apps/server/domain/sync/types.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { openTestDb } from "./helpers/db.js";
import type { DbClient } from "../apps/server/infra/db.js";

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

const FOLDERS: Record<string, { id: string; name: string; mimeType: string; parents: string[] }> = {
  fProjects: { id: "fProjects", name: "projects", mimeType: FOLDER_MIME, parents: ["0AXy"] },
  fNode: { id: "fNode", name: "stan-gws", mimeType: FOLDER_MIME, parents: ["fProjects"] },
};

interface DrivePage {
  changes?: unknown[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

function mockDrive(opts: { calls: string[]; pages?: DrivePage[]; startTokens?: string[]; changesStatus?: number[] }): void {
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
      return new Response(JSON.stringify({ startPageToken: startTokens.shift() ?? "START" }), { status: 200 });
    }
    if (u.includes("/changes?")) {
      const status = changesStatus.shift();
      if (status !== undefined && status !== 200) return new Response("gone", { status });
      return new Response(JSON.stringify(pages.shift() ?? {}), { status: 200 });
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

function fileChange(id: string, name: string, parent: string, time: string): unknown {
  return {
    fileId: id,
    file: { id, name, mimeType: "text/markdown", parents: [parent], md5Checksum: "h", modifiedTime: time },
  };
}

async function cachedRows(db: DbClient): Promise<Array<{ folder_id: string; path: string }>> {
  const r = await db.execute("SELECT folder_id, path FROM remote_folder_cache ORDER BY path");
  return r.rows.map((row) => ({ folder_id: String(row.folder_id), path: String(row.path) }));
}

function adapterWith(db: DbClient) {
  return createDriveAdapter(remote, tokens, { folderCache: createDbFolderPathStore(db, remote.name) });
}

describe("Drive ancestor cache: remote_folder_cache", () => {
  let calls: string[];
  let db: DbClient;

  beforeEach(async () => {
    resetSaTokenCacheForTests();
    calls = [];
    db = await openTestDb();
    await ensureSchemaOn(db);
  });

  it("a restarted adapter resolves a known folder from the table, with no Drive call", async () => {
    mockDrive({
      calls,
      pages: [
        { changes: [fileChange("f1", "a.md", "fNode", "2026-09-01T10:00:00.000Z")], newStartPageToken: "T2" },
        { changes: [fileChange("f2", "b.md", "fNode", "2026-09-01T11:00:00.000Z")], newStartPageToken: "T3" },
      ],
    });
    const first = await adapterWith(db).changes!("T1");
    assert.deepEqual(first.changes.map((c) => (c.kind === "upsert" ? c.path : null)), ["projects/stan-gws/a.md"]);
    // Both ancestors walked once and persisted.
    assert.equal(fileGets(calls).length, 2);
    assert.deepEqual(await cachedRows(db), [
      { folder_id: "fProjects", path: "projects" },
      { folder_id: "fNode", path: "projects/stan-gws" },
    ]);

    // A fresh adapter instance (the process restarted) over the same db.
    const afterRestart = await adapterWith(db).changes!("T2");
    assert.deepEqual(afterRestart.changes.map((c) => (c.kind === "upsert" ? c.path : null)), [
      "projects/stan-gws/b.md",
    ]);
    assert.equal(fileGets(calls).length, 2, "the ancestor path came from the table, not from Drive");
  });

  it("a folder rename updates the row, drops the old subtree and moves later changes with it", async () => {
    mockDrive({
      calls,
      pages: [
        { changes: [fileChange("f1", "a.md", "fNode", "2026-09-01T10:00:00.000Z")], newStartPageToken: "T2" },
        {
          changes: [
            {
              fileId: "fNode",
              file: { id: "fNode", name: "stan-gws-2", mimeType: FOLDER_MIME, parents: ["fProjects"], modifiedTime: "2026-09-01T12:00:00.000Z" },
            },
          ],
          newStartPageToken: "T3",
        },
        { changes: [fileChange("f1", "a.md", "fNode", "2026-09-01T13:00:00.000Z")], newStartPageToken: "T4" },
      ],
    });
    const adapter = adapterWith(db);
    await adapter.changes!("T1");
    const gets = fileGets(calls).length;

    const renamed = await adapter.changes!("T2");
    assert.deepEqual(renamed.changes.map((c) => (c.kind === "upsert" ? [c.path, c.is_folder] : null)), [
      ["projects/stan-gws-2", true],
    ]);
    assert.deepEqual(await cachedRows(db), [
      { folder_id: "fProjects", path: "projects" },
      { folder_id: "fNode", path: "projects/stan-gws-2" },
    ]);
    // The folder's own change carries its new name and parent: nothing to
    // re-walk over the network.
    assert.equal(fileGets(calls).length, gets);

    const after = await adapter.changes!("T3");
    assert.deepEqual(after.changes.map((c) => (c.kind === "upsert" ? c.path : null)), [
      "projects/stan-gws-2/a.md",
    ]);
  });

  it("a removed folder drops its own row and everything under it", async () => {
    mockDrive({
      calls,
      pages: [
        { changes: [fileChange("f1", "a.md", "fNode", "2026-09-01T10:00:00.000Z")], newStartPageToken: "T2" },
        {
          changes: [
            {
              fileId: "fNode",
              file: { id: "fNode", name: "stan-gws", mimeType: FOLDER_MIME, parents: ["fProjects"], trashed: true, modifiedTime: "2026-09-01T12:00:00.000Z" },
            },
          ],
          newStartPageToken: "T3",
        },
      ],
    });
    const adapter = adapterWith(db);
    await adapter.changes!("T1");
    const out = await adapter.changes!("T2");
    assert.deepEqual(out.changes, [{ kind: "remove", path: "projects/stan-gws", file_id: "fNode" }]);
    assert.deepEqual(await cachedRows(db), [{ folder_id: "fProjects", path: "projects" }]);
  });

  it("a change-feed reset truncates the remote's rows", async () => {
    mockDrive({
      calls,
      pages: [{ changes: [fileChange("f1", "a.md", "fNode", "2026-09-01T10:00:00.000Z")], newStartPageToken: "T2" }],
      changesStatus: [200, 410],
      startTokens: ["T9"],
    });
    const adapter = adapterWith(db);
    await adapter.changes!("T1");
    assert.equal((await cachedRows(db)).length, 2);
    const out = await adapter.changes!("T2");
    assert.equal(out.reset, true);
    assert.deepEqual(await cachedRows(db), []);
  });
});

describe("Drive ancestor cache: the in-process memo", () => {
  it("evicts the least recently used entry past its cap, the DB answering the miss", async () => {
    const db = await openTestDb();
    await ensureSchemaOn(db);
    const store = createDbFolderPathStore(db, "dw");
    const cache = createFolderPathCache(store, 2);

    await cache.set("a", "one");
    await cache.set("b", "two");
    // Re-reading "a" makes "b" the oldest.
    assert.equal(await cache.get("a"), "one");
    await cache.set("c", "three");
    assert.equal(cache.memoSize(), 2);

    // "b" left the memo but not the table: it still resolves.
    assert.equal(await store.get("b"), "two");
    assert.equal(await cache.get("b"), "two");
    assert.equal(cache.memoSize(), 2);
  });

  it("a negative entry is memo-only and never reaches the table", async () => {
    const db = await openTestDb();
    await ensureSchemaOn(db);
    const store = createDbFolderPathStore(db, "dw");
    const cache = createFolderPathCache(store, 10);
    await cache.set("gone", null);
    assert.equal(await cache.get("gone"), null);
    assert.equal(await store.get("gone"), null);
    cache.forgetMemo("gone");
    assert.equal(await cache.get("gone"), undefined);
  });

  it("invalidateSubtree drops the folder and its descendants in both tiers", async () => {
    const db = await openTestDb();
    await ensureSchemaOn(db);
    const store = createDbFolderPathStore(db, "dw");
    const cache = createFolderPathCache(store, 10);
    await cache.set("p", "projects");
    await cache.set("n", "projects/stan-gws");
    await cache.set("w", "projects/stan-gws/wip");
    await cache.set("o", "projects/stan-gws-other");

    await cache.invalidateSubtree("projects/stan-gws");
    assert.equal(await cache.get("n"), undefined);
    assert.equal(await cache.get("w"), undefined);
    // A sibling whose path merely shares the prefix string stays.
    assert.equal(await cache.get("o"), "projects/stan-gws-other");
    assert.equal(await cache.get("p"), "projects");

    await cache.invalidateSubtree("");
    assert.equal(await cache.get("p"), undefined);
    assert.equal(cache.memoSize(), 0);
  });

  it("a folder name carrying LIKE wildcards only invalidates its own subtree", async () => {
    const db = await openTestDb();
    await ensureSchemaOn(db);
    const store = createDbFolderPathStore(db, "dw");
    await store.put("a", "100%_done");
    await store.put("b", "100%_done/wip");
    await store.put("c", "1009xdone");
    await store.deleteSubtree("100%_done");
    assert.equal(await store.get("a"), null);
    assert.equal(await store.get("b"), null);
    assert.equal(await store.get("c"), "1009xdone");
  });

  it("folderMemoMax takes a positive integer and ignores anything else", () => {
    assert.equal(folderMemoMax({}), DEFAULT_FOLDER_MEMO_MAX);
    assert.equal(folderMemoMax({ PORTUNI_DRIVE_FOLDER_MEMO_MAX: "128" }), 128);
    assert.equal(folderMemoMax({ PORTUNI_DRIVE_FOLDER_MEMO_MAX: "0" }), DEFAULT_FOLDER_MEMO_MAX);
    assert.equal(folderMemoMax({ PORTUNI_DRIVE_FOLDER_MEMO_MAX: "nope" }), DEFAULT_FOLDER_MEMO_MAX);
  });

  it("without a store the cache is memo-only, as before the table was wired up", async () => {
    const cache = createFolderPathCache(null, 2);
    await cache.set("a", "one");
    await cache.set("b", "two");
    await cache.set("c", "three");
    assert.equal(await cache.get("a"), undefined);
    assert.equal(await cache.get("c"), "three");
  });
});
