import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import cytoscape from "cytoscape";
import { LayoutGrid, Shuffle } from "lucide-react";
import type {
  Core,
  EdgeCollection,
  EdgeSingular,
  NodeCollection,
  NodeSingular,
} from "cytoscape";
// @ts-expect-error — fcose has no first-party types
import fcose from "cytoscape-fcose";
import type { GraphPayload, GraphNode } from "../types";
import { STRUCTURAL_RELATIONS } from "../lib/colors";
import type { Theme, ThemeColors } from "../lib/theme";
import { THEMES } from "../lib/theme";
import { savePositions } from "../api";
import { foldForSearch } from "../lib/normalize";

cytoscape.use(fcose);

type Props = {
  graph: GraphPayload;
  selectedId: string | null;
  query: string;
  disabledRelations: Set<string>;
  disabledOrgs: Set<string>;
  disabledTypes: Set<string>;
  disabledStatuses: Set<string>;
  theme: Theme;
  onSelect: (id: string | null) => void;
  // Triggered by the empty-state CTA. Always pre-selects "organization"
  // since that's the only top-level node type a fresh user can create.
  onCreateOrganization: () => void;
};

// Build cytoscape elements with orgs as compound parents.
// Any node with a `belongs_to` edge pointing at an organization becomes a child
// of that org's compound node; everything else floats freely between clusters.
const MIN_NODE_SIZE = 18;
const MAX_NODE_SIZE = 44;

// Each organization gets a deterministic colour from this palette so its
// nebula stays the same across renders and reloads. Soft jewel tones —
// not the same hues as the leaf-node type colours, so a violet "project"
// inside an amber org reads as a contrast rather than a clash.
const NEBULA_HUES = [
  "#a78bfa", // violet
  "#60a5fa", // cerulean
  "#fbbf24", // amber
  "#fb7185", // coral
  "#2dd4bf", // teal
  "#c084fc", // lavender
  "#fdba74", // peach
  "#67e8f9", // cyan
  "#f0abfc", // orchid
  "#6ee7b7", // mint
];

function fnv1aHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function colorForOrg(id: string): string {
  return NEBULA_HUES[fnv1aHash(id) % NEBULA_HUES.length];
}

// Org ids come from the backend as slugs/uuids. SVG ids must start with
// a letter or underscore and only contain a restricted character set,
// so prefix and scrub anything risky before using one as a fragment id.
function safeSvgId(s: string): string {
  return "n_" + s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// "Jan Pavl" -> "JP". Single-word names take their first two letters.
// Diacritics are kept as-is — uppercase Czech letters render fine in
// the pip; stripping them risks collisions ("Štěpán" and "Šimon" both
// becoming "S").
function ownerInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return parts[0].slice(0, 2).toUpperCase();
}

// Pattern overlays for lifecycle state. Cytoscape rasterises these
// via Image() on first paint and uses the SVG's *natural* pixel size
// to position the bg image. We set explicit width/height attributes
// on every SVG (not just viewBox) so the natural size is well-defined,
// and we drive the lifecycle rules with `background-width: 100%` /
// `background-height: 100%` plus centred position so the overlay
// always fills the disc, regardless of the disc's rendered size.
//
// Without explicit width/height, browsers fall back to their default
// SVG box (often 300x150), which causes the pattern to render at the
// wrong size and shift to a corner of the node bounding box.
const PATTERN_BOX = 120;

const HATCH_OVERLAY_URI =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PATTERN_BOX}" height="${PATTERN_BOX}" viewBox="0 0 ${PATTERN_BOX} ${PATTERN_BOX}">` +
      `<defs>` +
      `<pattern id="h" width="11" height="11" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<line x1="0" y1="0" x2="0" y2="11" stroke="#0a0b0d" stroke-width="4.6"/>` +
      `</pattern>` +
      `</defs>` +
      `<rect width="${PATTERN_BOX}" height="${PATTERN_BOX}" fill="url(#h)" opacity="0.6"/>` +
      `</svg>`,
  );

const STRIKE_OVERLAY_URI =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PATTERN_BOX}" height="${PATTERN_BOX}" viewBox="0 0 ${PATTERN_BOX} ${PATTERN_BOX}">` +
      `<line x1="28" y1="28" x2="92" y2="92" stroke="#f87171" stroke-width="14" stroke-linecap="round"/>` +
      `<line x1="92" y1="28" x2="28" y2="92" stroke="#f87171" stroke-width="14" stroke-linecap="round"/>` +
      `</svg>`,
  );

// Evenly-spaced dark dots for `implementing` -- "in the works but not
// yet running". Sits over the type-coloured disc.
const DOT_OVERLAY_URI =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PATTERN_BOX}" height="${PATTERN_BOX}" viewBox="0 0 ${PATTERN_BOX} ${PATTERN_BOX}">` +
      `<defs>` +
      `<pattern id="dt" width="14" height="14" patternUnits="userSpaceOnUse">` +
      `<circle cx="7" cy="7" r="3" fill="#0a0b0d"/>` +
      `</pattern>` +
      `</defs>` +
      `<rect width="${PATTERN_BOX}" height="${PATTERN_BOX}" fill="url(#dt)" opacity="0.78"/>` +
      `</svg>`,
  );

// Bold checkmark for `done`. Centred in the viewBox so a centred,
// scaled-to-fill bg-image lands the check in the middle of the disc.
const CHECK_OVERLAY_URI =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PATTERN_BOX}" height="${PATTERN_BOX}" viewBox="0 0 ${PATTERN_BOX} ${PATTERN_BOX}">` +
      `<path d="M 36 64 L 52 80 L 84 42" fill="none" stroke="#0a0b0d" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`,
  );

// Half-fill mask for project/in_progress. The disc's own
// `background-color` paints the entire ellipse type-coloured; this
// overlay then covers the BOTTOM half with the page background colour,
// which Cytoscape's ellipse mask clips to a semicircle. The result:
// only the top half reads as filled, the bottom reads as empty
// (matching the design dictionary). Built per-theme since the bottom
// half must equal the canvas bg.
function buildHalfFillUri(bgColor: string): string {
  return (
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${PATTERN_BOX}" height="${PATTERN_BOX}" viewBox="0 0 ${PATTERN_BOX} ${PATTERN_BOX}">` +
        `<rect x="0" y="${PATTERN_BOX / 2}" width="${PATTERN_BOX}" height="${PATTERN_BOX / 2}" fill="${bgColor}"/>` +
        `</svg>`,
    )
  );
}

function buildElements(graph: GraphPayload): cytoscape.ElementDefinition[] {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const parentOfChild = new Map<string, string>();

  for (const edge of graph.edges) {
    if (edge.relation !== "belongs_to") continue;
    const target = nodesById.get(edge.target_id);
    if (!target || target.type !== "organization") continue;
    if (!parentOfChild.has(edge.source_id)) {
      parentOfChild.set(edge.source_id, edge.target_id);
    }
  }

  // Per-org child count drives label placement: orgs with 0–1 children
  // can't carry a centred watermark label without overlapping the lone
  // child, so we float their label above the galaxy instead.
  const childCount = new Map<string, number>();
  for (const parentId of parentOfChild.values()) {
    childCount.set(parentId, (childCount.get(parentId) ?? 0) + 1);
  }

  // Degree = count of edges touching this node. Orgs are excluded from the
  // scale because they're compound parents, not leaf nodes. belongs_to edges
  // that get compounded out are NOT counted (they're visually represented by
  // parenting, not lines).
  const degree = new Map<string, number>();
  for (const n of graph.nodes) degree.set(n.id, 0);
  for (const edge of graph.edges) {
    const target = nodesById.get(edge.target_id);
    const isCompounded =
      edge.relation === "belongs_to" && target?.type === "organization";
    if (isCompounded) continue;
    degree.set(edge.source_id, (degree.get(edge.source_id) ?? 0) + 1);
    degree.set(edge.target_id, (degree.get(edge.target_id) ?? 0) + 1);
  }

  let maxLeafDegree = 0;
  for (const n of graph.nodes) {
    if (n.type === "organization") continue;
    maxLeafDegree = Math.max(maxLeafDegree, degree.get(n.id) ?? 0);
  }
  if (maxLeafDegree === 0) maxLeafDegree = 1;

  const sizeFor = (d: number): number => {
    const t = d / maxLeafDegree;
    return MIN_NODE_SIZE + t * (MAX_NODE_SIZE - MIN_NODE_SIZE);
  };

  const elements: cytoscape.ElementDefinition[] = [];

  for (const node of graph.nodes) {
    const d = degree.get(node.id) ?? 0;
    const data: Record<string, unknown> = {
      id: node.id,
      label: node.name,
      type: node.type,
      description: node.description ?? "",
      status: node.status,
      lifecycle_state: node.lifecycle_state ?? "",
      owner_id: node.owner?.id ?? "",
      owner_name: node.owner?.name ?? "",
      owner_initials: node.owner ? ownerInitials(node.owner.name) : "",
      degree: d,
      size: node.type === "organization" ? 0 : sizeFor(d),
      childCount:
        node.type === "organization" ? (childCount.get(node.id) ?? 0) : 0,
    };
    const parent = parentOfChild.get(node.id);
    if (parent) data.parent = parent;
    // Attach persisted position if the backend has one. The `preset`
    // layout will pick these up without any physics run; if positions
    // are missing we fall through to fcose in the data effect.
    const el: cytoscape.ElementDefinition = { data };
    if (
      typeof node.pos_x === "number" &&
      typeof node.pos_y === "number"
    ) {
      el.position = { x: node.pos_x, y: node.pos_y };
    }
    // Orgs are never directly grabbable in cytoscape -- the only drag
    // handle is the SVG label overlay (see GraphView JSX). Leaving the
    // body `pannable` means clicking and dragging on the empty galaxy
    // pans the canvas, which is what the user expects for empty space.
    if (node.type === "organization") {
      el.grabbable = false;
      el.pannable = true;
    }
    elements.push(el);
  }

  for (const edge of graph.edges) {
    const structural = STRUCTURAL_RELATIONS.has(edge.relation);
    // Hide belongs_to edges that are represented by compound parenting to
    // avoid visual noise. Keep belongs_to edges for non-org targets.
    const target = nodesById.get(edge.target_id);
    const isCompounded =
      edge.relation === "belongs_to" && target?.type === "organization";
    if (isCompounded) continue;
    elements.push({
      data: {
        id: edge.id,
        source: edge.source_id,
        target: edge.target_id,
        relation: edge.relation,
        structural: structural ? "1" : "0",
      },
    });
  }

  return elements;
}

