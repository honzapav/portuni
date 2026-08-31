// Google OAuth + Workspace Groups identity adapter (spec §2).
// verify(): OIDC ID-token verification + allowed-domain gate.
// resolveAccess(): Admin SDK Directory API groups.list(userKey=email)
// through a DWD service account, mapped to a global role; cached 15 min.
// interactiveLogin: confidential-client authorization-code flow for the
// OAuth connector's upstream login step
// (docs/superpowers/specs/2026-08-31-oauth-connectors-design.md).

import { OAuth2Client, JWT } from "google-auth-library";
import type { AccessResolution, Identity, IdentityAdapter } from "./adapter.js";
import {
  groupRoleConfigFromEnv,
  resolveGlobalScope,
  type GroupRoleConfig,
} from "./roles.js";

const GROUP_CACHE_TTL_MS = 15 * 60 * 1000;
const ALL_GROUPS_CACHE_TTL_MS = 5 * 60 * 1000;

export interface GoogleIdTokenPayload {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  hd?: string;
}

export interface GoogleAdapterDeps {
  verifyIdToken: (idToken: string) => Promise<GoogleIdTokenPayload | null>;
  listGroups: (email: string) => Promise<Array<{ id: string; email: string }>>;
  listAllGroups: () => Promise<Array<{ id: string; email: string; name: string }>>;
  allowedDomains: string[];
  roleConfig: GroupRoleConfig;
  now?: () => number;
  // Confidential-client authorization-code flow for the OAuth connector's
  // upstream login step (spec "Adapter interface"). Absent when
  // PORTUNI_OAUTH_GOOGLE_CLIENT_ID/SECRET/PORTUNI_PUBLIC_URL aren't
  // configured -- the adapter then has no `interactiveLogin` capability and
  // the /oauth/* routes 404.
  interactiveLogin?: {
    redirectUrl: (state: string) => string;
    // Exchanges the authorization code server-side (client secret never
    // leaves the server) and returns the verified ID-token payload. Google
    // tokens themselves are discarded by the caller -- only the identity
    // claims survive.
    exchangeCode: (code: string) => Promise<GoogleIdTokenPayload | null>;
  };
}

export class GoogleAdapter implements IdentityAdapter {
  private readonly cache = new Map<string, { at: number; access: AccessResolution }>();
  private allGroupsCache: {
    fetchedAt: number;
    groups: Array<{ id: string; email: string; name: string }>;
  } | null = null;
  private allGroupsInFlight: Promise<Array<{ id: string; email: string; name: string }>> | null =
    null;
  private readonly now: () => number;

  private readonly allowedDomains: string[];

  readonly interactiveLogin?: IdentityAdapter["interactiveLogin"];

  constructor(private readonly deps: GoogleAdapterDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.allowedDomains = deps.allowedDomains.map((d) => d.trim().toLowerCase());
    if (deps.interactiveLogin) {
      const { redirectUrl, exchangeCode } = deps.interactiveLogin;
      this.interactiveLogin = {
        redirectUrl,
        handleCallback: async (params) => {
          const error = params.get("error");
          if (error) throw new Error(`Google OAuth error: ${error}`);
          const code = params.get("code");
          if (!code) throw new Error("Missing Google authorization code");
          const payload = await exchangeCode(code);
          const identity = this.assertAllowedIdentity(payload);
          return { identity, avatarUrl: payload?.picture ?? null };
        },
      };
    }
  }

  private assertAllowedIdentity(payload: GoogleIdTokenPayload | null): Identity {
    if (!payload) throw new Error("Invalid Google ID token");
    if (!payload.email_verified) throw new Error("Google email not verified");
    const domain = payload.email.split("@")[1]?.toLowerCase() ?? "";
    if (!this.allowedDomains.includes(domain)) {
      // External Google accounts are a future phase (spec: rozhodnutí
      // "Externí uživatelé"); for the team test only the org domain logs in.
      throw new Error(`Account domain '${domain}' is not allowed`);
    }
    return {
      email: payload.email.toLowerCase(),
      name: payload.name ?? payload.email,
      sub: payload.sub,
    };
  }

  async verify(credential: string): Promise<Identity> {
    const payload = await this.deps.verifyIdToken(credential);
    return this.assertAllowedIdentity(payload);
  }

