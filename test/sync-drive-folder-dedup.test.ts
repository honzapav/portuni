// Drive adapter against an in-memory Drive that allows same-name siblings and
// enforces the shared-drive one-parent rule. Reproduces the duplicate-folder
// splatter from concurrent pushes and the 403 teamDrivesParentLimit on move
// (Asana: "Sync engine: duplicitní složky na shared Drive").
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createDriveAdapter, __setDriveFetchForTests } from "../apps/server/domain/sync/drive-adapter.js";
import type { RemoteConfig, DeviceTokens } from "../apps/server/domain/sync/types.js";
import { __setUserTokenFetchForTests, resetUserTokenCacheForTests } from "../apps/server/domain/sync/drive-user-auth.js";
import { FakeDrive } from "./helpers/fake-drive.js";

const remote: RemoteConfig = { name: "dw", type: "gdrive", config: { shared_drive_id: "ROOT" } };
const tokens: DeviceTokens = {
  dw: { mode: "refresh_token", refresh_token: "r", client_id: "c", client_secret: "s" },
};

describe("Drive adapter: folder identity under concurrency", () => {
  let drive: FakeDrive;
  beforeEach(() => {
    drive = new FakeDrive();
    __setDriveFetchForTests(drive.fetch);
    resetUserTokenCacheForTests();
    __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it("concurrent puts into one new folder tree create every folder segment exactly once", async () => {
    const adapter = createDriveAdapter(remote, tokens);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        adapter.put(`workflow/projects/spp/wip/f${i}.md`, Buffer.from(`f${i}`)),
      ),
    );
    assert.equal(drive.foldersNamed("workflow").length, 1);
    assert.equal(drive.foldersNamed("projects").length, 1);
    assert.equal(drive.foldersNamed("spp").length, 1);
    assert.equal(drive.foldersNamed("wip").length, 1);
    const wip = drive.foldersNamed("wip")[0];
    for (let i = 0; i < 5; i++) {
      const f = drive.filesNamed(`f${i}.md`);
      assert.equal(f.length, 1);
      assert.deepEqual(f[0].parents, [wip.id]);
    }
  });

  it("adopts an older same-name sibling that search missed and trashes its own folder", async () => {
    // Another process (or Drive's index lag) already holds "wip"; the first
    // search for it comes back empty.
    const existing = drive.addFolder("wip", drive.rootId);
    drive.lagSearchesFor("wip", 1);
    const adapter = createDriveAdapter(remote, tokens);
    await adapter.put("wip/a.md", Buffer.from("a"));
    const wips = drive.foldersNamed("wip");
    assert.equal(wips.length, 1, "own folder must be trashed in favour of the older sibling");
    assert.equal(wips[0].id, existing);
    assert.deepEqual(drive.filesNamed("a.md")[0].parents, [existing]);
  });
});

describe("Drive adapter: existing duplicate siblings", () => {
  let drive: FakeDrive;
  let warn: ReturnType<typeof mock.method>;
  beforeEach(() => {
    drive = new FakeDrive();
    __setDriveFetchForTests(drive.fetch);
    resetUserTokenCacheForTests();
    __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));
    warn = mock.method(console, "warn", () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it("resolves a file that lives in a newer duplicate folder and warns about the duplicates", async () => {
    drive.addFolder("wip", drive.rootId); // older, empty
    const newer = drive.addFolder("wip", drive.rootId);
    drive.addFile("x.md", newer, "x");
    const adapter = createDriveAdapter(remote, tokens);
    const st = await adapter.stat("wip/x.md");
    assert.ok(st, "file in the newer duplicate must still resolve");
    assert.equal(st!.size, 1);
    const msgs = warn.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(
      msgs.some((m) => m.includes("duplicate") && m.includes("wip")),
      `expected a duplicate-folder warning, got ${JSON.stringify(msgs)}`,
    );
  });

  it("new content lands in the oldest duplicate", async () => {
    const older = drive.addFolder("wip", drive.rootId);
    drive.addFolder("wip", drive.rootId);
    const adapter = createDriveAdapter(remote, tokens);
    await adapter.put("wip/new.md", Buffer.from("n"));
    assert.deepEqual(drive.filesNamed("new.md")[0].parents, [older]);
  });

  it("move removes the file's REAL parent so the shared drive keeps exactly one parent", async () => {
    drive.addFolder("wip", drive.rootId); // older duplicate, what the path resolves to
    const newer = drive.addFolder("wip", drive.rootId);
    const fileId = drive.addFile("x.md", newer, "x");
    drive.addFolder("outputs", drive.rootId);
    const adapter = createDriveAdapter(remote, tokens);
    await adapter.rename("wip/x.md", "outputs/x.md");
    const f = drive.files.get(fileId)!;
    assert.deepEqual(f.parents, [drive.foldersNamed("outputs")[0].id]);
    assert.equal(f.name, "x.md");
    assert.ok(await adapter.stat("outputs/x.md"));
    assert.equal(await adapter.stat("wip/x.md"), null);
  });

  it("a pure rename inside one folder sends no parent changes", async () => {
    const wip = drive.addFolder("wip", drive.rootId);
    const fileId = drive.addFile("x.md", wip, "x");
    const adapter = createDriveAdapter(remote, tokens);
    await adapter.rename("wip/x.md", "wip/y.md");
    const patch = drive.requests.find((r) => r.method === "PATCH" && r.url.includes(`/files/${fileId}`));
    assert.ok(patch);
    assert.ok(!patch!.url.includes("addParents"), patch!.url);
    assert.ok(!patch!.url.includes("removeParents"), patch!.url);
    assert.equal(drive.files.get(fileId)!.name, "y.md");
  });
});
