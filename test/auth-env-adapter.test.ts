import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvAdapter } from "../src/auth/env-adapter.js";

test("EnvAdapter returns identity from env with defaults", async () => {
  const adapter = new EnvAdapter({
    PORTUNI_USER_EMAIL: "honza@workflow.ooo",
    PORTUNI_USER_NAME: "Honza",
  } as NodeJS.ProcessEnv);
  const id = await adapter.verify("ignored");
  assert.equal(id.email, "honza@workflow.ooo");
  assert.equal(id.name, "Honza");
  assert.equal(id.sub, "env:honza@workflow.ooo");
});

test("EnvAdapter defaults match the historical SOLO_USER seed", async () => {
  const adapter = new EnvAdapter({} as NodeJS.ProcessEnv);
  const id = await adapter.verify("ignored");
  assert.equal(id.email, "solo@localhost");
  assert.equal(id.name, "Solo User");
});

test("EnvAdapter grants admin with no groups", async () => {
  const adapter = new EnvAdapter({} as NodeJS.ProcessEnv);
  const access = await adapter.resolveAccess("solo@localhost");
  assert.equal(access.globalScope, "admin");
  assert.deepEqual(access.groups, []);
});
