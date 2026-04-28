// MCP tool registrations for data_sources and tools. Logic lives in
// src/domain/entity-attributes.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../infra/db.js";
import { SOLO_USER } from "../../infra/schema.js";
import {
  ExternalLinkSchema,
  addDataSource,
  addTool,
  listDataSources,
  listTools,
  removeDataSource,
  removeTool,
} from "../../domain/entity-attributes.js";

export function registerEntityAttributeTools(server: McpServer): void {
  server.tool(
    "portuni_add_data_source",
    "Attach a **data source** (a place where the entity gets information: CRM, data warehouse, report, dashboard) to a project/process/area. external_link is a plain URL or identifier -- **NEVER a connection string with credentials**. ONLY create when the user explicitly asks.",
    {
      node_id: z.string().describe("Node ID (ULID). Must be a project/process/area."),
      name: z.string().describe("Short display name, e.g. 'CRM Airtable', 'Q3 revenue report'."),
      description: z.string().optional().describe("Optional detail."),
      external_link: ExternalLinkSchema.describe("Optional plain URL (http/https/mailto only). NEVER credentials."),
    },
    async (args) => {
      try {
        const row = await addDataSource(getDb(), SOLO_USER, args);
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
    "Remove a data source from its entity. Hard delete -- the row is physically removed. Use only when the user explicitly asks.",
    {
      data_source_id: z.string().describe("Data source ID (ULID) to remove."),
    },
    async (args) => {
      try {
        await removeDataSource(getDb(), SOLO_USER, args.data_source_id);
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
    "List all data sources attached to a given project/process/area node.",
    {
      node_id: z.string().describe("Node ID (ULID) whose data sources to list."),
    },
    async (args) => {
      try {
        const rows = await listDataSources(getDb(), args.node_id);
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
    "Attach a **tool** (what the entity uses to do work: task manager, document editor, communication tool) to a project/process/area. external_link is a plain URL -- **NEVER credentials**. ONLY create when the user explicitly asks.",
    {
      node_id: z.string().describe("Node ID (ULID). Must be a project/process/area."),
      name: z.string().describe("Short display name, e.g. 'Asana', 'Figma', 'Slack'."),
      description: z.string().optional().describe("Optional detail."),
      external_link: ExternalLinkSchema.describe("Optional plain URL (http/https/mailto only). NEVER credentials."),
    },
    async (args) => {
      try {
        const row = await addTool(getDb(), SOLO_USER, args);
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
    "Remove a tool from its entity. Hard delete -- the row is physically removed. Use only when the user explicitly asks.",
    {
      tool_id: z.string().describe("Tool ID (ULID) to remove."),
    },
    async (args) => {
      try {
        await removeTool(getDb(), SOLO_USER, args.tool_id);
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
    "List all tools attached to a given project/process/area node.",
    {
      node_id: z.string().describe("Node ID (ULID) whose tools to list."),
    },
    async (args) => {
      try {
        const rows = await listTools(getDb(), args.node_id);
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
