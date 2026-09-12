import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { getTokenStore, resetTokenStoreForTests } from "../apps/server/domain/sync/token-store.js";
import { setupRemoteService } from "../apps/server/domain/sync/remote-service.js";
import { LocalModeNoRemoteError } from "../apps/server/domain/sync/types.js";

let workspace: string;

const SAMPLE_SA = JSON.stringify({
  type: "service_account",
  client_email: "portuni@proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n",
  token_uri: "https://oauth2.googleapis.com/token",
});

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-remotesvc-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  process.env.PORTUNI_TOKEN_STORE = "file";
  // These tests exercise remote-service.ts's business logic, not the
  // LOCAL_MODE_NO_REMOTE guard (#310) -- that has its own describe block
  // below, which unsets this again.
  process.env.PORTUNI_AGENT_MODE = "1";
  resetTokenStoreForTests();
});

afterEach(async () => {
  resetTokenStoreForTests();
  delete process.env.PORTUNI_TOKEN_STORE;
  delete process.env.PORTUNI_AGENT_MODE;
  await rm(workspace, { recursive: true, force: true });
});

describe("routing error guidance", () => {
  it("store failure without routing tells the agent and the user what to do", async () => {
    const { ROUTING_GUIDANCE } = await import("../apps/server/domain/sync/engine.js");
    assert.match(ROUTING_GUIDANCE, /portuni_setup_remote/);
    assert.match(ROUTING_GUIDANCE, /portuni_list_remotes/);
  });
});

describe("setupRemoteService SA My-Drive guard", () => {
  it("rejects a service-account remote configured with root_folder_id only", async () => {
    const { db } = await makeSharedDb();
    await assert.rejects(
      setupRemoteService(db, {
        userId: "U1",
        name: "gdrive",
        type: "gdrive",
        config: { root_folder_id: "F1" },
        service_account_json: SAMPLE_SA,
      }),
      /Personal My Drive is not supported/,
    );
  });
});

describe("local workspace cannot register or route to a remote (#310)", () => {
  it("setupRemoteService refuses with LOCAL_MODE_NO_REMOTE", async () => {
    delete process.env.PORTUNI_AGENT_MODE;
    const { db } = await makeSharedDb();
    await assert.rejects(
      setupRemoteService(db, { userId: "U1", name: "x", type: "fs", config: { root: "/tmp/x" } }),
      (err: unknown) => err instanceof LocalModeNoRemoteError,
    );
    // No side effect leaked through.
    assert.equal(await (await getTokenStore()).read("gdrive"), null);
  });
});