  // Exposed so /auth/login can pass the avatar through to upsertUser.
  async verifyWithProfile(
    credential: string,
  ): Promise<{ identity: Identity; avatarUrl: string | null }> {
    const payload = await this.deps.verifyIdToken(credential);
    const identity = this.assertAllowedIdentity(payload);
    return { identity, avatarUrl: payload?.picture ?? null };
  }

  async resolveAccess(email: string): Promise<AccessResolution> {
    const key = email.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < GROUP_CACHE_TTL_MS) return hit.access;
    const list = await this.deps.listGroups(key);
    const groups = list.map((g) => g.email.toLowerCase());
    const access: AccessResolution = {
      globalScope: resolveGlobalScope(groups, this.deps.roleConfig),
      groups,
      groupIds: list.map((g) => g.id),
    };
    this.cache.set(key, { at: this.now(), access });
    return access;
  }

  // Domain groups picker for the sharing UI (GET /auth/groups). The full
  // directory listing is cached module-wide for 5 min -- callers filter
  // client-side (per keystroke) against the cached snapshot rather than
  // hitting the Directory API on every query.
  async listDomainGroups(
    query: string,
  ): Promise<Array<{ id: string; email: string; name: string }>> {
    const now = this.now();
    if (!this.allGroupsCache || now - this.allGroupsCache.fetchedAt >= ALL_GROUPS_CACHE_TTL_MS) {
      // Coalesce concurrent cache misses behind one in-flight fetch so a burst
      // of requests (e.g. sharing-UI keystrokes right after cache expiry)
      // doesn't fan out into N paginated Directory API calls. A rejection
      // must not poison the cache and must clear the slot so the next call
      // retries with a fresh fetch.
      if (!this.allGroupsInFlight) {
        this.allGroupsInFlight = this.deps.listAllGroups().finally(() => {
          this.allGroupsInFlight = null;
        });
      }
      const groups = await this.allGroupsInFlight;
      this.allGroupsCache = { fetchedAt: now, groups };
    }
    const q = query.toLowerCase().trim();
    return this.allGroupsCache.groups
      .filter((g) => g.email.includes(q) || g.name.toLowerCase().includes(q))
      .slice(0, 20);
  }
}

// Comma-separated, trim + lowercase, drop empties. PORTUNI_ALLOWED_DOMAINS
// (plural) is primary; PORTUNI_ALLOWED_DOMAIN (singular) is a legacy
// fallback used only when the plural var is unset.
export function parseAllowedDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PORTUNI_ALLOWED_DOMAINS ?? env.PORTUNI_ALLOWED_DOMAIN ?? "";
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