function stylesheet(theme: ThemeColors): cytoscape.StylesheetJson {
  const nodeColor = (ele: NodeSingular) =>
    theme.nodeColors[ele.data("type") as string] ?? theme.nodeColorDefault;
  const halfFillUri = buildHalfFillUri(theme.bg);

  return [
    // Compound parents (organizations). The body of the rectangle is hidden;
    // an SVG overlay (see GraphView JSX) paints a soft galaxy-like cloud
    // around each org — a radial gradient with no hard edge — so orgs read
    // as gravitational groupings rather than bordered containers, even
    // though cytoscape's compound layout still uses an axis-aligned
    // rectangle internally for hit-testing and child positioning.
    // padding stays FIXED so the compound parent never refits.
    {
      selector: 'node[type = "organization"]',
      style: {
        shape: "roundrectangle",
        "background-opacity": 0,
        "border-width": 0,
        "border-opacity": 0,
        "border-style": "solid",
        // Cytoscape's native org label is hidden -- a DOM/SVG overlay
        // (see GraphView JSX) renders the label instead so it can act
        // as the *only* drag handle for the org. Empty `label` prevents
        // hit-testing on the label region too, and `text-opacity: 0`
        // belt-and-braces hides anything cytoscape might still draw.
        label: "",
        "text-opacity": 0,
        "font-family": "Inter, sans-serif",
        // Cytoscape renders compound parents BEFORE their children, so
        // the org body sits behind the leaf nodes -- the SVG nebula
        // overlay carries the visible "galaxy" effect.
        "z-index": 0,
        padding: "12px",
        "min-width": "120px",
        "min-height": "60px",
        "transition-property": "border-opacity, background-opacity",
        "transition-duration": 120,
      },
    },
    // Leaf nodes. Dimensions, border-width, text-max-width, and text-* are
    // all FIXED. Hover is gone entirely. Selected changes only color
    // properties, nothing that affects rendered bounds.
    {
      selector: "node[type != 'organization']",
      style: {
        shape: "ellipse",
        "background-color": nodeColor,
        "background-opacity": 0.9,
        "border-color": nodeColor,
        "border-width": 1,
        "border-opacity": 1,
        label: "data(label)",
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": 6,
        color: theme.text,
        "font-size": 13,
        "font-weight": 500,
        "font-family": "Inter, sans-serif",
        "text-wrap": "wrap",
        "text-max-width": "110px",
        "text-background-color": theme.bg,
        "text-background-opacity": theme.labelBgOpacity,
        "text-background-padding": "3px",
        "text-background-shape": "roundrectangle",
        width: "data(size)",
        height: "data(size)",
        "text-opacity": 1,
      },
    },
    // Edges
    {
      selector: "edge",
      style: {
        "curve-style": "bezier",
        "line-color": theme.edgeBase,
        "target-arrow-color": theme.edgeBase,
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.9,
        width: 1.2,
        opacity: 0.75,
        "transition-property": "opacity, line-color",
        "transition-duration": 150,
      },
    },
    {
      selector: "edge[structural = '1']",
      style: {
        "line-color": theme.edgeStructural,
        "target-arrow-color": theme.edgeStructural,
        width: 1.8,
        opacity: 0.9,
      },
    },
    {
      selector: "edge[relation = 'related_to']",
      style: {
        "line-style": "dotted",
      },
    },
    {
      selector: "edge[relation = 'applies'], edge[relation = 'informed_by']",
      style: {
        "line-style": "dashed",
      },
    },
    // Suppress the default cytoscape tap overlay.
    {
      selector: "node:active",
      style: { "overlay-opacity": 0 },
    },
    // Lifecycle dictionary. Every state from the design proposal
    // (docs/design/graph-node-design.html) gets a distinct silhouette
    // or pattern; type colour stays the encoder of *what* the node is,
    // lifecycle encodes *how it's going*. Order matters in cytoscape
    // -- later rules win on conflicting properties for matching nodes.
    //
    // HOLLOW: backlog (project) -- empty type-coloured ring.
    {
      selector: "node[lifecycle_state = 'backlog'][type != 'organization']",
      style: {
        "background-opacity": 0,
        "border-width": 2.5,
      },
    },
    // DASHED-COLOURED: planned, inactive, not_implemented -- dashed
    // type-coloured ring, no fill. "Drawn but not yet built."
    {
      selector:
        "node[lifecycle_state = 'planned'][type != 'organization']," +
        "node[lifecycle_state = 'inactive'][type != 'organization']," +
        "node[lifecycle_state = 'not_implemented'][type != 'organization']",
      style: {
        "background-opacity": 0,
        "border-width": 2,
        "border-style": "dashed",
      },
    },
    // DASHED-GRAY: on_hold -- explicitly *paused*, not in-progress; gray
    // dashed ring deliberately drops type colour to read as inert.
    {
      selector: "node[lifecycle_state = 'on_hold'][type != 'organization']",
      style: {
        "background-opacity": 0,
        "border-width": 2,
        "border-style": "dashed",
        "border-color": theme.textMuted,
      },
    },
    // HALF-FILL: in_progress (project) -- top half of the disc keeps
    // its type colour, bottom half is masked by the bg-coloured
    // overlay. The thin border traces the full ellipse.
    {
      selector:
        "node[lifecycle_state = 'in_progress'][type != 'organization']",
      style: {
        "background-image": halfFillUri,
        "background-fit": "cover",
        "background-image-opacity": 1,
        "background-width": "100%",
        "background-height": "100%",
        "background-position-x": "50%",
        "background-position-y": "50%",
        "background-clip": "node",
        "border-width": 1.5,
      },
    },
    // CHECK: done (project) -- solid disc with bold checkmark overlay.
    {
      selector: "node[lifecycle_state = 'done'][type != 'organization']",
      style: {
        "background-image": CHECK_OVERLAY_URI,
        "background-fit": "cover",
        "background-image-opacity": 1,
        "background-width": "100%",
        "background-height": "100%",
        "background-position-x": "50%",
        "background-position-y": "50%",
        "background-clip": "node",
      },
    },
    // DOT: implementing (process) -- solid disc + dotted overlay.
    {
      selector:
        "node[lifecycle_state = 'implementing'][type != 'organization']",
      style: {
        "background-image": DOT_OVERLAY_URI,
        "background-fit": "cover",
        "background-image-opacity": 1,
        "background-width": "100%",
        "background-height": "100%",
        "background-position-x": "50%",
        "background-position-y": "50%",
        "background-clip": "node",
      },
    },
    // HATCH: at_risk (process), needs_attention (area) -- diagonal hatch.
    {
      selector:
        "node[lifecycle_state = 'at_risk'][type != 'organization']," +
        "node[lifecycle_state = 'needs_attention'][type != 'organization']",
      style: {
        "background-image": HATCH_OVERLAY_URI,
        "background-fit": "cover",
        "background-image-opacity": 1,
        "background-width": "100%",
        "background-height": "100%",
        "background-position-x": "50%",
        "background-position-y": "50%",
        "background-clip": "node",
      },
    },
    // STRIKE: broken (process) -- red X over the disc plus red border.
    {
      selector: "node[lifecycle_state = 'broken'][type != 'organization']",
      style: {
        "background-image": STRIKE_OVERLAY_URI,
        "background-fit": "cover",
        "background-image-opacity": 1,
        "background-width": "100%",
        "background-height": "100%",
        "background-position-x": "50%",
        "background-position-y": "50%",
        "background-clip": "node",
        "border-color": "#f87171",
        "border-width": 1.5,
      },
    },
    // FADED: archived, retired, cancelled -- terminal states that should
    // recede visually so the live graph stands out.
    {
      selector:
        "node[lifecycle_state = 'archived'][type != 'organization']," +
        "node[lifecycle_state = 'retired'][type != 'organization']," +
        "node[lifecycle_state = 'cancelled'][type != 'organization']",
      style: {
        "background-opacity": 0.35,
        "border-opacity": 0.35,
        "text-opacity": 0.55,
      },
    },
    // Selected wins over lifecycle signaling.
    {
      selector: "node.selected[type != 'organization']",
      style: {
        "background-color": theme.accent,
        "border-color": theme.accent,
      },
    },
    {
      selector: "node.selected[type = 'organization']",
      style: {
        "border-color": theme.accent,
        "border-opacity": 0.9,
      },
    },
    // Soft-dim: 1st-level neighbours of a search match. Still readable,
    // but clearly secondary to the matched node.
    {
      selector: "node.dim-soft",
      style: {
        "background-opacity": 0.45,
        "border-opacity": 0.5,
        "text-opacity": 0.55,
      },
    },
    {
      selector: "edge.dim-soft",
      style: {
        opacity: 0.35,
      },
    },
    // Dimmed (non-match of search/filter). Applied after dim-soft so the
    // stronger dim wins when an element qualifies for both.
    {
      selector: "node.dim",
      style: {
        "background-opacity": 0.12,
        "border-opacity": 0.15,
        "text-opacity": 0.1,
      },
    },
    {
      selector: "edge.dim",
      style: {
        opacity: 0.08,
      },
    },
    // Filter-driven hide: nodes/edges removed by org / type / status /
    // relation filters disappear entirely. Search-driven dimming uses
    // `dim` / `dim-soft` above so matches stay legible in context.
    {
      selector: "node.hidden, edge.hidden",
      style: { display: "none" },
    },
    {
      selector: "edge.highlight",
      style: {
        "line-color": theme.accent,
        "target-arrow-color": theme.accent,
        width: 2,
        opacity: 0.9,
      },
    },
  ];
}

