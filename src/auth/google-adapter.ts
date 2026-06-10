// Google OAuth + Workspace Groups identity adapter (spec §2).
// verify(): OIDC ID-token verification + allowed-domain gate.
// resolveAccess(): Admin SDK Directory API groups.list(userKey=email)
// through a DWD service account, mapped to a global role; cached 15 min.

import { OAuth2Client, JWT } from "google-auth-library";
import type { AccessResolution, Identity, IdentityAdapter } from "./adapter.js";
import {
  groupRoleConfigFromEnv,
  resolveGlobalScope,
  type GroupRoleConfig,
} from "./roles.js";

const GROUP_CACHE_TTL_MS = 15 * 60 * 1000;

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
  listGroups: (email: string) => Promise<string[]>;
  allowedDomain: string;
  roleConfig: GroupRoleConfig;
  now?: () => number;
}

export class GoogleAdapter implements IdentityAdapter {
  private readonly cache = new Map<string, { at: number; access: AccessResolution }>();
  private readonly now: () => number;

  constructor(private readonly deps: GoogleAdapterDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private assertAllowedIdentity(payload: GoogleIdTokenPayload | null): Identity {
    if (!payload) throw new Error("Invalid Google ID token");
    if (!payload.email_verified) throw new Error("Google email not verified");
    const domain = payload.email.split("@")[1]?.toLowerCase() ?? "";
    if (domain !== this.deps.allowedDomain.toLowerCase()) {
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
    const groups = (await this.deps.listGroups(key)).map((g) => g.toLowerCase());
    const access: AccessResolution = {
      globalScope: resolveGlobalScope(groups, this.deps.roleConfig),
      groups,
    };
    this.cache.set(key, { at: this.now(), access });
    return access;
  }
}

// Production wiring from env:
//   PORTUNI_GOOGLE_CLIENT_IDS   comma list of accepted OAuth client IDs
//   PORTUNI_ALLOWED_DOMAIN      e.g. workflow.ooo
//   PORTUNI_GOOGLE_SA_KEY_JSON  service-account key JSON (DWD-enabled)
//   PORTUNI_GOOGLE_IMPERSONATE  admin user the SA impersonates
//   PORTUNI_GROUPS_ADMIN/MANAGE/WRITE  group-email lists (roles.ts)
export function createGoogleAdapter(env: NodeJS.ProcessEnv = process.env): GoogleAdapter {
  const clientIds = (env.PORTUNI_GOOGLE_CLIENT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (clientIds.length === 0) {
    throw new Error("PORTUNI_GOOGLE_CLIENT_IDS is required in google auth mode");
  }
  const allowedDomain = env.PORTUNI_ALLOWED_DOMAIN ?? "";
  if (!allowedDomain) {
    throw new Error("PORTUNI_ALLOWED_DOMAIN is required in google auth mode");
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
      const groups: string[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL("https://admin.googleapis.com/admin/directory/v1/groups");
        url.searchParams.set("userKey", email);
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const res = await directoryClient.request<{
          groups?: Array<{ email: string }>;
          nextPageToken?: string;
        }>({ url: url.toString() });
        for (const g of res.data.groups ?? []) groups.push(g.email);
        pageToken = res.data.nextPageToken;
      } while (pageToken);
      return groups;
    },
    allowedDomain,
    roleConfig: groupRoleConfigFromEnv(env),
  });
}
