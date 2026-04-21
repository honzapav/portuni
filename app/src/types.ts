// REST API response shapes are now shared with the backend via
// src/api-types.ts. Re-exporting here keeps frontend imports stable.
export type {
  GraphNode,
  GraphEdge,
  GraphPayload,
  DetailEdge,
  DetailFile,
  DetailEvent,
  LocalMirror,
  NodeDetail,
  DetailOwner,
  DetailResponsibility,
  DetailResponsibilityAssignee,
  DetailDataSource,
  DetailTool,
} from "../../src/api-types";

// Lifecycle state -> UI color bucket. Mirrors the color policy documented
// in docs/superpowers/specs/2026-04-21-people-responsibilities-design.md
// section 3.4. Any state not listed falls through to "gray".
export const LIFECYCLE_COLORS: Record<string, "green" | "yellow" | "red" | "gray"> = {
  // green: live, operational, moving forward
  active: "green",
  operating: "green",
  in_progress: "green",
  done: "green",
  // yellow: warning, waiting, in flux
  needs_attention: "yellow",
  at_risk: "yellow",
  on_hold: "yellow",
  implementing: "yellow",
  // red: broken, cancelled (actionable negative)
  broken: "red",
  cancelled: "red",
  // gray: dormant, done-but-archived, not started
  inactive: "gray",
  archived: "gray",
  retired: "gray",
  backlog: "gray",
  planned: "gray",
  not_implemented: "gray",
};

// Canonical POPP schema -- single source of truth lives in src/popp.ts at
// the repo root and is shared between backend and this frontend via a
// relative import. Do NOT redefine these constants here. If a new node
// type or edge relation is needed, add it to src/popp.ts and both sides
// will stay in sync automatically.
//
// RELATION_TYPES is the frontend's name for EDGE_RELATIONS (historical
// naming kept to avoid churning every import site). It is the exact same
// tuple.
export {
  NODE_TYPES,
  EDGE_RELATIONS as RELATION_TYPES,
  EVENT_TYPES,
  LIFECYCLE_STATES_BY_TYPE,
} from "../../src/popp";
export type {
  NodeType,
  EdgeRelation as RelationType,
} from "../../src/popp";
