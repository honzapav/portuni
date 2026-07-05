import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { getTokenStore, resetTokenStoreForTests } from "../apps/server/domain/sync/token-store.js";
import { listRules } from "../apps/server/domain/sync/routing.js";
import { resetUserTokenCacheForTests, __setUserTokenFetchForTests } from "../apps/server/domain/sync/drive-user-auth.js";
import {
  connectDrive, setDriveTarget, driveStatus, testDrive, disconnectDrive,
  __setDriveRestFetchForTests,
} from "../apps/server/domain/sync/remote-service.js";

let workspace: string;
const CONN = { userId: "U1", refresh_token: "R1", client_id: "C", client_secret: "S", account_email: "a@b.cz" };

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-remotesvc-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  process.env.PORTUNI_TOKEN_STORE = "file";
  resetTokenStoreForTests();
  resetUserTokenCacheForTests();
  __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));
});

afterEach(async () => {
  resetTokenStoreForTests();
  delete process.env.PORTUNI_TOKEN_STORE;
  await rm(workspace, { recursive: true, force: true });
});

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("connectDrive + setDriveTarget", () => {
  it("stores the token, lists drives, sets target and wildcard routing", async () => {
    const { db } = await makeSharedDb();
    __setDriveRestFetchForTests((async (url: string) =>
      url.includes("/drives") ? okJson({ drives: [{ id: "D1", name: "Tým" }] }) : okJson({ files: [] })
    ) as typeof fetch);
    const r = await connectDrive(db, CONN);
    assert.deepEqual(r.shared_drives, [{ id: "D1", name: "Tým" }]);
    const stored = await (await getTokenStore()).read("gdrive");
    assert.equal(stored?.refresh_token, "R1");
    assert.equal(stored?.mode, "refresh_token");

    await setDriveTarget(db, { userId: "U1", shared_drive_id: "D1" });
    // makeSharedDb seeds exactly one routing rule for its "test-fs" remote
    // (priority 10, wildcard node_type/org_slug). The only-if-empty guard in
    // setDriveTarget must not add a gdrive wildcard rule on top of it.
    const rules = await listRules(db);
    assert.deepEqual(rules, [
      { priority: 10, node_type: null, org_slug: null, remote_name: "test-fs" },
    ]);
    const s = await driveStatus(db);
    assert.equal(s.configured, true);
    assert.equal(s.account_email, "a@b.cz");
    assert.equal(s.target?.kind, "shared_drive");
  });

  it("my_drive target creates the Portuni folder when missing", async () => {
    const { db } = await makeSharedDb();
    const posted: string[] = [];
    __setDriveRestFetchForTests((async (url: string, init?: RequestInit) => {
      if (url.includes("/drives")) return okJson({ drives: [] });
      if (init?.method === "POST") { posted.push(String(init.body)); return okJson({ id: "NEW" }); }
      return okJson({ files: [] }); // folder search: not found
    }) as typeof fetch);
    await connectDrive(db, CONN);
    const t = await setDriveTarget(db, { userId: "U1", my_drive: true });
    assert.equal(t.target.kind, "my_drive");
    assert.ok(posted[0]?.includes("Portuni"));
  });
});

describe("testDrive + disconnectDrive", () => {
  it("maps auth failure to TOKEN_INVALID and 404 to TARGET_NOT_FOUND", async () => {
    const { db } = await makeSharedDb();
    __setDriveRestFetchForTests((async (url: string) =>
      url.includes("/drives") ? okJson({ drives: [] }) : okJson({ files: [] })) as typeof fetch);
    await connectDrive(db, CONN);
    await setDriveTarget(db, { userId: "U1", shared_drive_id: "D1" });

    __setDriveRestFetchForTests((async () => new Response("nope", { status: 404 })) as typeof fetch);
    assert.deepEqual((await testDrive(db)) as object, { ok: false, code: "TARGET_NOT_FOUND", detail: "nope" });

    const { DriveAuthError } = await import("../apps/server/domain/sync/drive-user-auth.js");
    __setUserTokenFetchForTests(async () => { throw new DriveAuthError("revoked"); });
    resetUserTokenCacheForTests();
    const t = await testDrive(db);
    assert.equal(t.ok, false);
    assert.equal((t as { code: string }).code, "TOKEN_INVALID");
  });

  it("disconnect removes rules, remote and token in FK-safe order", async () => {
    const { db } = await makeSharedDb();
    __setDriveRestFetchForTests((async (url: string) =>
      url.includes("/drives") ? okJson({ drives: [] }) : okJson({ files: [] })) as typeof fetch);
    await connectDrive(db, CONN);
    await setDriveTarget(db, { userId: "U1", shared_drive_id: "D1" });
    await disconnectDrive(db);
    assert.equal(await (await getTokenStore()).read("gdrive"), null);
    assert.ok((await listRules(db)).every((r) => r.remote_name !== "gdrive"));
    const s = await driveStatus(db);
    assert.equal(s.configured, false);
    assert.equal(s.connected, false);
  });
});

describe("routing error guidance", () => {
  it("store failure without routing tells the agent and the user what to do", async () => {
    const { ROUTING_GUIDANCE } = await import("../apps/server/domain/sync/engine.js");
    assert.match(ROUTING_GUIDANCE, /Nastavení → Synchronizace/);
    assert.match(ROUTING_GUIDANCE, /portuni_setup_remote/);
    assert.match(ROUTING_GUIDANCE, /portuni_list_remotes/);
  });
});