// Production wiring from env:
//   PORTUNI_GOOGLE_CLIENT_IDS   comma list of accepted OAuth client IDs
//   PORTUNI_ALLOWED_DOMAINS     comma list of allowed Workspace domains,
//                               e.g. workflow.ooo,tempo.ooo (singular
//                               PORTUNI_ALLOWED_DOMAIN still works as a
//                               fallback for a single domain)
//   PORTUNI_GOOGLE_SA_KEY_JSON  service-account key JSON (DWD-enabled)
//   PORTUNI_GOOGLE_IMPERSONATE  admin user the SA impersonates
//   PORTUNI_GROUPS_ADMIN/MANAGE/WRITE  group-email lists (roles.ts)
//   PORTUNI_OAUTH_GOOGLE_CLIENT_ID/SECRET + PORTUNI_PUBLIC_URL  optional,
//   enable the interactiveLogin capability (OAuth connector upstream
//   login); omitted -> no capability -> /oauth/* routes 404
export function createGoogleAdapter(env: NodeJS.ProcessEnv = process.env): GoogleAdapter {
  const clientIds = (env.PORTUNI_GOOGLE_CLIENT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (clientIds.length === 0) {
    throw new Error("PORTUNI_GOOGLE_CLIENT_IDS is required in google auth mode");
  }
  const allowedDomains = parseAllowedDomains(env);
  if (allowedDomains.length === 0) {
    throw new Error("PORTUNI_ALLOWED_DOMAINS is required in google auth mode");
  }
  const saJson = env.PORTUNI_GOOGLE_SA_KEY_JSON ?? "";
  const impersonate = env.PORTUNI_GOOGLE_IMPERSONATE ?? "";
  if (!saJson || !impersonate) {
    throw new Error(
      "PORTUNI_GOOGLE_SA_KEY_JSON and PORTUNI_GOOGLE_IMPERSONATE are required in google auth mode",
    );
  }
  const sa = JSON.parse(saJson) as { client_email: string; private_key: string };
  const oauth = new OAuth2Client();

  const directoryClient = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/admin.directory.group.readonly"],
    subject: impersonate,
  });

  const oauthClientId = env.PORTUNI_OAUTH_GOOGLE_CLIENT_ID ?? "";
  const oauthClientSecret = env.PORTUNI_OAUTH_GOOGLE_CLIENT_SECRET ?? "";
  const publicUrl = env.PORTUNI_PUBLIC_URL ?? "";
  const interactiveLogin =
    oauthClientId && oauthClientSecret && publicUrl
      ? buildInteractiveLogin({
          clientId: oauthClientId,
          clientSecret: oauthClientSecret,
          redirectUri: `${publicUrl.replace(/\/+$/, "")}/oauth/google/callback`,
        })
      : undefined;

  return new GoogleAdapter({
    verifyIdToken: async (idToken) => {
      const ticket = await oauth.verifyIdToken({ idToken, audience: clientIds });
      const p = ticket.getPayload();
      if (!p) return null;
      return {
        sub: p.sub,
        email: p.email ?? "",
        email_verified: p.email_verified ?? false,
        name: p.name,
        picture: p.picture,
        hd: p.hd,
      };
    },
    listGroups: async (email) => {
      const groups: Array<{ id: string; email: string }> = [];
      let pageToken: string | undefined;
      do {
        const url = new URL("https://admin.googleapis.com/admin/directory/v1/groups");
        url.searchParams.set("userKey", email);
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const res = await directoryClient.request<{
          groups?: Array<{ id: string; email: string }>;
          nextPageToken?: string;
        }>({ url: url.toString() });
        for (const g of res.data.groups ?? []) groups.push({ id: g.id, email: g.email });
        pageToken = res.data.nextPageToken;
      } while (pageToken);
      return groups;
    },
    listAllGroups: async () => {
      const groups: Array<{ id: string; email: string; name: string }> = [];
      let pageToken: string | undefined;
      do {
        const url = new URL("https://admin.googleapis.com/admin/directory/v1/groups");
        url.searchParams.set("customer", "my_customer");
        url.searchParams.set("maxResults", "200");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const res = await directoryClient.request<{
          groups?: Array<{ id: string; email: string; name?: string }>;
          nextPageToken?: string;
        }>({ url: url.toString() });
        for (const g of res.data.groups ?? [])
          groups.push({ id: g.id, email: g.email, name: g.name ?? g.email });
        pageToken = res.data.nextPageToken;
      } while (pageToken);
      return groups;
    },
    allowedDomains,
    roleConfig: groupRoleConfigFromEnv(env),
    interactiveLogin,
  });
}

const GOOGLE_LOGIN_SCOPES = ["openid", "email", "profile"];

// Confidential-client authorization-code flow: browser hop to Google
// (generateAuthUrl) and the server-side code exchange (getToken), scoped
// to identity claims only -- access_type stays "online" (default) because
// no Google refresh token is requested or stored (spec "Decisions").
function buildInteractiveLogin(config: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): NonNullable<GoogleAdapterDeps["interactiveLogin"]> {
  const client = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });
  return {
    redirectUrl: (state) =>
      client.generateAuthUrl({
        scope: GOOGLE_LOGIN_SCOPES,
        prompt: "select_account",
        state,
      }),
    exchangeCode: async (code) => {
      const { tokens } = await client.getToken(code);
      if (!tokens.id_token) return null;
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.clientId,
      });
      const p = ticket.getPayload();
      if (!p) return null;
      return {
        sub: p.sub,
        email: p.email ?? "",
        email_verified: p.email_verified ?? false,
        name: p.name,
        picture: p.picture,
        hd: p.hd,
      };
    },
  };
}
