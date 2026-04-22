// src/tools/entity-attributes.ts
// Task D1: 6 MCP tools for data_sources and tools -- two sibling tables that
// attach per-entity attributes (where info comes from, what the entity uses
// to do work) to project/process/area nodes. Both tables share an identical
// shape, so the CRUD is parametrized over the table name and the Zod row
// parser is the same for both.
//
// Exports pure functions (first arg is the libsql Client so tests can drive
// against an in-memory DB) plus registerEntityAttributeTools() which wires
// the six MCP tool handlers using getDb() from the shared connection.

import { z } from "zod";
import { ulid } from "ulid";
import type { Client, InValue } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db.js";
import { SOLO_USER } from "../schema.js";
import { DataSourceRow, ToolRow } from "../types.js";

// --- Zod input schema (shared between data_sources and tools) ---

const AddEntityAttrInput = z.object({
  node_id: z.string().describe("Node ID (ULID). Must be a project/process/area."),
  name: z.string().describe("Short display name."),
  description: z.string().optional().describe("Optional detail."),
  external_link: z.string().optional().describe(
    "Optional plain URL or identifier. NEVER a connection string with credentials.",
  ),
});
type AddEntityAttrInput = z.infer<typeof AddEntityAttrInput>;

type EntityAttrTable = "data_sources" | "tools";

// --- Internal helpers ---

// Direct audit writer. The shared logAudit() helper hard-codes getDb(), so we
// re-implement the INSERT here so the pure functions stay pure (tests pass a
// fresh in-memory Client). Mirrors the pattern in src/tools/actors.ts and
// src/tools/responsibilities.ts.
async function writeAudit(
  db: Client,
  userId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [ulid(), userId, action, targetType, targetId, detail ? JSON.stringify(detail) : null],
  });
}

// Parametrized CRUD -- data_sources and tools are structurally identical, so
// each operation is implemented once against the table-name parameter.

async function addRow<T>(
  db: Client,
  createdBy: string,
  table: EntityAttrTable,
  input: AddEntityAttrInput,
  parser: (r: unknown) => T,
): Promise<T> {
  const parsed = AddEntityAttrInput.parse(input);
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO ${table} (id, node_id, name, description, external_link)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      id,
      parsed.node_id,
      parsed.name,
      parsed.description ?? null,
      parsed.external_link ?? null,
    ],
  });
  // target_type is the singular form of the table (drop trailing 's').
  await writeAudit(db, createdBy, `add_${table}`, table.slice(0, -1), id, {
    node_id: parsed.node_id,
    name: parsed.name,
  });
  const res = await db.execute({
    sql: `SELECT * FROM ${table} WHERE id = ?`,
    args: [id],
  });
  if (res.rows.length === 0) {
    throw new Error(`add_${table}: inserted row ${id} not found`);
  }
  return parser(res.rows[0]);
}

const UpdateEntityAttrInput = z.object({
  name: z.string().optional(),
  description: z.union([z.string(), z.null()]).optional(),
  external_link: z.union([z.string(), z.null()]).optional(),
});
type UpdateEntityAttrInput = z.infer<typeof UpdateEntityAttrInput>;

