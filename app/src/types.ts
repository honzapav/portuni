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
} from "../../src/api-types";

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
} from "../../src/popp";
export type {
  NodeType,
  EdgeRelation as RelationType,
} from "../../src/popp";
