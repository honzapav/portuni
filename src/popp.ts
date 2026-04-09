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
