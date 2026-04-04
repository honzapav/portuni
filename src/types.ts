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
  meta: z.union([z.string(), z.null()]),
  status: z.string(),
  visibility: z.string(),
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

export const FileRow = z.object({
  id: z.string(),
  node_id: z.string(),
  filename: z.string(),
  local_path: z.union([z.string(), z.null()]),
  status: z.string(),
  description: z.union([z.string(), z.null()]),
  mime_type: z.union([z.string(), z.null()]),
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
