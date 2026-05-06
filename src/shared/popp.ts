// src/popp.ts -- Single source of truth for the canonical POPP schema.
//
// This file is deliberately minimal: pure constants, zero runtime imports.
// It is imported by both the backend (src/schema.ts and tools) and the
// frontend graph viewer (app/src/types.ts) via a relative path. Keeping it
// free of dependencies is what makes cross-project sharing safe -- adding
// any import here (libsql, fs, etc.) would break the frontend build.
//
// Changing the sets below is a schema change. It must be accompanied by:
//   1. A migration that updates the CHECK constraints in sqlite_master
//   2. A data cleanup for any existing rows that would violate the new set
//   3. Updates to the edge/relation tables in docs-site and docs/specs.md

// Canonical POPP node types. The five entities that capture all work.
export const NODE_TYPES = [
  "organization",
  "project",
  "process",
  "area",
  "principle",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

// Canonical edge relations. Flat, non-hierarchical. No edge type is
// privileged. Any node can connect to any other node. When unsure which
// relation fits, use related_to -- it is the near-default lateral link,
// not a fallback.
export const EDGE_RELATIONS = [
  "related_to",
  "belongs_to",
  "applies",
  "informed_by",
] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

// Canonical event types. Time-ordered knowledge attached to nodes.
export const EVENT_TYPES = [
  "decision",
  "discovery",
  "blocker",
  "reference",
  "milestone",
  "note",
  "change",
] as const;

// Canonical node statuses.
export const NODE_STATUSES = ["active", "completed", "archived"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

// Canonical node visibilities. "group" is planned but not yet implemented.
//
// IMPORTANT — visibility is currently a UI/metadata hint, NOT an access
// control list. Phase 1 has no per-user identity (all routes share a
// single bearer token, all data belongs to SOLO_USER), so there is no
// "other user" to hide a private node from. The graph and detail
// queries do not filter on this column. Treat `private` as a label
// meaning "I do not want this in shared exports", not as a security
// guarantee. Real ACL enforcement is gated on multi-user auth.
export const NODE_VISIBILITIES = ["team", "private"] as const;

// Canonical event statuses.
export const EVENT_STATUSES = [
  "active",
  "resolved",
  "superseded",
  "archived",
] as const;

// Canonical file statuses.
export const FILE_STATUSES = ["wip", "output"] as const;

// Lifecycle states per node type. Primary, visible, color-coded status.
// The coarse `status` column (active/completed/archived) is derived from
// lifecycle_state by a DB trigger; do not set status directly in new code.
export const LIFECYCLE_STATES_BY_TYPE = {
  organization: ["active", "inactive", "archived"],
  area: ["active", "needs_attention", "inactive", "archived"],
  process: ["not_implemented", "implementing", "operating", "at_risk", "broken", "retired"],
  project: ["backlog", "planned", "in_progress", "on_hold", "done", "cancelled"],
  principle: ["active", "archived"],
} as const satisfies Record<NodeType, readonly string[]>;

export function getLifecycleStatesForType(type: NodeType): readonly string[] {
  return LIFECYCLE_STATES_BY_TYPE[type];
}

// Mapping from lifecycle_state to coarse status. Used by DB trigger and
// frontend when computing status without a DB round-trip.
const LIFECYCLE_TO_STATUS: Record<string, NodeStatus> = {
  done: "completed",
  archived: "archived",
  retired: "archived",
  cancelled: "archived",
  inactive: "archived",
};

export function deriveStatusFromLifecycle(
  _type: NodeType,
  lifecycle: string,
): NodeStatus {
  return LIFECYCLE_TO_STATUS[lifecycle] ?? "active";
}

export const STATUS_FROM_LIFECYCLE = LIFECYCLE_TO_STATUS;

// Per-type terminal lifecycle state used when archiving. Each type has
// its own canonical "this node is done" lifecycle value (process →
// retired, project → cancelled, the rest → archived). Setting status
// directly to "archived" would leave lifecycle_state stale, so a later
// lifecycle change could flip the node back to active. Setting the
// lifecycle here lets the DB trigger derive status correctly.
export const ARCHIVE_LIFECYCLE_BY_TYPE: Record<NodeType, string> = {
  organization: "archived",
  area: "archived",
  process: "retired",
  project: "cancelled",
  principle: "archived",
};
