import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../infra/db.js";
import type { SessionCtx } from "../server.js";
import {
  setupRemoteService,
  setRoutingPolicyService,
  listRemotesService,
  type SetupRemoteArgs,
  type RemoteListing,
} from "../../domain/sync/remote-service.js";

export {
  setupRemoteService,
  setRoutingPolicyService,
  listRemotesService,
  type SetupRemoteArgs,
  type RemoteListing,
};

export function registerSyncRemoteTools(server: McpServer, ctx: SessionCtx): void {
  server.tool(
    "portuni_setup_remote",
    "Create or update a named remote (fs, gdrive, dropbox, s3, webdav, sftp). Use when the user is configuring a sync backend. For gdrive, pass service_account_json — other types ignore it.",
    {
      name: z.string().min(1),
      type: z.enum(["fs", "gdrive", "dropbox", "s3", "webdav", "sftp"]),
      config: z.record(z.string(), z.unknown()),
      service_account_json: z.string().optional(),
    },
    async (args) => {
      const db = getDb();
      await setupRemoteService(db, {
        userId: ctx.identity.userId,
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
    "Replace the entire remote_routing table with a new list of rules — every existing rule that is not in the new list is deleted. Use only when the user explicitly asks to overwrite the routing policy.",
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
    "List all configured remotes with their auth status on this device. Use when answering 'which remotes are set up?' or before setting a routing policy.",
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
