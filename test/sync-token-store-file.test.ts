import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { createFileTokenStore } from "../src/domain/sync/token-store-file.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-tsfile-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("FileTokenStore", () => {
  it("read returns null when file is missing", async () => {
    const store = createFileTokenStore();
    assert.equal(await store.read("any"), null);
  });
  it("write + read roundtrip", async () => {
    const store = createFileTokenStore();
    await store.write("r1", { mode: "service_account", service_account_json: '{"a":1}' });
    const t = await store.read("r1");
    assert.ok(t);
    assert.equal(t!.mode, "service_account");
    assert.equal(t!.service_account_json, '{"a":1}');
  });
  it("delete removes entry", async () => {
    const store = createFileTokenStore();
    await store.write("r1", { refresh_token: "x" });
    await store.delete("r1");
    assert.equal(await store.read("r1"), null);
  });
  it("file has mode 0600 (unix only)", { skip: platform() === "win32" }, async () => {
    const store = createFileTokenStore();
    await store.write("r1", { refresh_token: "x" });
    const path = join(workspace, ".portuni", "tokens.json");
    const s = await stat(path);
    // Check no group/other bits.
    assert.equal((s.mode & 0o777) & 0o077, 0, `mode was ${(s.mode & 0o777).toString(8)}`);
  });
  it("multiple entries in same map", async () => {
    const store = createFileTokenStore();
    await store.write("a", { refresh_token: "ra" });
    await store.write("b", { refresh_token: "rb" });
    assert.equal((await store.read("a"))!.refresh_token, "ra");
    assert.equal((await store.read("b"))!.refresh_token, "rb");
  });
});
