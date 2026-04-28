import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeSharedDb } from "./helpers/shared-db.js";
import {
  listRemotesService,
  setupRemoteService,
  setRoutingPolicyService,
} from "../src/mcp/tools/sync-remotes.js";
import { upsertRemote, listRules } from "../src/domain/sync/routing.js";
import { TOKEN_ENV_PREFIX } from "../src/domain/sync/device-tokens.js";
import { resetTokenStoreForTests } from "../src/domain/sync/token-store.js";

function envKey(name: string, field: string): string {
  return `${TOKEN_ENV_PREFIX}${name.toUpperCase().replace(/-/g, "_")}__${field}`;
}

let originalTokenStore: string | undefined;
let originalWorkspaceRoot: string | undefined;

beforeEach(() => {
  for (const k of Object.keys(process.env))
    if (k.startsWith(TOKEN_ENV_PREFIX)) delete process.env[k];
  originalTokenStore = process.env.PORTUNI_TOKEN_STORE;
  originalWorkspaceRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_TOKEN_STORE = "varlock";
  resetTokenStoreForTests();
});
afterEach(() => {
  for (const k of Object.keys(process.env))
    if (k.startsWith(TOKEN_ENV_PREFIX)) delete process.env[k];
  if (originalTokenStore === undefined) delete process.env.PORTUNI_TOKEN_STORE;
  else process.env.PORTUNI_TOKEN_STORE = originalTokenStore;
  if (originalWorkspaceRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalWorkspaceRoot;
  resetTokenStoreForTests();
});

describe("listRemotesService auth detection", () => {
  it("fs remotes always authenticated", async () => {
    const { db } = await makeSharedDb();
    const list = await listRemotesService(db);
    const fs = list.find((r) => r.name === "test-fs");
    assert.ok(fs);
    assert.equal(fs.authenticated, true);
  });

  it("reports gdrive remote with SA JSON in env as authenticated", async () => {
    const { db } = await makeSharedDb();
    await upsertRemote(db, {
      name: "drive-w",
      type: "gdrive",
      config: { shared_drive_id: "0AX" },
      created_by: "U1",
    });
    process.env[envKey("drive-w", "SERVICE_ACCOUNT_JSON")] = "{}";
    const all = await listRemotesService(db);
    const drive = all.find((r) => r.name === "drive-w");
    assert.ok(drive);
    assert.equal(drive.authenticated, true);
  });

  it("reports gdrive remote without SA JSON as not authenticated", async () => {
    const { db } = await makeSharedDb();
    await upsertRemote(db, {
      name: "drive-w",
      type: "gdrive",
      config: { shared_drive_id: "0AX" },
      created_by: "U1",
    });
    const all = await listRemotesService(db);
    const drive = all.find((r) => r.name === "drive-w");
    assert.ok(drive);
    assert.equal(drive.authenticated, false);
  });

  it("reports non-gdrive remote with refresh_token as authenticated", async () => {
    const { db } = await makeSharedDb();
    await upsertRemote(db, {
      name: "dbx",
      type: "dropbox",
      config: {},
      created_by: "U1",
    });
    process.env[envKey("dbx", "REFRESH_TOKEN")] = "r";
    const all = await listRemotesService(db);
    const dbx = all.find((r) => r.name === "dbx");
    assert.equal(dbx?.authenticated, true);
  });
});

describe("setupRemoteService + setRoutingPolicyService", () => {
  it("fs remote requires config.root string", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(
      () =>
        setupRemoteService(db, {
          userId: "U1",
          name: "bad-fs",
          type: "fs",
          config: {},
        }),
      /root/,
    );
  });

  it("routing policy replace works", async () => {
    const { db } = await makeSharedDb();
    await setRoutingPolicyService(db, [
      { priority: 5, node_type: "project", org_slug: null, remote_name: "test-fs" },
      { priority: 20, node_type: null, org_slug: null, remote_name: "test-fs" },
    ]);
    const rules = await listRules(db);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].priority, 5);
  });
});

describe("setupRemoteService gdrive validation", () => {
  it("rejects gdrive without service_account_json", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(
      () =>
        setupRemoteService(db, {
          userId: "U1",
          name: "g1",
          type: "gdrive",
          config: { shared_drive_id: "0AX" },
        }),
      /service_account_json/,
    );
  });

  it("rejects gdrive with invalid SA JSON", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(
      () =>
        setupRemoteService(db, {
          userId: "U1",
          name: "g1",
          type: "gdrive",
          config: { shared_drive_id: "0AX" },
          service_account_json: "not json",
        }),
      /JSON/,
    );
  });

  it("rejects gdrive without shared_drive_id", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(
      () =>
        setupRemoteService(db, {
          userId: "U1",
          name: "g1",
          type: "gdrive",
          config: {},
          service_account_json: JSON.stringify({
            type: "service_account",
            client_email: "x@y",
            private_key: "k",
            token_uri: "t",
          }),
        }),
      /shared_drive_id/,
    );
  });

  it("accepts fully-valid gdrive config and writes SA via TokenStore", async () => {
    const { db } = await makeSharedDb();
    // Use file store with a temp workspace so write is self-contained.
    process.env.PORTUNI_TOKEN_STORE = "file";
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const wsRoot = await mkdtemp(join(tmpdir(), "portuni-setup-gdrive-"));
    process.env.PORTUNI_WORKSPACE_ROOT = wsRoot;
    resetTokenStoreForTests();
    const sa = JSON.stringify({
      type: "service_account",
      client_email: "a@b",
      private_key: "k",
      token_uri: "t",
    });
    try {
      await setupRemoteService(db, {
        userId: "U1",
        name: "g2",
        type: "gdrive",
        config: { shared_drive_id: "0AX" },
        service_account_json: sa,
      });
      // Verify TokenStore has it.
      const { getTokenStore } = await import("../src/domain/sync/token-store.js");
      const store = await getTokenStore();
      const t = await store.read("g2");
      assert.ok(t?.service_account_json?.includes("client_email"));
    } finally {
      await rm(wsRoot, { recursive: true, force: true });
    }
  });
});
