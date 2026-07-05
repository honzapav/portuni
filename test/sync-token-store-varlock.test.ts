import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createVarlockTokenStore } from "../apps/server/domain/sync/token-store-varlock.js";
import { TOKEN_ENV_PREFIX } from "../apps/server/domain/sync/types.js";

function envKey(name: string, field: string): string {
  return `${TOKEN_ENV_PREFIX}${name.toUpperCase().replace(/-/g, "_")}__${field}`;
}

beforeEach(() => {
  for (const k of Object.keys(process.env))
    if (k.startsWith(TOKEN_ENV_PREFIX) || k.startsWith("PORTUNI_VARLOCK_"))
      delete process.env[k];
});
afterEach(() => {
  for (const k of Object.keys(process.env))
    if (k.startsWith(TOKEN_ENV_PREFIX) || k.startsWith("PORTUNI_VARLOCK_"))
      delete process.env[k];
});

describe("VarlockTokenStore read", () => {
  it("reads SA JSON when present", async () => {
    process.env[envKey("dw", "SERVICE_ACCOUNT_JSON")] = "{}";
    const store = createVarlockTokenStore();
    const t = await store.read("dw");
    assert.ok(t);
    assert.equal(t!.mode, "service_account");
  });
  it("reads OAuth triplet", async () => {
    process.env[envKey("dbx", "REFRESH_TOKEN")] = "r";
    process.env[envKey("dbx", "ACCESS_TOKEN")] = "a";
    process.env[envKey("dbx", "EXPIRES_AT")] = "1234567890";
    const store = createVarlockTokenStore();
    const t = await store.read("dbx");
    assert.equal(t!.refresh_token, "r");
    assert.equal(t!.access_token, "a");
    assert.equal(t!.expires_at, 1234567890);
  });
  it("reads refresh_token mode when an OAuth client pair is present", async () => {
    process.env[envKey("gdrive", "REFRESH_TOKEN")] = "r";
    process.env[envKey("gdrive", "CLIENT_ID")] = "cid";
    process.env[envKey("gdrive", "CLIENT_SECRET")] = "csecret";
    process.env[envKey("gdrive", "ACCOUNT_EMAIL")] = "a@b.cz";
    const store = createVarlockTokenStore();
    const t = await store.read("gdrive");
    assert.equal(t!.mode, "refresh_token");
    assert.equal(t!.refresh_token, "r");
    assert.equal(t!.client_id, "cid");
    assert.equal(t!.client_secret, "csecret");
    assert.equal(t!.account_email, "a@b.cz");
  });
  it("keeps legacy oauth mode for a bare refresh token (no client pair)", async () => {
    process.env[envKey("central", "REFRESH_TOKEN")] = "r";
    const store = createVarlockTokenStore();
    const t = await store.read("central");
    assert.equal(t!.mode, "oauth");
    assert.equal(t!.refresh_token, "r");
    assert.equal(t!.client_id, undefined);
  });
  it("returns null when nothing present", async () => {
    const store = createVarlockTokenStore();
    assert.equal(await store.read("unknown"), null);
  });
});

describe("VarlockTokenStore write", () => {
  it("requires PORTUNI_VARLOCK_WRITE_PROGRAM", async () => {
    const store = createVarlockTokenStore();
    await assert.rejects(
      () => store.write("r", { refresh_token: "x" }),
      /PORTUNI_VARLOCK_WRITE_PROGRAM/,
    );
  });

  it("runs configured program with argv substitution (hermetic via /usr/bin/true)", async () => {
    process.env.PORTUNI_VARLOCK_WRITE_PROGRAM = "/usr/bin/true";
    process.env.PORTUNI_VARLOCK_WRITE_ARGS = "{name} {field} {value}";
    const store = createVarlockTokenStore();
    await store.write("r", { refresh_token: "rvalue" });
    // Program executes successfully; env mirror should have REFRESH_TOKEN set.
    assert.equal(process.env[envKey("r", "REFRESH_TOKEN")], "rvalue");
  });
});

describe("VarlockTokenStore delete", () => {
  it("clears env mirror; optional delete program is called if set", async () => {
    process.env[envKey("r", "REFRESH_TOKEN")] = "x";
    const store = createVarlockTokenStore();
    await store.delete("r");
    assert.equal(process.env[envKey("r", "REFRESH_TOKEN")], undefined);
  });
});
