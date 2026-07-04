import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GoogleAdapter,
  createGoogleAdapter,
  parseAllowedDomains,
} from "../apps/server/auth/google-adapter.js";

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
    groups: Array<{ id: string; email: string }>;
    allGroups: Array<{ id: string; email: string; name: string }>;
    allowedDomain: string;
    roleConfig: { admin: string[]; manage: string[]; write: string[] };
    now: () => number;
  }> = {},
) {
  let groupCalls = 0;
  let allGroupsCalls = 0;
  const adapter = new GoogleAdapter({
    verifyIdToken: async () =>
      overrides.payload === undefined ? basePayload : overrides.payload,
    listGroups: async () => {
      groupCalls += 1;
      return overrides.groups ?? [];
    },
    listAllGroups: async () => {
      allGroupsCalls += 1;
      return overrides.allGroups ?? [];
    },
    allowedDomains: [overrides.allowedDomain ?? "workflow.ooo"],
    roleConfig: overrides.roleConfig ?? {
      admin: ["portuni-admins@workflow.ooo"],
      manage: [],
      write: ["portuni-team@workflow.ooo"],
    },
    now: overrides.now ?? (() => Date.now()),
  });
  return { adapter, groupCalls: () => groupCalls, allGroupsCalls: () => allGroupsCalls };
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
  const { adapter } = makeAdapter({
    groups: [{ id: "01abc", email: "portuni-team@workflow.ooo" }],
  });
  const access = await adapter.resolveAccess("a@workflow.ooo");
  assert.equal(access.globalScope, "write");
  assert.deepEqual(access.groups, ["portuni-team@workflow.ooo"]);
  assert.deepEqual(access.groupIds, ["01abc"]);
});

test("resolveAccess preserves group id even when email casing differs", async () => {
  const { adapter } = makeAdapter({
    groups: [{ id: "01abc", email: "Portuni-Team@Workflow.ooo" }],
  });
  const access = await adapter.resolveAccess("a@workflow.ooo");
  assert.deepEqual(access.groups, ["portuni-team@workflow.ooo"]);
  assert.deepEqual(access.groupIds, ["01abc"]);
});

test("resolveAccess caches for 15 minutes", async () => {
  let t = 1_000_000;
  const { adapter, groupCalls } = makeAdapter({
    groups: [{ id: "01abc", email: "portuni-team@workflow.ooo" }],
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
    listAllGroups: async () => [],
    allowedDomains: ["workflow.ooo"],
    roleConfig: { admin: [], manage: [], write: [] },
  });
  const r = await adapter.verifyWithProfile("token");
  assert.equal(verifyCalls, 1);
  assert.equal(r.identity.email, "a@workflow.ooo");
  assert.equal(r.avatarUrl, "https://p/x.png");
});

test("listDomainGroups filters by email/name (case-insensitive) and caps at 20", async () => {
  const { adapter } = makeAdapter({
    allGroups: [
      { id: "1", email: "eng-team@workflow.ooo", name: "Engineering Team" },
      { id: "2", email: "sales@workflow.ooo", name: "Sales" },
      { id: "3", email: "eng-leads@workflow.ooo", name: "Engineering Leads" },
    ],
  });
  const result = await adapter.listDomainGroups("eng");
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((g) => g.id).sort(),
    ["1", "3"],
  );
});

test("listDomainGroups caches the directory fetch for 5 minutes", async () => {
  let t = 1_000_000;
  const { adapter, allGroupsCalls } = makeAdapter({
    allGroups: [{ id: "1", email: "eng@workflow.ooo", name: "Engineering" }],
    now: () => t,
  });
  await adapter.listDomainGroups("");
  await adapter.listDomainGroups("eng");
  assert.equal(allGroupsCalls(), 1, "second call within TTL served from cache");
  t += 5 * 60 * 1000 + 1;
  await adapter.listDomainGroups("");
  assert.equal(allGroupsCalls(), 2, "expired cache refetches");
});

test("listDomainGroups caps results at 20 even with more matches", async () => {
  const allGroups = Array.from({ length: 25 }, (_, i) => ({
    id: `g${i}`,
    email: `team${i}@workflow.ooo`,
    name: `Team ${i}`,
  }));
  const { adapter } = makeAdapter({ allGroups });
  const result = await adapter.listDomainGroups("team");
  assert.equal(result.length, 20, "result is capped at 20 despite 25 matches");
});

