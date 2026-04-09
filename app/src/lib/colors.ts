// Muted, consistent palette for node types.
// Values must match CSS vars in index.css so UI chips and graph dots agree.
// Node type set mirrors src/schema.ts NODE_TYPES.

export const NODE_COLORS: Record<string, string> = {
  organization: "#76d9ff",
  project: "#a78bfa",
  process: "#fbbf24",
  area: "#f472b6",
  principle: "#34d399",
};

export const DEFAULT_NODE_COLOR = "#94a3b8";

export function colorForType(type: string): string {
  return NODE_COLORS[type] ?? DEFAULT_NODE_COLOR;
}

// Order matters: drives the legend and the graph visual hierarchy.
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
