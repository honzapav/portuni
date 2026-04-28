import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createKeychainTokenStore } from "../src/domain/sync/token-store-keychain.js";

const execFileP = promisify(execFile);

// Only run on macOS where `security` is reliably available.
const enabled = platform() === "darwin";
const REMOTE = `portuni-test-${process.pid}-${Date.now()}`;

async function cleanup(): Promise<void> {
  try {
    await execFileP("security", [
      "delete-generic-password",
      "-s",
      `portuni-sync-${REMOTE}`,
      "-a",
      "portuni",
    ]);
  } catch {
    /* ok */
  }
}

describe("KeychainTokenStore (macOS)", { skip: !enabled }, () => {
  before(cleanup);
  after(cleanup);

  it("write + read + delete roundtrip", async () => {
    const store = createKeychainTokenStore();
    assert.equal(await store.read(REMOTE), null);
    await store.write(REMOTE, { mode: "oauth", refresh_token: "rt" });
    const got = await store.read(REMOTE);
    assert.ok(got);
    assert.equal(got!.refresh_token, "rt");
    await store.delete(REMOTE);
    assert.equal(await store.read(REMOTE), null);
  });
});