async function updateRow<T>(
  db: Client,
  updatedBy: string,
  table: EntityAttrTable,
  id: string,
  patch: UpdateEntityAttrInput,
  parser: (r: unknown) => T,
): Promise<T> {
  const parsed = UpdateEntityAttrInput.parse(patch);
  const sets: string[] = [];
  const args: InValue[] = [];
  if (parsed.name !== undefined) {
    sets.push("name = ?");
    args.push(parsed.name);
  }
  if (parsed.description !== undefined) {
    sets.push("description = ?");
    args.push(parsed.description);
  }
  if (parsed.external_link !== undefined) {
    sets.push("external_link = ?");
    args.push(parsed.external_link);
  }
  if (sets.length === 0) {
    const current = await db.execute({
      sql: `SELECT * FROM ${table} WHERE id = ?`,
      args: [id],
    });
    if (current.rows.length === 0) throw new Error(`update_${table}: ${id} not found`);
    return parser(current.rows[0]);
  }
  sets.push("updated_at = datetime('now')");
  args.push(id);
  const result = await db.execute({
    sql: `UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
  if (result.rowsAffected === 0) {
    throw new Error(`update_${table}: ${id} not found`);
  }
  await writeAudit(db, updatedBy, `update_${table}`, table.slice(0, -1), id, {
    changes: parsed,
  });
  const res = await db.execute({
    sql: `SELECT * FROM ${table} WHERE id = ?`,
    args: [id],
  });
  return parser(res.rows[0]);
}

async function removeRow(
  db: Client,
  removedBy: string,
  table: EntityAttrTable,
  id: string,
): Promise<void> {
  const existing = await db.execute({
    sql: `SELECT id, node_id, name FROM ${table} WHERE id = ?`,
    args: [id],
  });
  if (existing.rows.length === 0) {
    throw new Error(`remove_${table}: ${id} not found`);
  }
  await db.execute({
    sql: `DELETE FROM ${table} WHERE id = ?`,
    args: [id],
  });
  await writeAudit(db, removedBy, `remove_${table}`, table.slice(0, -1), id, {
    node_id: existing.rows[0].node_id as string,
    name: existing.rows[0].name as string,
  });
}

async function listRows<T>(
  db: Client,
  table: EntityAttrTable,
  nodeId: string,
  parser: (r: unknown) => T,
): Promise<T[]> {
  const res = await db.execute({
    sql: `SELECT * FROM ${table} WHERE node_id = ? ORDER BY name`,
    args: [nodeId],
  });
  return res.rows.map((r) => parser(r));
}

// --- Pure function wrappers (thin) ---

export async function addDataSource(
  db: Client,
  createdBy: string,
  input: AddEntityAttrInput,
): Promise<DataSourceRow> {
  return addRow(db, createdBy, "data_sources", input, (r) => DataSourceRow.parse(r));
}

export async function updateDataSource(
  db: Client,
  updatedBy: string,
  id: string,
  patch: UpdateEntityAttrInput,
): Promise<DataSourceRow> {
  return updateRow(db, updatedBy, "data_sources", id, patch, (r) =>
    DataSourceRow.parse(r),
  );
}

export async function removeDataSource(
  db: Client,
  removedBy: string,
  id: string,
): Promise<void> {
  await removeRow(db, removedBy, "data_sources", id);
}

export async function listDataSources(
  db: Client,
  nodeId: string,
): Promise<DataSourceRow[]> {
  return listRows(db, "data_sources", nodeId, (r) => DataSourceRow.parse(r));
}

export async function addTool(
  db: Client,
  createdBy: string,
  input: AddEntityAttrInput,
): Promise<ToolRow> {
  return addRow(db, createdBy, "tools", input, (r) => ToolRow.parse(r));
}

export async function updateTool(
  db: Client,
  updatedBy: string,
  id: string,
  patch: UpdateEntityAttrInput,
): Promise<ToolRow> {
  return updateRow(db, updatedBy, "tools", id, patch, (r) => ToolRow.parse(r));
}

export async function removeTool(
  db: Client,
  removedBy: string,
  id: string,
): Promise<void> {
  await removeRow(db, removedBy, "tools", id);
}

export async function listTools(
  db: Client,
  nodeId: string,
): Promise<ToolRow[]> {
  return listRows(db, "tools", nodeId, (r) => ToolRow.parse(r));
}

// --- MCP tool registration ---

export function registerEntityAttributeTools(server: McpServer): void {
  server.tool(
    "portuni_add_data_source",
    "Attach a **data source** (a place where the entity gets information: CRM, data warehouse, report, dashboard) to a project/process/area. external_link is a plain URL or identifier -- **NEVER a connection string with credentials**. ONLY create when the user explicitly asks.",
    {
      node_id: z.string().describe("Node ID (ULID). Must be a project/process/area."),
      name: z.string().describe("Short display name, e.g. 'CRM Airtable', 'Q3 revenue report'."),
      description: z.string().optional().describe("Optional detail."),
      external_link: z.string().optional().describe("Optional plain URL or identifier. NEVER credentials."),
    },
    async (args) => {
      try {
        const db = getDb();
        const row = await addDataSource(db, SOLO_USER, args);
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
        const db = getDb();
        await removeDataSource(db, SOLO_USER, args.data_source_id);
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
        const db = getDb();
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
    "Attach a **tool** (what the entity uses to do work: task manager, document editor, communication tool) to a project/process/area. external_link is a plain URL -- **NEVER credentials**. ONLY create when the user explicitly asks.",
    {
      node_id: z.string().describe("Node ID (ULID). Must be a project/process/area."),
      name: z.string().describe("Short display name, e.g. 'Asana', 'Figma', 'Slack'."),
      description: z.string().optional().describe("Optional detail."),
      external_link: z.string().optional().describe("Optional plain URL. NEVER credentials."),
    },
    async (args) => {
      try {
        const db = getDb();
        const row = await addTool(db, SOLO_USER, args);
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
        const db = getDb();
        await removeTool(db, SOLO_USER, args.tool_id);
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
        const db = getDb();
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
