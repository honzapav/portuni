// Order matters: drives the legend and the graph visual hierarchy.
// Per-type colors live in theme.ts (see ThemeColors.nodeColors).
export const TYPE_ORDER = [
  "organization",
  "project",
  "process",
  "area",
  "principle",
];

// Visual hint only -- belongs_to is rendered as a slightly more prominent
// line because it typically scopes an entity to an organization. This is a
// rendering convenience, not an ontological claim: per the graph-not-tree
// principle, no edge type is actually privileged.
export const STRUCTURAL_RELATIONS = new Set(["belongs_to"]);
