// Grouping rules for the node search palette (NodeCommandPalette). Pure, so
// the ordering and the "only group a long list" threshold are testable from
// the server's own node:test runner (test/node-search-helpers.test.ts).

import { compareText } from "./format";

// Czech labels for the five POPP node types, same wording as
// CreateNodeModal/OverviewView.
export const NODE_TYPE_LABELS: Record<string, string> = {
  organization: "Organizace",
  area: "Oblast",
  project: "Projekt",
  process: "Proces",
  principle: "Princip",
};

// Fixed display order of the groups, independent of how the results happen
// to be sorted: organization, area, project, process, principle. A node of
// some other type lands in a trailing group keyed by its own raw type.
export const NODE_TYPE_ORDER = [
  "organization",
  "area",
  "project",
  "process",
  "principle",
] as const;

// Above this many rows the flat list is hard to scan, so it is grouped by
// node type; at or below it, one flat list stays simpler.
export const GROUP_THRESHOLD = 8;

export type NodeTypeGroup<T> = { type: string; label: string; nodes: T[] };

export function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABELS[type] ?? type;
}

// `null` means "render one flat list": either the result set is short enough
// or everything in it shares a single type, where headings add nothing.
export function groupNodesByType<T extends { type: string }>(
  nodes: T[],
  locale: string,
): NodeTypeGroup<T>[] | null {
  if (nodes.length <= GROUP_THRESHOLD) return null;
  const buckets = new Map<string, T[]>();
  for (const n of nodes) {
    const bucket = buckets.get(n.type);
    if (bucket) bucket.push(n);
    else buckets.set(n.type, [n]);
  }
  if (buckets.size < 2) return null;
  const known = NODE_TYPE_ORDER.filter((t) => buckets.has(t));
  const unknown = [...buckets.keys()]
    .filter((t) => !NODE_TYPE_ORDER.includes(t as (typeof NODE_TYPE_ORDER)[number]))
    .sort((a, b) => compareText(locale, a, b));
  return [...known, ...unknown].map((type) => ({
    type,
    label: nodeTypeLabel(type),
    nodes: buckets.get(type)!,
  }));
}
