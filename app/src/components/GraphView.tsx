import { useCallback, useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import type { Core, EdgeSingular, NodeSingular } from "cytoscape";
// @ts-expect-error — fcose has no first-party types
import fcose from "cytoscape-fcose";
import type { GraphPayload, GraphNode } from "../types";
import { STRUCTURAL_RELATIONS } from "../lib/colors";
import type { Theme, ThemeColors } from "../lib/theme";
import { THEMES } from "../lib/theme";
import { savePositions } from "../api";

cytoscape.use(fcose);

type Props = {
  graph: GraphPayload;
  selectedId: string | null;
  query: string;
  disabledRelations: Set<string>;
  disabledOrgs: Set<string>;
  theme: Theme;
  onSelect: (id: string | null) => void;
};

// Build cytoscape elements with orgs as compound parents.
// Any node with a `belongs_to` edge pointing at an organization becomes a child
// of that org's compound node; everything else floats freely between clusters.
const MIN_NODE_SIZE = 18;
const MAX_NODE_SIZE = 44;

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
      degree: d,
      size: node.type === "organization" ? 0 : sizeFor(d),
    };
    const parent = parentOfChild.get(node.id);
    if (parent) data.parent = parent;
    // Attach persisted position if the backend has one. Only leaves
    // carry persisted positions -- compound parents (organizations) are
    // derived from their children's bounding box by cytoscape. The
    // `preset` layout will pick these up without any physics run; if
    // positions are missing we fall through to fcose in the data effect.
    const el: cytoscape.ElementDefinition = { data };
    if (
      node.type !== "organization" &&
      typeof node.pos_x === "number" &&
      typeof node.pos_y === "number"
    ) {
      el.position = { x: node.pos_x, y: node.pos_y };
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

  return [
    // Compound parents (organizations).
    // IMPORTANT: border-width and padding are FIXED. Nothing on hover/select
    // may change them, or the compound parent visibly refits.
    {
      selector: 'node[type = "organization"]',
      style: {
        shape: "roundrectangle",
        "background-color": theme.orgFill,
        "background-opacity": theme.orgFillOpacity,
        "border-color": theme.edgeStructural,
        "border-width": 1.5,
        "border-opacity": 0.6,
        "border-style": "solid",
        label: "data(label)",
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": -6,
        color: theme.textMuted,
        "font-size": 13,
        "font-weight": 600,
        "font-family": "Inter, sans-serif",
        padding: "32px",
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
        "font-size": 11,
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
        "text-opacity": 0.9,
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
    // Selected: color change only. border-width, width, height, padding stay
    // constant so the compound parent never refits.
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
    // Dimmed (non-match of search/filter).
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
      if (n.data("type") === "organization") return;
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
    // No need to save -- positions came from the DB unchanged. Just fit.
    layout.run();
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
    nodeRepulsion: 9000,
    idealEdgeLength: 110,
    edgeElasticity: 0.2,
    gravity: 0.22,
    gravityRangeCompound: 1.4,
    gravityCompound: 0.5,
    nestingFactor: 0.5,
    numIter: 4500,
    tile: true,
    tilingPaddingVertical: 36,
    tilingPaddingHorizontal: 36,
    packComponents: true,
    randomize: !hasAnchors,
    quality: hasAnchors ? "proof" : "default",
  };
  if (fixedNodeConstraint) {
    layoutOptions.fixedNodeConstraint = fixedNodeConstraint;
  }

  const layout = cy.layout(layoutOptions as unknown as cytoscape.LayoutOptions);
  // Persist the settled positions once fcose stops. Use `one` so we
  // don't leak a handler across repeat layouts.
  (layout as unknown as { one: (event: string, cb: () => void) => void }).one(
    "layoutstop",
    saveAll,
  );
  layout.run();
}

export default function GraphView({
  graph,
  selectedId,
  query,
  disabledRelations,
  disabledOrgs,
  theme,
  onSelect,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const prevSelectedRef = useRef<string | null>(selectedId);

  // Debounced queue of position changes. Node drags and layout settles
  // both funnel through this so we coalesce a flurry of updates into one
  // batched /positions POST.
  const pendingSavesRef = useRef<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  const saveTimerRef = useRef<number | null>(null);
  const queuePositionSave = (id: string, x: number, y: number) => {
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
  };

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
    let firstResize = true;
    let fitTimer: number | null = null;
    const ro = new ResizeObserver(() => {
      cy.resize();
      if (firstResize) {
        // Skip the first ResizeObserver callback — fcose has already fit the
        // graph during layout, and a redundant fit() would undo that.
        firstResize = false;
        return;
      }
      if (fitTimer !== null) window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        cy.animate(
          { fit: { eles: cy.elements(), padding: 80 } },
          { duration: 360, easing: "ease-in-out-cubic" },
        );
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

    // Persist position after every drag. For a leaf node, just save it.
    // For a compound parent (organization) we walk the descendants --
    // dragging an org moves all its children and we need to save each
    // one's new position, because the org itself has no persisted
    // position (it's derived from its children's bbox).
    cy.on("dragfree", "node", (evt) => {
      const n = evt.target as NodeSingular;
      if (n.data("type") === "organization") {
        n.descendants().forEach((child) => {
          if (child.data("type") === "organization") return;
          const p = child.position();
          queuePositionSave(child.id(), p.x, p.y);
        });
        return;
      }
      const p = n.position();
      queuePositionSave(n.id(), p.x, p.y);
    });

    // Hover is intentionally NOT wired up. Any visual change on hover forces
    // the compound parent to refit its children, which looks like nodes
    // jumping. Keep the base style constant and only react to click.

    return () => {
      ro.disconnect();
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
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
    if (containerRef.current) {
      containerRef.current.style.background = THEMES[theme].bg;
    }
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
            const pos = existing.position();
            existing.remove();
            cy.add({ ...el, position: pos });
            continue;
          }
          // Node is already in the graph. Update its mutable data
          // fields in place; do NOT touch position.
          for (const key of [
            "label",
            "description",
            "status",
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

  // Apply search + filter dimming
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const q = query.trim().toLowerCase();
    const hasQuery = q.length > 0;
    const hasRelFilter = disabledRelations.size > 0;
    const hasOrgFilter = disabledOrgs.size > 0;

    cy.batch(() => {
      cy.nodes().removeClass("dim");
      cy.edges().removeClass("dim");

      // Organization filter: dim the compound parent and every child
      // inside it, plus all edges connected to those children.
      if (hasOrgFilter) {
        cy.nodes().forEach((n: NodeSingular) => {
          if (
            n.data("type") === "organization" &&
            disabledOrgs.has(n.id())
          ) {
            n.addClass("dim");
            n.descendants().forEach((child: NodeSingular) => {
              child.addClass("dim");
              child.connectedEdges().addClass("dim");
            });
          }
        });
      }

      if (hasQuery) {
        cy.nodes().forEach((n: NodeSingular) => {
          if (n.data("type") === "organization") return;
          const label = (n.data("label") as string).toLowerCase();
          const desc = ((n.data("description") as string) ?? "").toLowerCase();
          const type = (n.data("type") as string).toLowerCase();
          if (
            !label.includes(q) &&
            !desc.includes(q) &&
            !type.includes(q)
          ) {
            n.addClass("dim");
          }
        });
      }

      if (hasRelFilter) {
        cy.edges().forEach((e: EdgeSingular) => {
          if (disabledRelations.has(e.data("relation") as string)) {
            e.addClass("dim");
          }
        });
      }
    });
  }, [query, disabledRelations, disabledOrgs]);

  // Apply selection highlight. Camera refits happen in the ResizeObserver
  // (triggered by the pane open/close) so no camera logic is needed here.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    prevSelectedRef.current = selectedId;
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
  }, [selectedId]);

  // Re-run fcose from scratch, clearing all saved positions. Useful when
  // the graph looks cluttered or orgs overlap after incremental edits.
  const handleAutoLayout = useCallback(() => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;

    const layout = cy.layout({
      name: "fcose",
      animate: true,
      animationDuration: 700,
      fit: true,
      padding: 80,
      nodeDimensionsIncludeLabels: true,
      nodeRepulsion: 9000,
      idealEdgeLength: 110,
      edgeElasticity: 0.2,
      gravity: 0.22,
      gravityRangeCompound: 1.4,
      gravityCompound: 0.5,
      nestingFactor: 0.5,
      numIter: 4500,
      tile: true,
      tilingPaddingVertical: 36,
      tilingPaddingHorizontal: 36,
      packComponents: true,
      randomize: true,
    } as unknown as cytoscape.LayoutOptions);

    (layout as unknown as { one: (e: string, cb: () => void) => void }).one(
      "layoutstop",
      () => {
        cy.nodes().forEach((n) => {
          if (n.data("type") === "organization") return;
          const p = n.position();
          queuePositionSave(n.id(), p.x, p.y);
        });
      },
    );
    layout.run();
  }, []);

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ background: THEMES[theme].bg }}
      />
      <button
        onClick={handleAutoLayout}
        title="Re-run automatic layout"
        className="absolute bottom-4 right-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-muted)] shadow-sm transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
      >
        Auto-layout
      </button>
    </div>
  );
}