// Pick a sensible spawn location for a freshly arrived node. Uses the
// centroid of whatever neighbours are already laid out in cytoscape, so
// new nodes appear next to the cluster they belong to instead of
// teleporting to (0,0). A small jitter prevents stacking when several
// new nodes share the same neighbourhood. Falls back to the viewport
// centre when the node has no laid-out neighbours yet.
function placeNewNode(
  cy: Core,
  nodeId: string,
  nodeType: string,
  graph: GraphPayload,
): { x: number; y: number } {
  const neighbourIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.source_id === nodeId) neighbourIds.add(edge.target_id);
    if (edge.target_id === nodeId) neighbourIds.add(edge.source_id);
  }

  const positions: { x: number; y: number }[] = [];
  for (const nid of neighbourIds) {
    const n = cy.getElementById(nid);
    if (n.length === 0) continue;
    // Orgs are compound parents; their position is their bbox centre,
    // which for our purposes is as good an anchor as any leaf would be.
    const p = n.position();
    positions.push({ x: p.x, y: p.y });
  }

  if (positions.length > 0) {
    const sx = positions.reduce((a, p) => a + p.x, 0) / positions.length;
    const sy = positions.reduce((a, p) => a + p.y, 0) / positions.length;
    // Jitter so two new siblings don't land at exactly the same point.
    // 80px is roughly one leaf-node radius so they're visibly distinct
    // without flying out of the parent cluster.
    return {
      x: sx + (Math.random() - 0.5) * 80,
      y: sy + (Math.random() - 0.5) * 80,
    };
  }

  // No neighbours in the graph yet -- drop at the current viewport
  // centre so the user notices the node. Organization nodes are
  // compound parents so their "position" will be rederived from
  // children anyway; we still return something for the cy.add() call.
  void nodeType;
  const extent = cy.extent();
  return {
    x: (extent.x1 + extent.x2) / 2,
    y: (extent.y1 + extent.y2) / 2,
  };
}

// First-load layout strategy. If every leaf already has a persisted
// position we use cytoscape's `preset` layout which reads the position
// off each element without running any physics -- instant, no jump,
// pixel-perfect restore. Otherwise we fall back to fcose, pinning
// whatever positioned leaves we do have via fixedNodeConstraint so
// returning users don't see their anchored nodes move. After the layout
// After layout, push overlapping organization bounding boxes apart.
// fcose has no inter-compound repulsion, so we fix overlaps in a
// simple iterative pass: for each pair of orgs that overlap, shift
// them apart along the vector between their centers.
// Pick a sensible spawn position for a leaf that has just been
// reparented into the given org. Lands the leaf at the centroid of
// the org's existing siblings (so it visually joins the cluster) plus
// a small jitter so it doesn't land on top of another sibling. Falls
// back to the org's own position when the org has no children yet.
function placeNodeInOrg(
  cy: Core,
  orgId: string,
): { x: number; y: number } {
  const org = cy.getElementById(orgId);
  if (org.length === 0) {
    const ext = cy.extent();
    return { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 };
  }
  const children = org.children();
  if (children.length === 0) {
    const p = org.position();
    return { x: p.x, y: p.y };
  }
  let sx = 0;
  let sy = 0;
  children.forEach((c) => {
    const p = c.position();
    sx += p.x;
    sy += p.y;
  });
  const cx = sx / children.length;
  const cy0 = sy / children.length;
  // 80px of jitter is roughly one leaf radius -- enough to avoid
  // landing on another node, small enough to stay within the cluster.
  return {
    x: cx + (Math.random() - 0.5) * 80,
    y: cy0 + (Math.random() - 0.5) * 80,
  };
}

function shiftOrgChildren(org: NodeSingular, dx: number, dy: number): void {
  const children = org.children();
  if (children.length === 0) {
    // Empty org: shift the org node itself (it has a position as a childless compound).
    org.shift({ x: dx, y: dy });
  } else {
    children.forEach((child) => {
      child.shift({ x: dx, y: dy });
    });
  }
}

// Robust fit: guarantees nothing ends up outside the viewport after
// the initial layout settles. Failure modes this guards against:
//   1) Compound parents recompute their bbox lazily after style
//      mutations (we call expandOrgsToCircleSquares which sets
//      min-width/min-height on every org). A fit() called immediately
//      after may read stale bboxes and leave orgs poking outside.
//   2) The cytoscape container size at cy-init time can differ from
//      the final flex-computed size (detail pane mounting, font
//      loading, ResizeObserver's first-skip). cy.resize() resyncs.
//   3) Hidden elements (status-filtered, search-dimmed with display:
//      none) report bbox = (0,0,0,0). cy.fit() with default selector
//      includes them, so the fit bbox spans from (0,0) to wherever
//      the visible cluster sits — leaving the visible cluster mostly
//      offscreen. Fit only `:visible` to avoid this.
//   4) Persisted positions can spread beyond what minZoom allows the
//      camera to zoom out to. Without lowering minZoom, fit() snaps
//      to the camera's hard limit and silently leaves nodes outside.
//      We lower minZoom dynamically to whatever the visible bbox
//      actually requires (with headroom), so fit can always succeed.
function fitAllInView(cy: Core, padding: number): void {
  const doFit = () => {
    cy.resize();
    const visible = cy.elements(":visible");
    if (visible.length === 0) {
      cy.fit(undefined, padding);
      return;
    }
    const bb = visible.boundingBox({});
    const availW = Math.max(cy.width() - 2 * padding, 50);
    const availH = Math.max(cy.height() - 2 * padding, 50);
    const requiredZoom = Math.min(
      availW / Math.max(bb.w, 1),
      availH / Math.max(bb.h, 1),
    );
    // Headroom (×0.9) so the user can still pinch-zoom out a touch
    // beyond the initial fit before hitting the floor.
    if (requiredZoom < cy.minZoom()) {
      cy.minZoom(Math.max(requiredZoom * 0.9, 0.01));
    }
    cy.fit(visible, padding);
  };
  doFit();
  requestAnimationFrame(() => {
    doFit();
    requestAnimationFrame(doFit);
  });
}

// Animate to fit a collection, but cap the resulting zoom so tiny
// clusters (a single match with one neighbour) don't slam into
// maxZoom and leave the user staring at two huge dots. Uses
// center + explicit zoom rather than cytoscape's native `fit`,
// which ignores custom caps and only respects core min/maxZoom.
function animateFit(
  cy: Core,
  eles: NodeCollection,
  padding: number,
  maxZoom: number,
  duration: number,
): void {
  if (eles.length === 0) return;
  const bb = eles.boundingBox({});
  const availW = Math.max(cy.width() - 2 * padding, 50);
  const availH = Math.max(cy.height() - 2 * padding, 50);
  const zoomX = availW / Math.max(bb.w, 50);
  const zoomY = availH / Math.max(bb.h, 50);
  const zoom = Math.min(Math.min(zoomX, zoomY), maxZoom);
  cy.animate(
    { zoom, center: { eles } },
    { duration, easing: "ease-in-out-cubic" },
  );
}

// Zoom in on a single node and pin it to the centre of the viewport.
// Picks a zoom that comfortably frames the node + its 1st-level
// neighbours (so the user sees context), but the camera centre stays
// on the clicked node itself rather than the cluster's geometric
// centre -- otherwise an asymmetric neighbourhood drags the node
// visibly off-centre. Capped at `maxZoom` so isolated nodes (no
// neighbours, tiny bbox) don't slam into core maxZoom.
function focusOnNode(
  cy: Core,
  node: NodeSingular,
  padding: number,
  maxZoom: number,
  duration: number,
): void {
  const cluster = node.union(node.neighborhood().nodes());
  const bb = cluster.boundingBox({});
  const availW = Math.max(cy.width() - 2 * padding, 50);
  const availH = Math.max(cy.height() - 2 * padding, 50);
  const zoomX = availW / Math.max(bb.w, 50);
  const zoomY = availH / Math.max(bb.h, 50);
  const zoom = Math.min(Math.min(zoomX, zoomY), maxZoom);
  cy.animate(
    { zoom, center: { eles: node } },
    { duration, easing: "ease-in-out-cubic" },
  );
}

// Expand each organization's compound-parent body into a square that
// CIRCUMSCRIBES its children's bounding box. The SVG overlay then draws a
// circle INSCRIBED in that square (radius = side/2 = sqrt(w²+h²)/2 of the
// children's bbox), so:
//   - the visible circle still contains every child of the org,
//   - the cytoscape rectangle drag-area covers the same circle area, so
//     the user can grab the org anywhere inside the visible circle, and
//   - the rectangle-based non-overlap pass keeps circles apart too.
function expandOrgsToCircleSquares(cy: Core): void {
  cy.nodes().forEach((n) => {
    if (n.data("type") !== "organization") return;
    const children = n.children();
    if (children.length === 0) return;
    // Include child labels so min-w/h is big enough to dominate all the
    // natural sizing factors (children + their labels + padding); without
    // this, the parent's body comes out a few px taller than wide and the
    // inscribed-circle radius (= half the SHORTER side) ends up smaller
    // than half the longer side, leaving the top/bottom labels poking out.
    const bb = children.boundingBox({});
    // Floor on the radius keeps single-child orgs (Nautie, Evoluce) from
    // collapsing to a circle so small that the child's label hangs out.
    const r = Math.max(Math.sqrt(bb.w * bb.w + bb.h * bb.h) / 2 + 4, 56);
    const side = 2 * r;
    n.style({ "min-width": side, "min-height": side });
  });
}

