// Domain: data_sources and tools — two sibling tables that attach
// per-entity attributes (where info comes from, what the entity uses to
// do work) to project/process/area nodes. Both tables share an identical
// shape; the CRUD is parametrized over the table name.

import { z } from "zod";
import { ulid } from "ulid";
import type { Client, InValue } from "@libsql/client";
import { DataSourceRow, ToolRow } from "../shared/types.js";
import { isSafeExternalLink } from "../shared/safe-url.js";

export const ExternalLinkSchema = z
  .string()
  .optional()
  .refine(
    (v) => v === undefined || v === "" || isSafeExternalLink(v),
    {
      message:
        "external_link must be empty or an http://, https://, or mailto: URL (no javascript:, data:, file:, ...)",
    },
  );

export const AddEntityAttrInput = z.object({
  node_id: z.string().describe("Node ID (ULID). Must be a project/process/area."),
  name: z.string().describe("Short display name."),
  description: z.string().optional().describe("Optional detail."),
  external_link: ExternalLinkSchema.describe(
    "Optional plain URL (http/https/mailto only). NEVER a connection string with credentials.",
  ),
});
export type AddEntityAttrInput = z.infer<typeof AddEntityAttrInput>;

type EntityAttrTable = "data_sources" | "tools";

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

export const UpdateEntityAttrInput = z.object({
  name: z.string().optional(),
  description: z.union([z.string(), z.null()]).optional(),
  external_link: z
    .union([z.string(), z.null()])
    .optional()
    .refine(
      (v) => v === undefined || v === null || v === "" || isSafeExternalLink(v),
      {
        message:
          "external_link must be empty/null or an http://, https://, or mailto: URL",
      },
    ),
});
export type UpdateEntityAttrInput = z.infer<typeof UpdateEntityAttrInput>;

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
