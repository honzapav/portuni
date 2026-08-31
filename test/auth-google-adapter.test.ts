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

// Task 14 point 10: TTL boundary. `now - fetchedAt >= TTL` refetches, so an
// elapsed time of EXACTLY the TTL (not TTL+1) must already count as
// expired -- pin the boundary itself, not just "well past it".
test("listDomainGroups refetches when elapsed time is exactly the TTL boundary", async () => {
  let t = 1_000_000;
  const ALL_GROUPS_CACHE_TTL_MS = 5 * 60 * 1000;
  const { adapter, allGroupsCalls } = makeAdapter({
    allGroups: [{ id: "1", email: "eng@workflow.ooo", name: "Engineering" }],
    now: () => t,
  });
  await adapter.listDomainGroups("");
  assert.equal(allGroupsCalls(), 1);

  t += ALL_GROUPS_CACHE_TTL_MS; // exactly at the boundary, not past it
  await adapter.listDomainGroups("");
  assert.equal(allGroupsCalls(), 2, "elapsed time exactly == TTL must count as expired and refetch");
});

// Task 14 point 10: two concurrent cold-cache calls with DIFFERENT queries
// must still coalesce into a single listAllGroups fetch, and each caller
// must get back its own query's filtered result (not the other's).
test("listDomainGroups: concurrent calls with different queries share one fetch, each gets its own filtered result", async () => {
  let allGroupsCalls = 0;
  let resolveFetch: ((groups: Array<{ id: string; email: string; name: string }>) => void) | null =
    null;
  const fetchPromise = new Promise<Array<{ id: string; email: string; name: string }>>((resolve) => {
    resolveFetch = resolve;
  });
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

  const pEng = adapter.listDomainGroups("eng");
  const pSales = adapter.listDomainGroups("sales");
  assert.ok(resolveFetch, "listAllGroups must have been invoked synchronously by both callers");
  resolveFetch!([
    { id: "1", email: "eng-team@workflow.ooo", name: "Engineering Team" },
    { id: "2", email: "sales@workflow.ooo", name: "Sales" },
  ]);
  const [engResult, salesResult] = await Promise.all([pEng, pSales]);

  assert.equal(allGroupsCalls, 1, "concurrent cold-cache calls with different queries must still coalesce");
  assert.deepEqual(engResult.map((g) => g.id), ["1"], "the 'eng' caller must get only the eng match");
  assert.deepEqual(salesResult.map((g) => g.id), ["2"], "the 'sales' caller must get only the sales match");
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

// interactiveLogin: the OAuth connector's upstream login step
// (docs/superpowers/specs/2026-08-31-oauth-connectors-design.md, "Adapter
// interface"). Exercised against a fake exchangeCode/redirectUrl upstream --
// never a real Google endpoint.

test("interactiveLogin is absent without a fake upstream configured", () => {
  const { adapter } = makeAdapter();
  assert.equal(adapter.interactiveLogin, undefined);
});

function makeInteractiveAdapter(
  overrides: Partial<{
    payload: typeof basePayload | null;
    allowedDomain: string;
  }> = {},
) {
  let exchangeCalls = 0;
  const adapter = new GoogleAdapter({
    verifyIdToken: async () => basePayload,
    listGroups: async () => [],
    listAllGroups: async () => [],
    allowedDomains: [overrides.allowedDomain ?? "workflow.ooo"],
    roleConfig: { admin: [], manage: [], write: [] },
    interactiveLogin: {
      redirectUrl: (state) => `https://accounts.google.com/fake-auth?state=${state}`,
      exchangeCode: async (code) => {
        exchangeCalls += 1;
        if (code !== "good-code") return null;
        return overrides.payload === undefined ? basePayload : overrides.payload;
      },
    },
  });
  return { adapter, exchangeCalls: () => exchangeCalls };
}

test("interactiveLogin.redirectUrl delegates to the injected upstream, carrying the state through", () => {
  const { adapter } = makeInteractiveAdapter();
  assert.equal(
    adapter.interactiveLogin!.redirectUrl("csrf-state"),
    "https://accounts.google.com/fake-auth?state=csrf-state",
  );
});

test("interactiveLogin.handleCallback exchanges the code and returns identity + avatar", async () => {
  const { adapter, exchangeCalls } = makeInteractiveAdapter();
  const result = await adapter.interactiveLogin!.handleCallback(
    new URLSearchParams({ code: "good-code" }),
  );
  assert.equal(exchangeCalls(), 1);
  assert.equal(result.identity.email, "a@workflow.ooo");
  assert.equal(result.avatarUrl, "https://p/x.png");
});

test("interactiveLogin.handleCallback rejects a missing code", async () => {
  const { adapter } = makeInteractiveAdapter();
  await assert.rejects(
    adapter.interactiveLogin!.handleCallback(new URLSearchParams()),
    /Missing Google authorization code/,
  );
});

test("interactiveLogin.handleCallback surfaces an upstream error param without exchanging a code", async () => {
  const { adapter, exchangeCalls } = makeInteractiveAdapter();
  await assert.rejects(
    adapter.interactiveLogin!.handleCallback(new URLSearchParams({ error: "access_denied" })),
    /Google OAuth error: access_denied/,
  );
  assert.equal(exchangeCalls(), 0);
});

test("interactiveLogin.handleCallback rejects when the exchange yields no payload", async () => {
  const { adapter } = makeInteractiveAdapter();
  await assert.rejects(
    adapter.interactiveLogin!.handleCallback(new URLSearchParams({ code: "bad-code" })),
    /Invalid Google ID token/,
  );
});

test("interactiveLogin.handleCallback enforces the same allowed-domain gate as verify()", async () => {
  const { adapter } = makeInteractiveAdapter({
    payload: { ...basePayload, email: "x@evil.com", hd: "evil.com" },
  });
  await assert.rejects(
    adapter.interactiveLogin!.handleCallback(new URLSearchParams({ code: "good-code" })),
    /domain/i,
  );
});

test("interactiveLogin.handleCallback enforces email_verified like verify()", async () => {
  const { adapter } = makeInteractiveAdapter({
    payload: { ...basePayload, email_verified: false },
  });
  await assert.rejects(
    adapter.interactiveLogin!.handleCallback(new URLSearchParams({ code: "good-code" })),
  );
});

test("createGoogleAdapter wires interactiveLogin only when client id, secret and public URL are all set", () => {
  const withoutOauthVars = createGoogleAdapter({
    PORTUNI_GOOGLE_CLIENT_IDS: "client-1",
    PORTUNI_ALLOWED_DOMAINS: "workflow.ooo",
    PORTUNI_GOOGLE_SA_KEY_JSON: JSON.stringify({ client_email: "sa@x", private_key: "k" }),
    PORTUNI_GOOGLE_IMPERSONATE: "admin@workflow.ooo",
  } as NodeJS.ProcessEnv);
  assert.equal(withoutOauthVars.interactiveLogin, undefined);

  const withOauthVars = createGoogleAdapter({
    PORTUNI_GOOGLE_CLIENT_IDS: "client-1",
    PORTUNI_ALLOWED_DOMAINS: "workflow.ooo",
    PORTUNI_GOOGLE_SA_KEY_JSON: JSON.stringify({ client_email: "sa@x", private_key: "k" }),
    PORTUNI_GOOGLE_IMPERSONATE: "admin@workflow.ooo",
    PORTUNI_OAUTH_GOOGLE_CLIENT_ID: "oauth-client",
    PORTUNI_OAUTH_GOOGLE_CLIENT_SECRET: "oauth-secret",
    PORTUNI_PUBLIC_URL: "https://api.portuni.com",
  } as NodeJS.ProcessEnv);
  assert.notEqual(withOauthVars.interactiveLogin, undefined);
});
