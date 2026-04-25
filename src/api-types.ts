// src/api-types.ts -- Shared REST response shapes used by both the
// backend (src/server.ts loadGraph / loadNodeDetail) and the frontend
// (app/src/types.ts re-exports these).
//
// This file is deliberately pure type definitions and has no runtime
// dependencies, so it can be imported across the project boundary the
// same way src/popp.ts is.
//
// Changing any shape here is an API contract change: both the server
// handlers and the frontend consumers must be updated.

import type { NodeType, EdgeRelation } from "./popp.js";

// -- Graph (list) endpoint --------------------------------------------

export type GraphNode = {
  id: string;
  type: NodeType | string; // NodeType at runtime, widened for safety
  name: string;
  description: string | null;
  status: string;
  lifecycle_state: string | null;
  // Persisted layout. Null means "no saved position yet" -- the frontend
  // will compute one on first layout and POST it back via /positions.
  // Only leaf (non-organization) nodes actually persist here; org
  // positions are derived by cytoscape from their children's bounding
  // box, so there's nothing to store for them.
  pos_x: number | null;
  pos_y: number | null;
};

export type GraphEdge = {
  id: string;
  source_id: string;
  target_id: string;
  relation: EdgeRelation | string;
};

export type GraphPayload = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

// -- Node detail endpoint ---------------------------------------------

export type DetailEdge = {
  id: string;
  relation: EdgeRelation | string;
  direction: "outgoing" | "incoming";
  peer_id: string;
  peer_name: string;
  peer_type: NodeType | string;
};

export type DetailFile = {
  id: string;
  filename: string;
  status: string;
  description: string | null;
  // Derived field. The `files` table no longer stores a local path
  // (migration 012). The server resolves this on read by combining the
  // per-device mirror root with the file's remote_path + node sync_key.
  // Null when the node has no mirror on this device or remote_path is
  // unset (e.g. legacy file rows that pre-date the file-sync foundation).
  local_path: string | null;
  mime_type: string | null;
};

// Per-file sync state classified by the engine's statusScan. Untracked
// discovery results (new_local / new_remote) are intentionally omitted
// here -- the UI tab listing is built from tracked `files` rows, so a
// flat lookup keyed by file_id is what the frontend needs.
export type SyncClass =
  | "clean"
  | "push"
  | "pull"
  | "conflict"
  | "orphan"
  | "native";

export type SyncStatusFile = {
  file_id: string;
  sync_class: SyncClass;
  local_hash: string | null;
  remote_hash: string | null;
  last_synced_hash: string | null;
  local_path: string | null;
  remote_name: string | null;
  remote_path: string | null;
};

export type SyncStatusResponse = {
  files: SyncStatusFile[];
};

export type DetailEvent = {
  id: string;
  type: string;
  content: string;
  status: string;
  created_at: string;
  meta?: unknown;
  refs?: unknown;
  task_ref?: string | null;
};

export type LocalMirror = {
  local_path: string;
  registered_at: string;
} | null;

export type DetailOwner = {
  id: string;
  name: string;
};

export type DetailResponsibilityAssignee = {
  id: string;
  name: string;
  type: string;
};

export type DetailResponsibility = {
  id: string;
  title: string;
  description: string | null;
  sort_order: number;
  assignees: DetailResponsibilityAssignee[];
};

export type DetailDataSource = {
  id: string;
  name: string;
  description: string | null;
  external_link: string | null;
};

export type DetailTool = {
  id: string;
  name: string;
  description: string | null;
  external_link: string | null;
};

export type NodeDetail = {
  id: string;
  type: NodeType | string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  created_at: string;
  updated_at: string;
  edges: DetailEdge[];
  files: DetailFile[];
  events: DetailEvent[];
  local_mirror: LocalMirror;
  meta?: unknown;
  owner: DetailOwner | null;
  responsibilities: DetailResponsibility[];
  data_sources: DetailDataSource[];
  tools: DetailTool[];
  goal: string | null;
  lifecycle_state: string | null;
};
