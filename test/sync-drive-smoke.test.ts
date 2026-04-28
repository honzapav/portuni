import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDriveAdapter } from "../src/domain/sync/drive-adapter.js";
import type { RemoteConfig, DeviceTokens } from "../src/domain/sync/types.js";

const enabled = process.env.PORTUNI_DRIVE_TEST === "1";
function req(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Requires ${n}`);
  return v;
}

describe("Drive smoke", { skip: !enabled }, () => {
  it("put + stat + get + delete against real shared drive", async () => {
    const remote: RemoteConfig = {
      name: "drive-smoke",
      type: "gdrive",
      config: { shared_drive_id: req("PORTUNI_DRIVE_TEST_SHARED_DRIVE_ID") },
    };
    const tokens: DeviceTokens = {
      "drive-smoke": { mode: "service_account", service_account_json: req("PORTUNI_DRIVE_TEST_SA_JSON") },
    };
    const adapter = createDriveAdapter(remote, tokens);
    const path = `portuni-smoke-${Date.now()}.txt`;
    const payload = Buffer.from(`smoke ${Date.now()}`);
    await adapter.put(path, payload);
    const stat = await adapter.stat(path);
    assert.ok(stat);
    const content = await adapter.get(path);
    assert.deepEqual(Buffer.from(content), payload);
    await adapter.delete(path);
    assert.equal(await adapter.stat(path), null);
  });
});
