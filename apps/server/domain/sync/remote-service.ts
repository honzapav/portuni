import type { Client } from "@libsql/client";
import { assertRemoteCapable } from "./types.js";
import { upsertRemote, listRemotes, replaceRules, type RoutingRule } from "./routing.js";
import { readDeviceTokens } from "./device-tokens.js";
import { invalidateAdapter } from "./adapter-cache.js";

export interface SetupRemoteArgs {
  userId: string;
  name: string;
  type: "fs" | "gdrive" | "dropbox" | "s3" | "webdav" | "sftp";
  config: Record<string, unknown>;
  service_account_json?: string;
}

export async function setupRemoteService(db: Client, a: SetupRemoteArgs): Promise<void> {
  // Fail before any side effect (e.g. the token-store write below) rather
  // than relying solely on upsertRemote's own guard further down.
  assertRemoteCapable();
  if (a.type === "fs") {
    if (typeof a.config.root !== "string") {
      throw new Error("fs remote requires config.root as a string");
    }
  }
  if (a.type === "gdrive") {
    const { parseDriveConfig, parseServiceAccountJson, assertSaDriveConfig } = await import("./drive-config.js");
    // Service accounts have no My Drive quota -- fail setup fast rather than
    // waiting for the first sync to discover this via the adapter.
    assertSaDriveConfig(parseDriveConfig(a.config));
    if (!a.service_account_json) {
      throw new Error("gdrive remote requires service_account_json");
    }
    parseServiceAccountJson(a.service_account_json);
    const { getTokenStore } = await import("./token-store.js");
    const store = await getTokenStore();
    await store.write(a.name, {
      mode: "service_account",
      service_account_json: a.service_account_json,
    });
  }
  await upsertRemote(db, {
    name: a.name,
    type: a.type,
    config: a.config,
    created_by: a.userId,
  });
  // Drop cached adapter so the next request rebuilds with fresh config/tokens.
  invalidateAdapter(a.name);
}

export async function setRoutingPolicyService(
  db: Client,
  rules: RoutingRule[],
): Promise<void> {
  assertRemoteCapable();
  await replaceRules(db, rules);
}

export interface RemoteListing {
  name: string;
  type: string;
  authenticated: boolean;
}

export async function listRemotesService(db: Client): Promise<RemoteListing[]> {
  const remotes = await listRemotes(db);
  const tokens = await readDeviceTokens(remotes.map((r) => r.name));
  return remotes.map((r) => ({
    name: r.name,
    type: r.type,
    authenticated: (() => {
      if (r.type === "fs") return true;
      const t = tokens[r.name];
      if (!t) return false;
      if (r.type === "gdrive") return Boolean(t.service_account_json);
      return Boolean(t.refresh_token);
    })(),
  }));
}
