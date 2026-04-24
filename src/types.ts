// src/types.ts -- Zod row schemas for all DB tables.
// Single source of truth for TypeScript types derived from DB shape.
// DDL lives in schema.ts; these schemas validate query results at runtime.

import { z } from "zod";

// --- Row schemas (what SELECT returns) ---

export const UserRow = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  created_at: z.string(),
});
export type UserRow = z.infer<typeof UserRow>;

export const NodeRow = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  description: z.union([z.string(), z.null()]),
  summary: z.union([z.string(), z.null()]),
  summary_updated_at: z.union([z.string(), z.null()]),
  meta: z.union([z.string(), z.null()]),
  status: z.string(),
  visibility: z.string(),
  pos_x: z.union([z.number(), z.null()]),
  pos_y: z.union([z.number(), z.null()]),
  owner_id: z.union([z.string(), z.null()]),
  lifecycle_state: z.union([z.string(), z.null()]),
  goal: z.union([z.string(), z.null()]),
  sync_key: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type NodeRow = z.infer<typeof NodeRow>;

export const EdgeRow = z.object({
  id: z.string(),
  source_id: z.string(),
  target_id: z.string(),
  relation: z.string(),
  meta: z.union([z.string(), z.null()]),
  created_by: z.string(),
  created_at: z.string(),
});
export type EdgeRow = z.infer<typeof EdgeRow>;

export const AuditLogRow = z.object({
  id: z.string(),
  user_id: z.string(),
  action: z.string(),
  target_type: z.string(),
  target_id: z.string(),
  detail: z.union([z.string(), z.null()]),
  timestamp: z.string(),
});
export type AuditLogRow = z.infer<typeof AuditLogRow>;

export const LocalMirrorRow = z.object({
  user_id: z.string(),
  node_id: z.string(),
  local_path: z.string(),
  registered_at: z.string(),
});
export type LocalMirrorRow = z.infer<typeof LocalMirrorRow>;

// FileRow validates rows returned from `SELECT * FROM files`. There is NO
// `local_path` column on the table -- migration 012 dropped it. The path on
// the current device is derived at read time from the per-device mirror +
// remote_path + sync_key (see api-types.ts DetailFile.local_path).
export const FileRow = z.object({
  id: z.string(),
  node_id: z.string(),
  filename: z.string(),
  status: z.string(),
  description: z.union([z.string(), z.null()]),
  mime_type: z.union([z.string(), z.null()]),
  remote_name: z.union([z.string(), z.null()]),
  remote_path: z.union([z.string(), z.null()]),
  current_remote_hash: z.union([z.string(), z.null()]),
  last_pushed_by: z.union([z.string(), z.null()]),
  last_pushed_at: z.union([z.string(), z.null()]),
  is_native_format: z.number(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type FileRow = z.infer<typeof FileRow>;

export const EventRow = z.object({
  id: z.string(),
  node_id: z.string(),
  type: z.string(),
  content: z.string(),
  meta: z.union([z.string(), z.null()]),
  status: z.string(),
  refs: z.union([z.string(), z.null()]),
  task_ref: z.union([z.string(), z.null()]),
  created_by: z.string(),
  created_at: z.string(),
});
export type EventRow = z.infer<typeof EventRow>;

// --- Partial row schemas for SELECT subsets ---

export const NodeSummaryRow = NodeRow.pick({
  id: true,
  type: true,
  name: true,
  status: true,
  description: true,
});
export type NodeSummaryRow = z.infer<typeof NodeSummaryRow>;

export const NodeIdRow = NodeRow.pick({ id: true });
export type NodeIdRow = z.infer<typeof NodeIdRow>;

export const ActorRow = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  is_placeholder: z.number(), // SQLite BOOLEAN stored as 0/1
  user_id: z.union([z.string(), z.null()]),
  notes: z.union([z.string(), z.null()]),
  external_id: z.union([z.string(), z.null()]),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ActorRow = z.infer<typeof ActorRow>;

export const ResponsibilityRow = z.object({
  id: z.string(),
  node_id: z.string(),
  title: z.string(),
  description: z.union([z.string(), z.null()]),
  sort_order: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ResponsibilityRow = z.infer<typeof ResponsibilityRow>;

export const ResponsibilityAssignmentRow = z.object({
  responsibility_id: z.string(),
  actor_id: z.string(),
  created_at: z.string(),
});
export type ResponsibilityAssignmentRow = z.infer<typeof ResponsibilityAssignmentRow>;

export const DataSourceRow = z.object({
  id: z.string(),
  node_id: z.string(),
  name: z.string(),
  description: z.union([z.string(), z.null()]),
  external_link: z.union([z.string(), z.null()]),
  created_at: z.string(),
  updated_at: z.string(),
});
export type DataSourceRow = z.infer<typeof DataSourceRow>;

export const ToolRow = DataSourceRow; // same columns, aliased for intent
export type ToolRow = z.infer<typeof ToolRow>;