// Pull same-type leaf nodes within each org closer to the centroid of
// their type group. fcose treats every node-pair the same so siblings
// of one type can end up scattered between siblings of another type;
// this post-process pass shrinks each type-group towards its own
// centroid by a fixed fraction (the rest of the spread is preserved
// so the org doesn't collapse to overlapping points). Only orgs with
// >=3 children and >=2 distinct types benefit; everything else is a
// no-op.
function clusterByTypeWithinOrg(cy: Core): void {
  // Mild pull: 0.35 was strong enough to overlap labels when fcose
  // had already packed nodes tightly. 0.18 still produces visible
  // type-grouping (same-colour discs gravitate towards each other)
  // without bunching their bboxes into one another.
  const PULL = 0.18;
  cy.nodes().forEach((org) => {
    if (org.data("type") !== "organization") return;
    const children = org.children();
    if (children.length < 3) return;

    const byType = new Map<string, NodeSingular[]>();
    children.forEach((c) => {
      const t = c.data("type") as string;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(c);
    });
    if (byType.size < 2) return;

    for (const group of byType.values()) {
      if (group.length < 2) continue;
      const cx =
        group.reduce((s, n) => s + n.position().x, 0) / group.length;
      const cy0 =
        group.reduce((s, n) => s + n.position().y, 0) / group.length;
      group.forEach((n) => {
        const p = n.position();
        n.position({
          x: p.x + (cx - p.x) * PULL,
          y: p.y + (cy0 - p.y) * PULL,
        });
      });
    }
  });
}

