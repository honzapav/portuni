import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleAdapter } from "../src/auth/google-adapter.js";

const basePayload = {
  sub: "g-sub-1",
  email: "a@workflow.ooo",
  email_verified: true,
  name: "A",
  picture: "https://p/x.png",
  hd: "workflow.ooo",
};

function makeAdapter(
  overrides: Partial<{
    payload: typeof basePayload | null;
    groups: string[];
    allowedDomain: string;
    roleConfig: { admin: string[]; manage: string[]; write: string[] };
    now: () => number;
  }> = {},
) {
  let groupCalls = 0;
  const adapter = new GoogleAdapter({
    verifyIdToken: async () =>
      overrides.payload === undefined ? basePayload : overrides.payload,
    listGroups: async () => {
      groupCalls += 1;
      return overrides.groups ?? [];
    },
    allowedDomain: overrides.allowedDomain ?? "workflow.ooo",
    roleConfig: overrides.roleConfig ?? {
      admin: ["portuni-admins@workflow.ooo"],
      manage: [],
      write: ["portuni-team@workflow.ooo"],
    },
    now: overrides.now ?? (() => Date.now()),
  });
  return { adapter, groupCalls: () => groupCalls };
}

test("verify returns identity for a valid token in the allowed domain", async () => {
  const { adapter } = makeAdapter();
  const id = await adapter.verify("token");
  assert.equal(id.email, "a@workflow.ooo");
  assert.equal(id.sub, "g-sub-1");
});

test("verify rejects wrong domain", async () => {
  const { adapter } = makeAdapter({
    payload: { ...basePayload, email: "x@evil.com", hd: "evil.com" },
  });
  await assert.rejects(adapter.verify("token"), /domain/i);
});

test("verify rejects unverified email", async () => {
  const { adapter } = makeAdapter({
    payload: { ...basePayload, email_verified: false },
  });
  await assert.rejects(adapter.verify("token"));
});

test("resolveAccess maps groups to scope", async () => {
  const { adapter } = makeAdapter({ groups: ["portuni-team@workflow.ooo"] });
  const access = await adapter.resolveAccess("a@workflow.ooo");
  assert.equal(access.globalScope, "write");
  assert.deepEqual(access.groups, ["portuni-team@workflow.ooo"]);
});

test("resolveAccess caches for 15 minutes", async () => {
  let t = 1_000_000;
  const { adapter, groupCalls } = makeAdapter({
    groups: ["portuni-team@workflow.ooo"],
    now: () => t,
  });
  await adapter.resolveAccess("a@workflow.ooo");
  await adapter.resolveAccess("a@workflow.ooo");
  assert.equal(groupCalls(), 1, "second call within TTL served from cache");
  t += 16 * 60 * 1000;
  await adapter.resolveAccess("a@workflow.ooo");
  assert.equal(groupCalls(), 2, "expired cache refetches");
});

test("verifyWithProfile verifies the token exactly once and returns avatar", async () => {
  let verifyCalls = 0;
  const adapter = new GoogleAdapter({
    verifyIdToken: async () => {
      verifyCalls += 1;
      return basePayload;
    },
    listGroups: async () => [],
    allowedDomain: "workflow.ooo",
    roleConfig: { admin: [], manage: [], write: [] },
  });
  const r = await adapter.verifyWithProfile("token");
  assert.equal(verifyCalls, 1);
  assert.equal(r.identity.email, "a@workflow.ooo");
  assert.equal(r.avatarUrl, "https://p/x.png");
});
