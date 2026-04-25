import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@libsql/client";
import { getDb } from "../db.js";
import { SOLO_USER } from "../schema.js";
import {
  upsertRemote,
  listRemotes,
  replaceRules,
  type RoutingRule,
} from "../sync/routing.js";
import { readDeviceTokens } from "../sync/device-tokens.js";
import { invalidateAdapter } from "../sync/adapter-cache.js";

export interface SetupRemoteArgs {
  userId: string;
  name: string;
  type: "fs" | "gdrive" | "dropbox" | "s3" | "webdav" | "sftp";
  config: Record<string, unknown>;
  service_account_json?: string;
}

export async function setupRemoteService(db: Client, a: SetupRemoteArgs): Promise<void> {
  if (a.type === "fs") {
    if (typeof a.config.root !== "string") {
      throw new Error("fs remote requires config.root as a string");
    }
  }
  if (a.type === "gdrive") {
    const { parseDriveConfig, parseServiceAccountJson } = await import("../sync/drive-config.js");
    parseDriveConfig(a.config);
    if (!a.service_account_json) {
      throw new Error("gdrive remote requires service_account_json");
    }
    parseServiceAccountJson(a.service_account_json);
    const { getTokenStore } = await import("../sync/token-store.js");
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

export function registerSyncRemoteTools(server: McpServer): void {
  server.tool(
    "portuni_setup_remote",
    "Create or update a named remote (fs, gdrive, dropbox, s3, webdav, sftp). For gdrive, pass service_account_json.",
    {
      name: z.string().min(1),
      type: z.enum(["fs", "gdrive", "dropbox", "s3", "webdav", "sftp"]),
      config: z.record(z.string(), z.unknown()),
      service_account_json: z.string().optional(),
    },
    async (args) => {
      const db = getDb();
      await setupRemoteService(db, {
        userId: SOLO_USER,
        name: args.name,
        type: args.type,
        config: args.config,
        service_account_json: args.service_account_json,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ name: args.name, type: args.type }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_set_routing_policy",
    "Replace the full remote_routing table with a new list of rules. Admin tool.",
    {
      rules: z.array(
        z.object({
          priority: z.number().int(),
          node_type: z.string().nullable(),
          org_slug: z.string().nullable(),
          remote_name: z.string(),
        }),
      ),
    },
    async (args) => {
      const db = getDb();
      await setRoutingPolicyService(db, args.rules);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: args.rules.length }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_list_remotes",
    "List all configured remotes with their auth status on this device.",
    {},
    async () => {
      const db = getDb();
      const r = await listRemotesService(db);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }],
      };
    },
  );
}