function separateOverlappingOrgs(cy: Core): void {
  const orgs = cy.nodes().filter((n) => n.data("type") === "organization");
  if (orgs.length < 2) return;

  // Just enough to keep org-circle outlines from kissing -- the labels
  // sit inside the circles, so a tight gap is fine and lets the orgs
  // fill the canvas instead of fanning out.
  const PAD = 16;
  const MAX_ITER = 30;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let moved = false;
    for (let i = 0; i < orgs.length; i++) {
      for (let j = i + 1; j < orgs.length; j++) {
        const a = orgs[i].boundingBox({});
        const b = orgs[j].boundingBox({});

        const overlapX = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) + PAD;
        const overlapY = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) + PAD;

        if (overlapX <= 0 || overlapY <= 0) continue;

        const dx = (a.x1 + a.x2) / 2 - (b.x1 + b.x2) / 2;
        const dy = (a.y1 + a.y2) / 2 - (b.y1 + b.y2) / 2;

        let shiftX = 0;
        let shiftY = 0;
        if (overlapX < overlapY) {
          shiftX = (overlapX / 2) * (dx >= 0 ? 1 : -1);
        } else {
          shiftY = (overlapY / 2) * (dy >= 0 ? 1 : -1);
        }

        shiftOrgChildren(orgs[i], shiftX, shiftY);
        shiftOrgChildren(orgs[j], -shiftX, -shiftY);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

// settles we persist every leaf's resulting position so the next load
// qualifies for the preset path.
function applyInitialLayout(
  cy: Core,
  graph: GraphPayload,
  queueSave: (id: string, x: number, y: number) => void,
): void {
  const leaves = graph.nodes.filter((n) => n.type !== "organization");
  const positionedLeaves = leaves.filter(
    (n) => typeof n.pos_x === "number" && typeof n.pos_y === "number",
  );
  const allPositioned =
    leaves.length > 0 && positionedLeaves.length === leaves.length;

  const saveAll = () => {
    cy.nodes().forEach((n) => {
      const p = n.position();
      queueSave(n.id(), p.x, p.y);
    });
  };

  if (allPositioned) {
    const layout = cy.layout({
      name: "preset",
      fit: true,
      padding: 80,
    } as cytoscape.LayoutOptions);
    layout.run();
    // Persisted positions are authoritative on reload. Resize the
    // compound parent's bbox to circumscribe its children (style-only,
    // doesn't move anything) so click-targets and the nebula radius
    // are sensible. Do NOT run separateOverlappingOrgs here -- that
    // would shift saved positions on every reload and undo the user's
    // manual placements. Skipping saveAll() too: nothing changed, no
    // POST needed.
    expandOrgsToCircleSquares(cy);
    fitAllInView(cy, 80);
    return;
  }

  // Some (or all) leaves need a layout run. fcose's randomize:false
  // requires quality:'proof' per the fcose docs, so we flip both when
  // we have anchors to preserve.
  const hasAnchors = positionedLeaves.length > 0;
  const fixedNodeConstraint = hasAnchors
    ? positionedLeaves.map((n) => ({
        nodeId: n.id,
        position: { x: n.pos_x as number, y: n.pos_y as number },
      }))
    : undefined;

  const layoutOptions: Record<string, unknown> = {
    name: "fcose",
    animate: true,
    animationDuration: 700,
    fit: true,
    padding: 80,
    nodeDimensionsIncludeLabels: true,
    // Lower repulsion + higher gravity keeps the constellation compact
    // so it fills the visible canvas instead of fanning organisations
    // off into the void. Previous values (45000/0.22) left huge dead
    // space between every cluster on first load.
    nodeRepulsion: 22000,
    // Per-edge ideal length: structural edges (belongs_to/applies/
    // informed_by) get a shorter target, so structurally-tied nodes
    // visibly cluster; informational edges (related_to) get a longer
    // target so they don't drag everything together. fcose accepts a
    // function returning the desired length per edge.
    idealEdgeLength: (edge: EdgeSingular) =>
      edge.data("structural") === "1" ? 110 : 180,
    // Spring stiffness. fcose default is 0.45; we boost it so edges
    // visibly compete with the high node-repulsion force.
    edgeElasticity: 0.65,
    gravity: 0.45,
    gravityRangeCompound: 1.4,
    gravityCompound: 1.0,
    nestingFactor: 0.15,
    numIter: 4500,
    tile: true,
    // Tile padding governs how much air sits between sibling
    // components when fcose packs them. Cut from 140 to 50 -- still
    // enough that orgs don't touch, but no longer a crater.
    tilingPaddingVertical: 50,
    tilingPaddingHorizontal: 50,
    packComponents: true,
    randomize: !hasAnchors,
    quality: hasAnchors ? "proof" : "default",
  };
  if (fixedNodeConstraint) {
    layoutOptions.fixedNodeConstraint = fixedNodeConstraint;
  }

  const layout = cy.layout(layoutOptions as unknown as cytoscape.LayoutOptions);
  (layout as unknown as { one: (event: string, cb: () => void) => void }).one(
    "layoutstop",
    () => {
      clusterByTypeWithinOrg(cy);
      expandOrgsToCircleSquares(cy);
      separateOverlappingOrgs(cy);
      fitAllInView(cy, 80);
      saveAll();
    },
  );
  layout.run();
}

export default function GraphView({
  graph,
  selectedId,
  query,
  disabledRelations,
  disabledOrgs,
  disabledTypes,
  disabledStatuses,
  theme,
  onSelect,
  onCreateOrganization,
}: Props) {
  // Defer the search query so typing stays responsive even when the graph
  // is large enough that the filter pass takes a perceptible amount of
  // time. React re-runs the filter effect with the deferred value during
  // idle time; the input itself updates immediately on the controlled
  // input upstream.
  const deferredQuery = useDeferredValue(query);
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const prevSelectedRef = useRef<string | null>(selectedId);
  // When a search query is active this holds the set of nodes the
  // viewport should stay framed on (matches + their 1st-level
  // neighbours). ResizeObserver reads this so that opening the
  // DetailPane on a search hit doesn't snap the camera back to the
  // whole graph and undo the centring.
  const focusElesRef = useRef<NodeCollection | null>(null);
  // Currently selected node id, mirrored from the selectedId prop into a
  // ref. The ResizeObserver reads this so that opening/closing the
  // DetailPane keeps the clicked node pinned to the centre of the
  // viewport instead of drifting toward the cluster's geometric centre.
  // Initialised from the prop so a deep-link (?node=X on first load)
  // gets centred on the right node even if the prop-effect hasn't run
  // by the first RO callback.
  const selectedNodeIdRef = useRef<string | null>(selectedId);
  // Debounce the focus fit so fast typing ("A" -> "As" -> "Asa" -> ...)
  // coalesces into a single camera move once the user pauses. Without
  // this, every keystroke fires a new animation and cytoscape's default
  // animation queue plays them back-to-back, producing a visible
  // "jumping back and forth" effect.
  const focusAnimTimerRef = useRef<number | null>(null);

  // The render listener bound in the init effect captures `theme` in a
  // closure. Reading the latest theme through a ref means we don't need
  // to rebind the listener on every theme flip — the pip colour just
  // tracks the current theme on the next render tick.
  const themeRef = useRef<Theme>(theme);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  // Org "circles" rendered as an SVG overlay synced to cytoscape's render
  // loop. Cytoscape compound parents are hard-wired to rectangles, so we
  // hide the rectangle body and draw a circle ourselves around each org's
  // bounding box. Updated on every cytoscape render frame (pan/zoom/drag).
  // Each org carries its deterministic nebula colour so per-instance
  // gradients can reference it without recomputing the hash mid-render.
  // Overlay sync model: structure (which orgs / which owned leaves
  // exist, their colours / labels) lives in React state and re-
  // renders only on real structural change. All per-frame data --
  // positions, sizes, visibility, opacity -- mutates SVG nodes
  // directly via refs from the cytoscape render loop. Bypasses
  // React reconciliation for the 60 fps case.
  const [orgStructure, setOrgStructure] = useState<
    Array<{ id: string; label: string; color: string; childCount: number }>
  >([]);
  const [pipStructure, setPipStructure] = useState<
    Array<{ id: string; initials: string; type: string }>
  >([]);

  // Canonical org position in cytoscape WORLD coords. The org's
  // visible nebula and label render at this anchor instead of the
  // compound parent's bbox centre, so that dragging a leaf node
  // inside the org doesn't drag the cluster's identity along with
  // it. Lazily initialised on first sight of an org. Updated only
  // when the user drags the org's label or runs Auto-rozložení.
  const orgAnchorsRef = useRef<Map<string, { x: number; y: number }>>(
    new Map(),
  );

  // SVG refs for imperative DOM mutation per cytoscape frame.
  const orgGlowRefs = useRef<Map<string, SVGCircleElement>>(new Map());
  const orgLabelRefs = useRef<Map<string, SVGGElement>>(new Map());
  const pipGroupRefs = useRef<Map<string, SVGGElement>>(new Map());
  const pipBgRefs = useRef<Map<string, SVGCircleElement>>(new Map());
  const pipBorderRefs = useRef<Map<string, SVGCircleElement>>(new Map());
  const pipTextRefs = useRef<Map<string, SVGTextElement>>(new Map());
  // Signature strings for cheap structural-change detection.
  const orgSigRef = useRef<string>("");
  const pipSigRef = useRef<string>("");

  // Debounced queue of position changes. Node drags and layout settles
  // both funnel through this so we coalesce a flurry of updates into one
  // batched /positions POST.
  const pendingSavesRef = useRef<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  const saveTimerRef = useRef<number | null>(null);
  const queuePositionSave = useCallback((id: string, x: number, y: number) => {
    pendingSavesRef.current.set(id, { x, y });
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      const updates = Array.from(pendingSavesRef.current.entries()).map(
        ([id, p]) => ({ id, x: p.x, y: p.y }),
      );
      pendingSavesRef.current.clear();
      saveTimerRef.current = null;
      savePositions(updates).catch((err) => {
        // Fire-and-forget: losing a save is not catastrophic, the next
        // drag will re-persist. Log so we still notice real breakage.
        console.warn("savePositions failed", err);
      });
    }, 300);
  }, []);

  // Initialize cytoscape once. Starts empty -- the data effect below
  // populates elements and chooses the initial layout strategy based on
  // whether positions have been persisted.
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: stylesheet(THEMES[theme]),
      minZoom: 0.25,
      maxZoom: 3,
    });

    cyRef.current = cy;
    // Debug hook — lets us inspect cytoscape from devtools. Safe to leave for now.
    (window as unknown as { __cy: Core }).__cy = cy;

    // Resize observer: keep cytoscape in sync when the detail pane opens or
    // closes, or when the window resizes. We animate the refit so the graph
    // smoothly recentres instead of snapping — the snap is what the user
    // perceives as a "jump". A short debounce coalesces multi-frame resizes
    // (window drag) into a single animation.
    //
    // We compare against the last fitted container size instead of skipping
    // the first callback unconditionally. The old "skip first" logic was
    // there to avoid undoing fcose's own fit, but if the container actually
    // resized between cy-init and the first RO callback (DetailPane mount,
    // fonts loading) the skip would freeze the fit at a stale size and
    // leave nodes outside the viewport on page load.
    let fitTimer: number | null = null;
    let lastFitW = containerRef.current.clientWidth;
    let lastFitH = containerRef.current.clientHeight;
    const ro = new ResizeObserver((entries) => {
      cy.resize();
      const entry = entries[0];
      const w = entry ? entry.contentRect.width : cy.width();
      const h = entry ? entry.contentRect.height : cy.height();
      // No size change -> no fit. This guards against the redundant
      // initial-observation callback while still recovering when the
      // container truly grew or shrank since the last fit.
      if (Math.abs(w - lastFitW) < 1 && Math.abs(h - lastFitH) < 1) return;
      lastFitW = w;
      lastFitH = h;
      if (fitTimer !== null) window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        // Cancel any running animation so this fit replaces it cleanly
        // instead of queueing behind it.
        cy.stop();
        // Priority: explicit selection > search cluster > fit-all.
        // Selection wins because clicking a node is the user saying
        // "I care about THIS node" -- the camera has to keep it
        // centred even after the DetailPane opens and the container
        // narrows. Centering preserves the current zoom so we don't
        // slam to maxZoom on a single 60px node.
        const selId = selectedNodeIdRef.current;
        if (selId) {
          const node = cy.getElementById(selId);
          if (node.length > 0) {
            focusOnNode(cy, node, 120, 1.6, 360);
            fitTimer = null;
            return;
          }
        }
        const focus = focusElesRef.current;
        if (focus && focus.length > 0) {
          animateFit(cy, focus, 120, 1.6, 360);
        } else {
          // `:visible` only: status-filtered or hidden nodes report
          // bbox=(0,0,0,0), which would otherwise stretch the fit
          // rectangle from (0,0) to the visible cluster and leave most
          // of the graph offscreen.
          cy.animate(
            { fit: { eles: cy.elements(":visible"), padding: 80 } },
            { duration: 360, easing: "ease-in-out-cubic" },
          );
        }
        fitTimer = null;
      }, 30);
    });
    ro.observe(containerRef.current);

    // Events
    cy.on("tap", "node", (evt) => {
      const node = evt.target as NodeSingular;
      if (node.data("type") === "organization") {
        // Tapping a cluster selects it too
        onSelect(node.id());
      } else {
        onSelect(node.id());
      }
    });

    cy.on("tap", (evt) => {
      if (evt.target === cy) onSelect(null);
    });

    // Persist position after every drag. Save the dragged node and, if
    // it's an organization, all its descendants too (dragging an org
    // moves all its children).
    cy.on("dragfree", "node", (evt) => {
      const n = evt.target as NodeSingular;
      // If a leaf moved, its parent org's bounding box may have changed,
      // so rebuild the circumscribed-square sizing before persisting.
      if (n.data("type") !== "organization") {
        expandOrgsToCircleSquares(cy);
      }
      const p = n.position();
      queuePositionSave(n.id(), p.x, p.y);
      if (n.data("type") === "organization") {
        n.descendants().forEach((child) => {
          const cp = child.position();
          queuePositionSave(child.id(), cp.x, cp.y);
        });
      }
    });

    // Hover is intentionally NOT wired up. Any visual change on hover forces
    // the compound parent to refit its children, which looks like nodes
    // jumping. Keep the base style constant and only react to click.

    // The render-loop handler. Splits per-frame work into:
    //   1) Structural detection -- only when the set of orgs / owned
    //      leaves / their labels actually changed. Computes a
    //      signature string and bails before setState if it matches.
    //   2) Position / visibility / opacity update -- runs every
    //      tick, mutates SVG via refs. Bypasses React entirely.
    const PIP_MIN_DISC_R = 16;
    const updateOverlays = () => {
      const orgs = cy.nodes('[type = "organization"]');
      const pan = cy.pan();
      const zoom = cy.zoom();

      orgs.forEach((n) => {
        const id = n.id();
        if (!orgAnchorsRef.current.has(id)) {
          const wbb = n.boundingBox({ includeLabels: false });
          orgAnchorsRef.current.set(id, {
            x: (wbb.x1 + wbb.x2) / 2,
            y: (wbb.y1 + wbb.y2) / 2,
          });
        }
      });

      const orgSig = orgs
        .map(
          (n) =>
            `${n.id()}|${(n.data("label") as string) ?? ""}|${n.children().length}`,
        )
        .join("\n");
      if (orgSig !== orgSigRef.current) {
        orgSigRef.current = orgSig;
        setOrgStructure(
          orgs.map((n) => ({
            id: n.id(),
            label: (n.data("label") as string) ?? "",
            color: colorForOrg(n.id()),
            childCount: n.children().length,
          })),
        );
      }

      const ownedNodes = cy.nodes().filter((n) => {
        if (n.data("type") === "organization") return false;
        return Boolean(n.data("owner_initials"));
      });
      const pipSig = ownedNodes
        .map(
          (n) => `${n.id()}|${n.data("owner_initials")}|${n.data("type")}`,
        )
        .join("\n");
      if (pipSig !== pipSigRef.current) {
        pipSigRef.current = pipSig;
        setPipStructure(
          ownedNodes.map((n) => ({
            id: n.id(),
            initials: n.data("owner_initials") as string,
            type: n.data("type") as string,
          })),
        );
      }

      // ---------- Per-frame ref mutation ----------
      orgs.forEach((n) => {
        const id = n.id();
        const anchor = orgAnchorsRef.current.get(id);
        if (!anchor) return;
        const rbb = n.renderedBoundingBox({ includeLabels: false });
        const screenCx = anchor.x * zoom + pan.x;
        const screenCy = anchor.y * zoom + pan.y;
        const r = Math.min(rbb.w, rbb.h) / 2;
        const nebulaR = r * 1.6;

        const glow = orgGlowRefs.current.get(id);
        if (glow) {
          glow.setAttribute("cx", String(screenCx));
          glow.setAttribute("cy", String(screenCy));
          glow.setAttribute("r", String(nebulaR));
        }
        const labelG = orgLabelRefs.current.get(id);
        if (labelG) {
          const childCount = n.children().length;
          const labelCy = childCount <= 1 ? rbb.y1 - 14 : screenCy;
          labelG.setAttribute(
            "transform",
            `translate(${screenCx} ${labelCy})`,
          );
          const hidden = n.hasClass("hidden") || n.hasClass("dim");
          labelG.style.display = hidden ? "none" : "";
        }
      });

      ownedNodes.forEach((n) => {
        const id = n.id();
        const g = pipGroupRefs.current.get(id);
        if (!g) return;
        const bb = n.renderedBoundingBox({ includeLabels: false });
        const r = Math.min(bb.w, bb.h) / 2;
        if (r < PIP_MIN_DISC_R) {
          g.style.display = "none";
          return;
        }
        g.style.display = "";
        const cx = (bb.x1 + bb.x2) / 2;
        const cy0 = (bb.y1 + bb.y2) / 2;
        const pipR = r * 0.42;
        const offset = r * 0.72;
        const px = cx + offset;
        const py = cy0 + offset;
        g.setAttribute("transform", `translate(${px} ${py})`);
        g.setAttribute(
          "opacity",
          n.hasClass("dim") || n.hasClass("dim-soft") ? "0.35" : "1",
        );
        const bgCircle = pipBgRefs.current.get(id);
        const borderCircle = pipBorderRefs.current.get(id);
        const text = pipTextRefs.current.get(id);
        if (bgCircle) bgCircle.setAttribute("r", String(pipR));
        if (borderCircle) borderCircle.setAttribute("r", String(pipR));
        if (text)
          text.setAttribute("font-size", String(Math.max(8, pipR * 0.85)));
      });
    };

    // rAF-throttle: cytoscape can fire `render` several times per
    // tick (one per animated property), so a raw handler did 3-5x
    // the work needed.
    let overlayRafId = 0;
    const scheduleOverlays = () => {
      if (overlayRafId !== 0) return;
      overlayRafId = window.requestAnimationFrame(() => {
        overlayRafId = 0;
        updateOverlays();
      });
    };
    cy.on("render", scheduleOverlays);
    scheduleOverlays();

    return () => {
      ro.disconnect();
      if (overlayRafId !== 0) {
        window.cancelAnimationFrame(overlayRafId);
        overlayRafId = 0;
      }
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (focusAnimTimerRef.current !== null) {
        window.clearTimeout(focusAnimTimerRef.current);
        focusAnimTimerRef.current = null;
      }
      cy.destroy();
      cyRef.current = null;
    };
    // Initialize only once; data updates are handled in separate effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap cytoscape stylesheet when theme flips. No layout re-run — only
  // colors change, node positions and bounds stay exactly where they are.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.style(stylesheet(THEMES[theme]));
  }, [theme]);

  // Sync cytoscape with incoming graph data. This effect deliberately
  // does NOT blow away the graph and re-run layout on every call -- the
  // old "clear + fcose" pattern was the source of the jumping nodes the
  // user complained about. Instead:
  //
  //   First call (cytoscape is still empty):
  //     - Add all elements.
  //     - If every leaf has a persisted position, use `preset` layout
  //       (instant, zero physics). Otherwise run fcose once, pinning
  //       whatever positioned leaves we have, and save the settled
  //       positions so the next load uses preset.
  //
  //   Subsequent calls (refetch after a mutation):
  //     - Diff against cytoscape. Remove gone nodes/edges, update
  //       mutable fields (name, description, size) on existing nodes
  //       WITHOUT touching their position, and add new nodes at a
  //       sensible spot (centroid of their connected neighbours).
  //     - No layout run, no fit. Existing nodes stay put. Any new
  //       position is immediately POSTed to /positions.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const newElements = buildElements(graph);
    const newNodesById = new Map<string, GraphNode>(
      graph.nodes.map((n) => [n.id, n]),
    );
    const newNodeIds = new Set(graph.nodes.map((n) => n.id));
    const newEdgeIds = new Set(graph.edges.map((e) => e.id));

    const isFirstLoad = cy.nodes().length === 0;

    if (isFirstLoad) {
      cy.add(newElements);
      applyInitialLayout(cy, graph, queuePositionSave);
      return;
    }

    // Diff-based update. No layout run for existing nodes.
    cy.batch(() => {
      // Remove deleted elements.
      cy.nodes().forEach((n) => {
        if (!newNodeIds.has(n.id())) n.remove();
      });
      cy.edges().forEach((e) => {
        if (!newEdgeIds.has(e.id())) e.remove();
      });

      // Add new nodes and edges, update mutable data on existing ones.
      // buildElements emits nodes first and edges second (the loops in
      // buildElements run in that order), so iterating here means new
      // nodes land before the edges that reference them.
      for (const el of newElements) {
        const isEdge =
          typeof (el.data as { source?: unknown }).source === "string";
        const id = el.data.id as string;

        if (isEdge) {
          if (cy.getElementById(id).length === 0) {
            cy.add(el);
          }
          continue;
        }

        const existing = cy.getElementById(id);
        if (existing.length > 0) {
          // If the node moved to a different compound parent (org), we
          // must remove+re-add: cytoscape does not support reparenting
          // in place. Connected edges are re-added below when the edge
          // loop reaches them.
          const newParent = (el.data as Record<string, unknown>).parent;
          if (existing.data("parent") !== newParent) {
            // Reparenting also relocates: keeping the old position
            // would leave the node visually orphaned far from its
            // new org cluster. Land it at the new org's child
            // centroid (with jitter) so it visibly joins the cluster.
            // When moving OUT of an org (new parent is undefined),
            // fall back to the leaf's old position.
            let pos: { x: number; y: number };
            if (typeof newParent === "string" && newParent.length > 0) {
              pos = placeNodeInOrg(cy, newParent);
            } else {
              pos = existing.position();
            }
            existing.remove();
            cy.add({ ...el, position: pos });
            queuePositionSave(id, pos.x, pos.y);
            continue;
          }
          // Node is already in the graph. Update its mutable data
          // fields in place; do NOT touch position. Owner + lifecycle
          // are mutated via the detail pane and must propagate so the
          // owner pip and any lifecycle-driven styles stay current.
          for (const key of [
            "label",
            "description",
            "status",
            "lifecycle_state",
            "owner_id",
            "owner_name",
            "owner_initials",
            "degree",
            "size",
          ] as const) {
            existing.data(key, (el.data as Record<string, unknown>)[key]);
          }
          continue;
        }

        // New node -- place it sensibly before adding.
        const node = newNodesById.get(id)!;
        let position: { x: number; y: number };
        if (el.position) {
          // Backend already has a persisted position (unusual for a
          // truly new node, but possible if the user created it in a
          // parallel session).
          position = el.position;
        } else {
          position = placeNewNode(cy, id, node.type, graph);
        }
        cy.add({ ...el, position });
        if (node.type !== "organization") {
          queuePositionSave(id, position.x, position.y);
        }
      }
    });
  }, [graph]);

  // Apply search + filter dimming. When a search query is active the
  // matches stay fully visible, their 1st-level neighbours get a soft
  // dim (still readable) and everything else gets the strong dim. The
  // camera re-fits to the match + neighbour cluster so the user doesn't
  // have to hunt for the hit.
  const prevQueryRef = useRef("");
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const q = foldForSearch(deferredQuery.trim());
    const hasQuery = q.length > 0;
    const hasRelFilter = disabledRelations.size > 0;
    const hasOrgFilter = disabledOrgs.size > 0;
    const hasTypeFilter = disabledTypes.size > 0;
    const hasStatusFilter = disabledStatuses.size > 0;

    // Compute match sets before the batch so TS flow-narrowing is happy
    // and the camera logic below can read them.
    let matches: NodeCollection | null = null;
    let neighborNodes: NodeCollection | null = null;
    let neighborEdges: EdgeCollection | null = null;

    if (hasQuery) {
      const hits = cy.nodes().filter((n) => {
        if (n.data("type") === "organization") return false;
        const label = foldForSearch((n.data("label") as string) ?? "");
        const desc = foldForSearch((n.data("description") as string) ?? "");
        const type = foldForSearch((n.data("type") as string) ?? "");
        return label.includes(q) || desc.includes(q) || type.includes(q);
      });
      matches = hits;
      const neighborhood = hits.neighborhood();
      neighborNodes = neighborhood.nodes().difference(hits);
      neighborEdges = neighborhood.edges();
    }

    cy.batch(() => {
      cy.nodes().removeClass("dim dim-soft hidden");
      cy.edges().removeClass("dim dim-soft hidden");

      // Filter-driven hide: org / type / status / relation filters
      // remove items from view entirely. Search-driven dimming below
      // uses the soft `dim` / `dim-soft` classes so matches stay
      // legible in their context.
      if (hasOrgFilter) {
        cy.nodes().forEach((n: NodeSingular) => {
          if (
            n.data("type") === "organization" &&
            disabledOrgs.has(n.id())
          ) {
            n.addClass("hidden");
            n.descendants().forEach((child: NodeSingular) => {
              child.addClass("hidden");
              child.connectedEdges().addClass("hidden");
            });
          }
        });
      }

      if (hasQuery && matches && neighborNodes && neighborEdges) {
        const matchSet = matches;
        const neighborNodeSet = neighborNodes;
        const neighborEdgeSet = neighborEdges;

        cy.nodes().forEach((n: NodeSingular) => {
          if (n.hasClass("hidden")) return;
          if (n.data("type") === "organization") {
            // Org is visible if any of its children are match or neighbour.
            const anyVisibleChild = n
              .children()
              .some((c) => matchSet.contains(c) || neighborNodeSet.contains(c));
            if (!anyVisibleChild) n.addClass("dim");
            return;
          }
          if (matchSet.contains(n)) return;
          if (neighborNodeSet.contains(n)) {
            n.addClass("dim-soft");
            return;
          }
          n.addClass("dim");
        });

        cy.edges().forEach((e: EdgeSingular) => {
          if (e.hasClass("hidden")) return;
          const srcMatch = matchSet.contains(e.source());
          const tgtMatch = matchSet.contains(e.target());
          if (srcMatch && tgtMatch) return;
          if (neighborEdgeSet.contains(e)) {
            e.addClass("dim-soft");
            return;
          }
          e.addClass("dim");
        });
      }

      if (hasRelFilter) {
        cy.edges().forEach((e: EdgeSingular) => {
          if (disabledRelations.has(e.data("relation") as string)) {
            e.removeClass("dim-soft dim");
            e.addClass("hidden");
          }
        });
      }

      // Node type filter: hide nodes of any disabled type and every
      // edge touching them. Works orthogonally to the org/query filters.
      if (hasTypeFilter) {
        cy.nodes().forEach((n: NodeSingular) => {
          if (disabledTypes.has(n.data("type") as string)) {
            n.removeClass("dim-soft dim");
            n.addClass("hidden");
            n.connectedEdges().forEach((e: EdgeSingular) => {
              e.removeClass("dim-soft dim");
              e.addClass("hidden");
            });
          }
        });
      }

      // Status filter: hide nodes whose current status is toggled off
      // (archived by default). Edges touching a filtered node also
      // hide so the graph doesn't leave dangling lines.
      if (hasStatusFilter) {
        cy.nodes().forEach((n: NodeSingular) => {
          if (disabledStatuses.has(n.data("status") as string)) {
            n.removeClass("dim-soft dim");
            n.addClass("hidden");
            n.connectedEdges().forEach((e: EdgeSingular) => {
              e.removeClass("dim-soft dim");
              e.addClass("hidden");
            });
          }
        });
      }
    });

    // Publish the current focus for the ResizeObserver so that a later
    // DetailPane open/close refits onto the search cluster instead of
    // snapping back to the whole graph.
    const focus =
      hasQuery && matches && matches.length > 0
        ? neighborNodes
          ? matches.union(neighborNodes)
          : matches
        : null;
    focusElesRef.current = focus;

    // Re-centre only when the query string itself changed (not when
    // filter toggles re-run this effect). That keeps filter
    // interactions from shoving the viewport around.
    const queryChanged = q !== prevQueryRef.current;
    prevQueryRef.current = q;
    if (queryChanged) {
      if (focusAnimTimerRef.current !== null) {
        window.clearTimeout(focusAnimTimerRef.current);
      }
      // Capture targets for the timer. `focus` is the NodeCollection
      // computed in this effect run, but by the time the timer fires
      // the effect may have re-run — capturing here means the animation
      // reflects the latest query.
      const targetFocus = focus;
      const targetHasQuery = hasQuery;
      focusAnimTimerRef.current = window.setTimeout(() => {
        focusAnimTimerRef.current = null;
        // Stop any in-flight camera animation so the new one replaces
        // it cleanly instead of queueing behind it.
        cy.stop();
        if (targetFocus) {
          animateFit(cy, targetFocus, 120, 1.6, 400);
        } else if (!targetHasQuery) {
          cy.animate(
            { fit: { eles: cy.elements(), padding: 80 } },
            { duration: 400, easing: "ease-in-out-cubic" },
          );
        }
      }, 220);
    }
  }, [deferredQuery, disabledRelations, disabledOrgs, disabledTypes, disabledStatuses]);

  // Apply selection highlight AND pan the camera so the clicked node
  // sits at the centre of the viewport. We center on the SINGLE node
  // (not the cluster of neighbours) so the node the user actually
  // tapped on is exactly where they expect it -- previously we framed
  // node.union(neighbourhood), and the cluster's geometric centre is
  // biased toward whichever side has more neighbours, leaving the
  // clicked node visibly off-centre. Zoom is preserved: refitting on a
  // single node would slam the camera to maxZoom and lose every other
  // node from view, while the user's existing zoom level is already
  // the one they chose.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    // Read the prior selection BEFORE stamping the new one. Needed
    // below to skip the deselect-fit branch on the very first
    // effect run (where selectedId starts null and prevSelected is
    // also null) so the data effect's fitAllInView is left alone.
    const prevSelected = prevSelectedRef.current;
    prevSelectedRef.current = selectedId;
    selectedNodeIdRef.current = selectedId;
    cy.batch(() => {
      cy.nodes().removeClass("selected");
      cy.edges().removeClass("highlight");
      if (selectedId) {
        const node = cy.getElementById(selectedId);
        if (node.length > 0) {
          node.addClass("selected");
          node.connectedEdges().addClass("highlight");
        }
      }
    });

    const hasSearch = query.trim().length > 0;
    if (selectedId) {
      const node = cy.getElementById(selectedId);
      if (node.length === 0) return;
      cy.stop();
      focusOnNode(cy, node, 120, 1.6, 360);
    } else if (!hasSearch && prevSelected !== null) {
      // Deselect-with-no-search: refit to all visible nodes. The
      // `prevSelected !== null` guard keeps initial mount from
      // racing with applyInitialLayout's framing.
      focusElesRef.current = null;
      cy.stop();
      cy.animate(
        { fit: { eles: cy.elements(":visible"), padding: 80 } },
        { duration: 360, easing: "ease-in-out-cubic" },
      );
    }
    // Reading `query` from the closure (not deps) keeps this effect
    // anchored to selection events; React rebinds the closure on every
    // render so we always see the latest query value when a click
    // actually fires this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // The org label is the *only* drag handle for an organization. A
  // tiny mouse movement (< 4px) before mouseup is treated as a click
  // (selects the org); anything larger is a drag that shifts every
  // child of the org by the cursor delta. Position persistence runs
  // once on mouseup so we don't spam /positions during the drag.
  const handleOrgLabelMouseDown = useCallback(
    (e: React.MouseEvent, orgId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const cy = cyRef.current;
      if (!cy) return;
      const org = cy.getElementById(orgId);
      if (org.length === 0) return;

      const startX = e.clientX;
      const startY = e.clientY;
      let lastX = startX;
      let lastY = startY;
      let dragged = false;
      const zoom = cy.zoom();

      const onMove = (ev: MouseEvent) => {
        if (!dragged) {
          const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
          if (dist < 4) return;
          dragged = true;
        }
        const dx = (ev.clientX - lastX) / zoom;
        const dy = (ev.clientY - lastY) / zoom;
        lastX = ev.clientX;
        lastY = ev.clientY;
        const children = org.children();
        if (children.length > 0) {
          children.forEach((c) => {
            c.shift({ x: dx, y: dy });
          });
        } else {
          org.shift({ x: dx, y: dy });
        }
        // Label drags carry the anchor along with the cluster; leaf
        // drags don't touch this Map, which is why the nebula stays
        // visually anchored when a single child is moved.
        const anchor = orgAnchorsRef.current.get(orgId);
        if (anchor) {
          anchor.x += dx;
          anchor.y += dy;
        }
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (dragged) {
          expandOrgsToCircleSquares(cy);
          org.descendants().forEach((c) => {
            const p = c.position();
            queuePositionSave(c.id(), p.x, p.y);
          });
          if (org.children().length === 0) {
            const p = org.position();
            queuePositionSave(org.id(), p.x, p.y);
          }
        } else {
          onSelect(orgId);
        }
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [onSelect, queuePositionSave],
  );

  // Build the fcose options shared by both relayout buttons. Pulled
  // out so the two handlers can't drift apart -- the same physics
  // governs "re-tile leaves" and "rebuild from scratch", they only
  // differ in whether org positions are restored after layoutstop.
  const buildRelayoutOptions = useCallback(() => {
    return {
      name: "fcose",
      animate: true,
      animationDuration: 700,
      fit: true,
      padding: 80,
      nodeDimensionsIncludeLabels: true,
      nodeRepulsion: 22000,
      idealEdgeLength: (edge: EdgeSingular) =>
        edge.data("structural") === "1" ? 110 : 180,
      edgeElasticity: 0.65,
      gravity: 0.45,
      gravityRangeCompound: 1.4,
      gravityCompound: 1.0,
      nestingFactor: 0.15,
      numIter: 4500,
      tile: true,
      tilingPaddingVertical: 50,
      tilingPaddingHorizontal: 50,
      packComponents: true,
      randomize: true,
      quality: "proof",
    } as unknown as cytoscape.LayoutOptions;
  }, []);

  // "Uspořádat uzly": re-tile the leaves *within* each org but keep
  // each org sitting under its existing nebula. Animation flow:
  //   1. Snapshot each leaf's start position.
  //   2. Run fcose with `animate: false` so positions are computed
  //      synchronously (no fcose-driven motion to fight with).
  //   3. Apply the anchor restore + expand passes. The leaves are
  //      now where they should END UP.
  //   4. Snap them back to their start positions inside cy.batch so
  //      cytoscape doesn't render the snap.
  //   5. Animate each leaf from start to target with a single tween,
  //      so the user sees one continuous motion ending at the leaf's
  //      final spot near its org -- not "fly away then jump back".
  const handleRetileNodes = useCallback(() => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;

    // Capture leaf start positions for the manual animation.
    const startPositions = new Map<string, { x: number; y: number }>();
    cy.nodes().forEach((n) => {
      if (n.data("type") === "organization") return;
      const p = n.position();
      startPositions.set(n.id(), { x: p.x, y: p.y });
    });

    // Snapshot every org's canonical anchor.
    const orgCenters = new Map<string, { x: number; y: number }>();
    cy.nodes().forEach((n) => {
      if (n.data("type") !== "organization") return;
      const anchor = orgAnchorsRef.current.get(n.id());
      if (anchor) {
        orgCenters.set(n.id(), { x: anchor.x, y: anchor.y });
      } else {
        const bb = n.boundingBox({ includeLabels: false });
        orgCenters.set(n.id(), {
          x: (bb.x1 + bb.x2) / 2,
          y: (bb.y1 + bb.y2) / 2,
        });
      }
    });

    // animate:false -> fcose computes positions synchronously, so
    // layoutstop fires with the new positions in place but no
    // intermediate motion has been rendered.
    // fit:false -> we'll handle the camera ourselves once the manual
    // animation completes (otherwise the camera snaps to the new bbox
    // before the leaves visually arrive there).
    const layout = cy.layout({
      ...buildRelayoutOptions(),
      animate: false,
      fit: false,
    } as cytoscape.LayoutOptions);

    (layout as unknown as { one: (e: string, cb: () => void) => void }).one(
      "layoutstop",
      () => {
        clusterByTypeWithinOrg(cy);
        // Anchor restore: shift each org's children so the cluster
        // centre lands back on the saved anchor.
        cy.nodes().forEach((n) => {
          if (n.data("type") !== "organization") return;
          const saved = orgCenters.get(n.id());
          if (!saved) return;
          const bb = n.boundingBox({ includeLabels: false });
          const cx = (bb.x1 + bb.x2) / 2;
          const cy0 = (bb.y1 + bb.y2) / 2;
          const dx = saved.x - cx;
          const dy = saved.y - cy0;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
          const children = n.children();
          if (children.length > 0) {
            children.forEach((c) => {
              c.shift({ x: dx, y: dy });
            });
          } else {
            n.shift({ x: dx, y: dy });
          }
        });
        expandOrgsToCircleSquares(cy);

        // Capture the final per-leaf target positions.
        const targetPositions = new Map<string, { x: number; y: number }>();
        cy.nodes().forEach((n) => {
          if (n.data("type") === "organization") return;
          const p = n.position();
          targetPositions.set(n.id(), { x: p.x, y: p.y });
        });

        // Snap leaves back to their start positions inside a batch
        // so cytoscape doesn't render the rewind; the animate calls
        // below will then play start -> target as one motion.
        cy.batch(() => {
          cy.nodes().forEach((n) => {
            const s = startPositions.get(n.id());
            if (s) n.position(s);
          });
        });

        const ANIM_MS = 700;
        cy.nodes().forEach((n) => {
          const t = targetPositions.get(n.id());
          if (!t) return;
          n.animate(
            { position: t },
            { duration: ANIM_MS, easing: "ease-out-cubic" },
          );
        });

        // After the leaves finish animating, fit the camera and
        // persist the new positions. fitAllInView ignores in-flight
        // animations so we wait until they've settled.
        window.setTimeout(() => {
          fitAllInView(cy, 80);
          cy.nodes().forEach((n) => {
            const p = n.position();
            queuePositionSave(n.id(), p.x, p.y);
          });
        }, ANIM_MS + 50);
      },
    );
    layout.run();
  }, [buildRelayoutOptions, queuePositionSave]);

  // "Přegenerovat layout": full re-pack including the top-level org
  // constellation. Same animation strategy as handleRetileNodes --
  // fcose runs synchronously, all post-processing (including
  // separateOverlappingOrgs) runs against the final positions, and a
  // single manual tween animates leaves from their start spots to
  // those finals. Without this, fcose animated to its raw output and
  // separateOverlappingOrgs then snapped overlapping orgs apart on
  // top of that, producing the exact "animate then jump" the user
  // complained about.
  const handleFullRelayout = useCallback(() => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;

    const startPositions = new Map<string, { x: number; y: number }>();
    cy.nodes().forEach((n) => {
      if (n.data("type") === "organization") return;
      const p = n.position();
      startPositions.set(n.id(), { x: p.x, y: p.y });
    });

    const layout = cy.layout({
      ...buildRelayoutOptions(),
      animate: false,
      fit: false,
    } as cytoscape.LayoutOptions);

    (layout as unknown as { one: (e: string, cb: () => void) => void }).one(
      "layoutstop",
      () => {
        clusterByTypeWithinOrg(cy);
        expandOrgsToCircleSquares(cy);
        separateOverlappingOrgs(cy);
        // Re-seat anchors so org labels follow the new centroids.
        cy.nodes().forEach((n) => {
          if (n.data("type") !== "organization") return;
          const children = n.children();
          if (children.length === 0) {
            const p = n.position();
            orgAnchorsRef.current.set(n.id(), { x: p.x, y: p.y });
            return;
          }
          const bb = children.boundingBox({});
          orgAnchorsRef.current.set(n.id(), {
            x: (bb.x1 + bb.x2) / 2,
            y: (bb.y1 + bb.y2) / 2,
          });
        });

        const targetPositions = new Map<string, { x: number; y: number }>();
        cy.nodes().forEach((n) => {
          if (n.data("type") === "organization") return;
          const p = n.position();
          targetPositions.set(n.id(), { x: p.x, y: p.y });
        });

        cy.batch(() => {
          cy.nodes().forEach((n) => {
            const s = startPositions.get(n.id());
            if (s) n.position(s);
          });
        });

        const ANIM_MS = 700;
        cy.nodes().forEach((n) => {
          const t = targetPositions.get(n.id());
          if (!t) return;
          n.animate(
            { position: t },
            { duration: ANIM_MS, easing: "ease-out-cubic" },
          );
        });

        window.setTimeout(() => {
          fitAllInView(cy, 80);
          cy.nodes().forEach((n) => {
            const p = n.position();
            queuePositionSave(n.id(), p.x, p.y);
          });
        }, ANIM_MS + 50);
      },
    );
    layout.run();
  }, [buildRelayoutOptions, queuePositionSave]);

  // Heavy SVG <defs> for nebula gradients. Memoised on org list +
  // theme so the per-frame render loop's setState (when structure
  // genuinely changes -- rare) isn't dragging this down with it.
  // The previous feTurbulence noise filter + second grain layer
  // were the largest GPU paint cost: re-rasterised every frame
  // because the filtered circle's bounds animate during pan/zoom.
  // Removed -- the smoothness on weaker hardware is worth losing
  // the dust grain.
  const nebulaDefs = useMemo(() => {
    return orgStructure.map((c) => {
      const sid = safeSvgId(c.id);
      const isDark = theme === "dark";
      return (
        <radialGradient
          key={`grad-${c.id}`}
          id={`nebulaGlow-${sid}`}
          cx="50%"
          cy="50%"
          r="50%"
        >
          <stop
            offset="0%"
            stopColor={c.color}
            stopOpacity={isDark ? 0.22 : 0.14}
          />
          <stop
            offset="35%"
            stopColor={c.color}
            stopOpacity={isDark ? 0.1 : 0.065}
          />
          <stop
            offset="70%"
            stopColor={c.color}
            stopOpacity={isDark ? 0.025 : 0.018}
          />
          <stop offset="100%" stopColor={c.color} stopOpacity={0} />
        </radialGradient>
      );
    });
  }, [orgStructure, theme]);

  return (
    <div
      className="relative isolate h-full w-full"
      style={{ background: THEMES[theme].bg }}
    >
      <svg className="pointer-events-none absolute inset-0 z-0 h-full w-full">
        <defs>{nebulaDefs}</defs>
        {/* Nebula circles. cx/cy/r mutated directly via orgGlowRefs
            from the cytoscape render loop; React only reconciles
            this list when an org is added/removed. */}
        {orgStructure.map((c) => {
          const sid = safeSvgId(c.id);
          return (
            <circle
              key={c.id}
              ref={(el) => {
                if (el) orgGlowRefs.current.set(c.id, el);
                else orgGlowRefs.current.delete(c.id);
              }}
              fill={`url(#nebulaGlow-${sid})`}
            />
          );
        })}
      </svg>
      <div ref={containerRef} className="relative z-10 h-full w-full" />
      {/* Org label overlay. Transform / display mutated via
          orgLabelRefs from the render loop. */}
      <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full">
        {orgStructure.map((o) => {
          const fontSize = o.childCount <= 1 ? 18 : 30;
          const opacity = o.childCount <= 1 ? 0.85 : 0.6;
          return (
            <g
              key={`org-label-${o.id}`}
              ref={(el) => {
                if (el) orgLabelRefs.current.set(o.id, el);
                else orgLabelRefs.current.delete(o.id);
              }}
              style={{
                cursor: "move",
                pointerEvents: "auto",
                userSelect: "none",
              }}
              onMouseDown={(e) => handleOrgLabelMouseDown(e, o.id)}
            >
              <text
                x={0}
                y={0}
                textAnchor="middle"
                dominantBaseline="central"
                fontFamily="Inter, sans-serif"
                fontSize={fontSize}
                fontWeight={600}
                fill={THEMES[theme].textMuted}
                opacity={opacity}
              >
                {o.label}
              </text>
            </g>
          );
        })}
      </svg>
      {/* Owner pips. Skeleton (one <g> per owned leaf) is React-
          managed; transform / opacity / inner-circle radii / text
          font-size mutated directly from the render loop, with
          display:none when the disc is too small for a pip. */}
      <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full">
        {pipStructure.map((p) => {
          const themeColors = THEMES[theme];
          const typeColor =
            themeColors.nodeColors[p.type] ?? themeColors.nodeColorDefault;
          return (
            <g
              key={`pip-${p.id}`}
              ref={(el) => {
                if (el) pipGroupRefs.current.set(p.id, el);
                else pipGroupRefs.current.delete(p.id);
              }}
              style={{ display: "none" }}
            >
              <circle
                ref={(el) => {
                  if (el) pipBgRefs.current.set(p.id, el);
                  else pipBgRefs.current.delete(p.id);
                }}
                fill={themeColors.bg}
              />
              <circle
                ref={(el) => {
                  if (el) pipBorderRefs.current.set(p.id, el);
                  else pipBorderRefs.current.delete(p.id);
                }}
                fill="none"
                stroke={typeColor}
                strokeWidth={1.2}
                opacity={0.95}
              />
              <text
                ref={(el) => {
                  if (el) pipTextRefs.current.set(p.id, el);
                  else pipTextRefs.current.delete(p.id);
                }}
                x={0}
                y={0.5}
                textAnchor="middle"
                dominantBaseline="central"
                fontFamily="Inter, sans-serif"
                fontWeight={600}
                fill={themeColors.text}
              >
                {p.initials}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="absolute bottom-4 right-4 z-30 flex gap-2">
        <button
          type="button"
          onClick={handleRetileNodes}
          title="Uspořádat uzly uvnitř organizací (organizace zůstanou na místě)"
          aria-label="Uspořádat uzly"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] shadow-sm transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        >
          <LayoutGrid size={16} />
        </button>
        <button
          type="button"
          onClick={handleFullRelayout}
          title="Kompletně přegenerovat layout včetně rozmístění organizací"
          aria-label="Přegenerovat layout"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] shadow-sm transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
        >
          <Shuffle size={16} />
        </button>
      </div>
      {graph.nodes.length === 0 && (
        <EmptyStateCta onCreateOrganization={onCreateOrganization} />
      )}
    </div>
  );
}

// Centred CTA shown over an empty graph canvas. The first thing a fresh
// user sees after the Turso wizard finishes — without it the app looks
// dead because there's no node to click. Forces type=organization in the
// modal since that's the only top-level type.
function EmptyStateCta({
  onCreateOrganization,
}: {
  onCreateOrganization: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-4">
      <div className="pointer-events-auto max-w-[420px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-2xl">
        <h2 className="mb-2 text-[16px] font-semibold tracking-tight text-[var(--color-text)]">
          Začni vytvořením první organizace.
        </h2>
        <p className="mb-5 text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
          Portuni mapuje, na čem pracuješ — týmy, projekty, procesy. Začni
          tím, že přidáš svou organizaci.
        </p>
        <button
          type="button"
          onClick={onCreateOrganization}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-4 py-2.5 text-[13.5px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)] hover:text-[var(--color-text)]"
        >
          + Vytvořit organizaci
        </button>
      </div>
    </div>
  );
}

