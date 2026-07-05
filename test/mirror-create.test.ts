import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeSharedDb } from "./helpers/shared-db.js";
import {
  createMirrorForNode,
  MirrorCreateError,
  DEVICE_LOCAL_HINT,
} from "../apps/server/domain/sync/mirror-create.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { setDbForTesting } from "../apps/server/infra/db.js";

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(() => {
  setDbForTesting(null);
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
});

// On the central server PORTUNI_WORKSPACE_ROOT is never set (no local file
// plane), so this is the error path users actually hit there -- it must
// point them at the desktop app / local agent MCP instead of reading like a
// generic misconfiguration.
describe("mirror creation without a workspace root", () => {
  it("WORKSPACE_ROOT_UNSET error carries the device-local hint", async () => {
    const { db, nodeId } = await makeSharedDb();
    setDbForTesting(db);

    await assert.rejects(
      () => createMirrorForNode(db, "U1", { nodeId }),
      (e: unknown) =>
        e instanceof MirrorCreateError &&
        e.code === "WORKSPACE_ROOT_UNSET" &&
        e.message.includes("device-local operation"),
    );
  });

  it("exports the exact device-local hint text", () => {
    assert.equal(
      DEVICE_LOCAL_HINT,
      "this is a device-local operation: this server has no local file plane. Run it via the Portuni desktop app (or its local agent MCP) on the device that owns the mirror.",
    );
  });
});