test("listDomainGroups coalesces concurrent cold-cache fetches into a single listAllGroups call", async () => {
  let allGroupsCalls = 0;
  let resolveFetch: ((groups: Array<{ id: string; email: string; name: string }>) => void) | null =
    null;
  const fetchPromise = new Promise<Array<{ id: string; email: string; name: string }>>(
    (resolve) => {
      resolveFetch = resolve;
    },
  );
  const adapter = new GoogleAdapter({
    verifyIdToken: async () => basePayload,
    listGroups: async () => [],
    listAllGroups: async () => {
      allGroupsCalls += 1;
      return fetchPromise;
    },
    allowedDomains: ["workflow.ooo"],
    roleConfig: { admin: [], manage: [], write: [] },
  });

  const p1 = adapter.listDomainGroups("eng");
  const p2 = adapter.listDomainGroups("eng");
  assert.ok(resolveFetch, "listAllGroups must have been invoked synchronously by both callers");
  resolveFetch!([{ id: "1", email: "eng@workflow.ooo", name: "Engineering" }]);
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(allGroupsCalls, 1, "concurrent cold-cache calls must coalesce into one fetch");
  assert.equal(r1.length, 1);
  assert.equal(r2.length, 1);
});

test("listDomainGroups does not poison the cache on a rejected fetch and allows retry", async () => {
  let allGroupsCalls = 0;
  const adapter = new GoogleAdapter({
    verifyIdToken: async () => basePayload,
    listGroups: async () => [],
    listAllGroups: async () => {
      allGroupsCalls += 1;
      if (allGroupsCalls === 1) throw new Error("directory API unavailable");
      return [{ id: "1", email: "eng@workflow.ooo", name: "Engineering" }];
    },
    allowedDomains: ["workflow.ooo"],
    roleConfig: { admin: [], manage: [], write: [] },
  });

  await assert.rejects(adapter.listDomainGroups("eng"), /directory API unavailable/);
  const result = await adapter.listDomainGroups("eng");
  assert.equal(allGroupsCalls, 2, "retry after rejection triggers a fresh fetch");
  assert.equal(result.length, 1);
});

test("verify accepts any domain in a multi-domain allow list", async () => {
  const adapter = new GoogleAdapter({
    verifyIdToken: async () => ({ ...basePayload, email: "b@tempo.ooo", hd: "tempo.ooo" }),
    listGroups: async () => [],
    listAllGroups: async () => [],
    allowedDomains: ["workflow.ooo", "tempo.ooo"],
    roleConfig: { admin: [], manage: [], write: [] },
  });
  const id = await adapter.verify("token");
  assert.equal(id.email, "b@tempo.ooo");
});

test("verify rejects a domain not in a multi-domain allow list", async () => {
  const adapter = new GoogleAdapter({
    verifyIdToken: async () => ({ ...basePayload, email: "x@gmail.com", hd: "gmail.com" }),
    listGroups: async () => [],
    listAllGroups: async () => [],
    allowedDomains: ["workflow.ooo", "tempo.ooo"],
    roleConfig: { admin: [], manage: [], write: [] },
  });
  await assert.rejects(adapter.verify("token"), /domain/i);
});

test("verify accepts domain with whitespace in allowed list after trim", async () => {
  const adapter = new GoogleAdapter({
    verifyIdToken: async () => basePayload,
    listGroups: async () => [],
    listAllGroups: async () => [],
    allowedDomains: ["  Workflow.OOO  ", "tempo.ooo"],
    roleConfig: { admin: [], manage: [], write: [] },
  });
  const id = await adapter.verify("token");
  assert.equal(id.email, "a@workflow.ooo");
});

test("createGoogleAdapter parses PORTUNI_ALLOWED_DOMAINS as a comma list, trimmed and lowercased", () => {
  const domains = parseAllowedDomains({
    PORTUNI_ALLOWED_DOMAINS: "workflow.ooo, Tempo.ooo",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(domains, ["workflow.ooo", "tempo.ooo"]);
});

test("createGoogleAdapter falls back to the singular PORTUNI_ALLOWED_DOMAIN when plural is unset", () => {
  const domains = parseAllowedDomains({
    PORTUNI_ALLOWED_DOMAIN: "workflow.ooo",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(domains, ["workflow.ooo"]);
});

test("createGoogleAdapter prefers PORTUNI_ALLOWED_DOMAINS over the singular fallback when both are set", () => {
  const domains = parseAllowedDomains({
    PORTUNI_ALLOWED_DOMAINS: "workflow.ooo,tempo.ooo",
    PORTUNI_ALLOWED_DOMAIN: "evil.com",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(domains, ["workflow.ooo", "tempo.ooo"]);
});

test("createGoogleAdapter throws when neither PORTUNI_ALLOWED_DOMAINS nor PORTUNI_ALLOWED_DOMAIN is set", () => {
  assert.throws(
    () =>
      createGoogleAdapter({
        PORTUNI_GOOGLE_CLIENT_IDS: "client-1",
      } as NodeJS.ProcessEnv),
    /PORTUNI_ALLOWED_DOMAINS is required/,
  );
});
