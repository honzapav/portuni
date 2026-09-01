// REST API response shapes are now shared with the backend via
// src/api-types.ts. Re-exporting here keeps frontend imports stable.
export type {
  GraphNode,
  GraphPayload,
  DetailEdge,
  DetailFile,
  DetailEvent,
  NodeDetail,
  NodeMirrorResponse,
  DetailResponsibility,
  DetailDataSource,
  DetailTool,
  SyncClass,
  SyncStatusFile,
  SyncStatusResponse,
  SyncRunResponse,
  SyncPendingResponse,
  UntrackedFile,
  FileContentResponse,
  NodeAccessEntry,
  NodeAccessResponse,
  AccessRequest,
  AccessRequestStatus,
  DirectoryGroup,
  AccountUser,
  UserAdmin,
  SessionState,
  SessionSummary,
  SessionResumeInfo,
} from "../../server/shared/api-types";

// Request-only shape for PUT /nodes/:id/access -- not a server response, so
// it doesn't live in the shared api-types.ts (that file documents response
// shapes only). Mirrors the zod union in apps/server/api/access.ts exactly.
export type NodeAccessEntryInput =
  | { kind: "group"; principal: string; display_email: string }
  | { kind: "user"; principal: string };

// Lifecycle state -> UI color bucket. Any state not listed falls through to "gray".
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

// Canonical POPP schema -- single source of truth lives in
// apps/server/shared/popp.ts and is shared between backend and this frontend
// via a relative import. Do NOT redefine these constants here. If a new node
// type or edge relation is needed, add it to apps/server/shared/popp.ts and
// both sides will stay in sync automatically.
//
// RELATION_TYPES is the frontend's name for EDGE_RELATIONS (historical
// naming kept to avoid churning every import site). It is the exact same
// tuple.
export {
  EDGE_RELATIONS as RELATION_TYPES,
  EVENT_TYPES,
  LIFECYCLE_STATES_BY_TYPE,
  NODE_VISIBILITIES,
  HEALTH_STATES,
} from "../../server/shared/popp";

// Project health -> UI color bucket. Every value maps to a color (no "gray
// unset" case -- health always has a value, default 'on_track').
export const HEALTH_COLORS: Record<string, "green" | "yellow" | "red"> = {
  on_track: "green",
  at_risk: "yellow",
  off_track: "red",
};
