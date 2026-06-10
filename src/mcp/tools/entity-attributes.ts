// MCP tool registrations for data_sources and tools. Logic lives in
// src/domain/entity-attributes.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@libsql/client";
import { getDb } from "../../infra/db.js";
import {
  ExternalLinkSchema,
  addDataSource,
  addTool,
  listDataSources,
  listTools,
  removeDataSource,
  removeTool,
} from "../../domain/entity-attributes.js";
import { nodeVisibleTo } from "../../auth/node-access.js";
import type { SessionCtx } from "../server.js";

async function guardNodeAccess(
  db: Client,
  nodeId: string,
  identity: SessionCtx["identity"],
): Promise<{ allowed: true } | { allowed: false; error: string }> {
  if (!(await nodeVisibleTo(db, identity, nodeId))) {
    return { allowed: false, error: `Error: node ${nodeId} not found` };
  }
  return { allowed: true };
}

export function registerEntityAttributeTools(server: McpServer, ctx: SessionCtx): void {
  server.tool(
    "portuni_add_data_source",
    "Attach a data source (where the entity gets information: CRM, data warehouse, report, dashboard) to a project/process/area. Create only when the user explicitly asks. The name and description should identify what the source is, not duplicate live state from it (row counts, last refresh, current values) — Portuni does not auto-sync, so any such state goes stale.",
    {
      node_id: z.string().describe("Node ID (ULID). Must be a project/process/area."),
      name: z.string().describe("Short display name, e.g. 'CRM Airtable', 'Q3 revenue report'."),
      description: z.string().optional().describe("Optional detail."),
      external_link: ExternalLinkSchema.describe("Optional plain URL (http/https/mailto only). No credentials in the URL — they would land in audit logs."),
    },
    async (args) => {
      try {
        const db = getDb();
        const guard = await guardNodeAccess(db, args.node_id, ctx.identity);
        if (!guard.allowed) {
          return {
            content: [{ type: "text" as const, text: guard.error }],
            isError: true,
          };
        }
        const row = await addDataSource(db, ctx.identity.userId, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(row) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "portuni_remove_data_source",
    "Remove a data source from its entity. Hard delete — the row is physically removed. Use only when the user explicitly asks.",
    {
      data_source_id: z.string().describe("Data source ID (ULID) to remove."),
    },
    async (args) => {
      try {
        await removeDataSource(getDb(), ctx.identity.userId, args.data_source_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ id: args.data_source_id, action: "removed" }) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "portuni_list_data_sources",
    "List all data sources attached to a given project/process/area node. Use to surface what a node reads from before adding more or answering 'where does this come from?'.",
    {
      node_id: z.string().describe("Node ID (ULID) whose data sources to list."),
    },
    async (args) => {
      try {
        const db = getDb();
        if (!(await nodeVisibleTo(db, ctx.identity, args.node_id))) {
          return {
            content: [{ type: "text" as const, text: `Error: node ${args.node_id} not found` }],
            isError: true,
          };
        }
        const rows = await listDataSources(db, args.node_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "portuni_add_tool",
    "Attach a tool (what the entity uses to do work: task manager, document editor, communication tool) to a project/process/area. Create only when the user explicitly asks. The name and description should identify what the tool/link is (e.g. 'Asana board for project X', 'Workflow BIS project record'), not duplicate live state from the linked system (status, stage, counts, assigned people, dates) — Portuni does not auto-sync, so any such state goes stale.",
    {
      node_id: z.string().describe("Node ID (ULID). Must be a project/process/area."),
      name: z.string().describe("Short display name, e.g. 'Asana', 'Figma', 'Slack'. Identifies what it is, not live state from the linked system."),
      description: z.string().optional().describe("Optional detail — identify what the linked resource is. Skip live state (status, stage, counts, assignees, dates); it would go stale."),
      external_link: ExternalLinkSchema.describe("Optional plain URL (http/https/mailto only). No credentials in the URL — they would land in audit logs."),
    },
    async (args) => {
      try {
        const db = getDb();
        const guard = await guardNodeAccess(db, args.node_id, ctx.identity);
        if (!guard.allowed) {
          return {
            content: [{ type: "text" as const, text: guard.error }],
            isError: true,
          };
        }
        const row = await addTool(db, ctx.identity.userId, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(row) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "portuni_remove_tool",
    "Remove a tool from its entity. Hard delete — the row is physically removed. Use only when the user explicitly asks.",
    {
      tool_id: z.string().describe("Tool ID (ULID) to remove."),
    },
    async (args) => {
      try {
        await removeTool(getDb(), ctx.identity.userId, args.tool_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ id: args.tool_id, action: "removed" }) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "portuni_list_tools",
    "List all tools attached to a given project/process/area node. Use to surface what a node works with before adding more or answering 'where does this work happen?'.",
    {
      node_id: z.string().describe("Node ID (ULID) whose tools to list."),
    },
    async (args) => {
      try {
        const db = getDb();
        if (!(await nodeVisibleTo(db, ctx.identity, args.node_id))) {
          return {
            content: [{ type: "text" as const, text: `Error: node ${args.node_id} not found` }],
            isError: true,
          };
        }
        const rows = await listTools(db, args.node_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
