# Graph node design — Constellation pip

Canonical visual language for nodes on the Portuni graph.

- **Visual reference:** [`graph-node-design.html`](./graph-node-design.html) — interactive HTML mockup with light/dark theme toggle, the full pattern dictionary, the per-type state matrix, and zoom-level survival check.
- **Background:** [`graph-node-exploration.html`](./graph-node-exploration.html) — the four-direction exploration (Aurora ring, Initials core, Status sigil, Constellation pip) that led to picking *Constellation pip* as the canonical direction.
- **Implementation:** [`app/src/components/GraphView.tsx`](../../app/src/components/GraphView.tsx) — `stylesheet()` defines the cytoscape rules, `HATCH_OVERLAY_URI` / `STRIKE_OVERLAY_URI` / `DOT_OVERLAY_URI` / `CHECK_OVERLAY_URI` / `buildHalfFillUri()` define the SVG overlays.
- **Tokens:** [`app/src/lib/theme.ts`](../../app/src/lib/theme.ts) — type colours, accent, edge tones, label background.

## Encoding rules

| Channel | Carries |
|---|---|
| Disc colour (fill / border) | **Type** — organization, project, process, area, principle |
| Disc silhouette + pattern | **Lifecycle state** — see matrix below |
| Owner pip (lower-right) | **Owner initials** — only renders once the rendered disc radius ≥ 16 px |
| Edge colour / line style | **Relation kind** — structural, related_to, applies, informed_by |

The two channels never collide: type stays on hue, lifecycle stays on shape and pattern. A purple disc is always a project; a hatched disc is always *at_risk* / *needs_attention* regardless of whether it is amber or pink.

## Lifecycle treatments

Each treatment is rendered by a cytoscape stylesheet rule keyed on `lifecycle_state`. Treatments cascade in this order: base leaf → state-specific → search dimming → selected. Selection always wins.

| Treatment | Used by states | Visual | Cytoscape mechanism |
|---|---|---|---|
| **SOLID** | active, operating, in_progress *(top half only)*, done *(plus check)* | Filled type-coloured disc | Default `background-color: nodeColor`, `background-opacity: 0.9` |
| **HOLLOW** | backlog | Empty type-coloured ring | `background-opacity: 0`, `border-width: 2.5` |
| **DASHED-COLOURED** | planned, inactive, not_implemented | Dashed type-coloured ring, no fill | `background-opacity: 0`, `border-style: dashed`, `border-width: 2` |
| **DASHED-GRAY** | on_hold | Dashed gray ring, no fill | Same as above with `border-color: theme.textMuted` |
| **HALF-FILL** | in_progress | Top half filled in type colour, bottom half empty with border | Bg colour from base + per-theme `buildHalfFillUri(theme.bg)` masking the bottom half |
| **CHECK** | done | Solid type-coloured disc + bold dark checkmark | `CHECK_OVERLAY_URI` |
| **DOT** | implementing | Solid type-coloured disc + dark dot pattern | `DOT_OVERLAY_URI` |
| **HATCH** | at_risk, needs_attention | Solid type-coloured disc + diagonal hatch | `HATCH_OVERLAY_URI` |
| **STRIKE** | broken | Solid type-coloured disc + red X + red border | `STRIKE_OVERLAY_URI` + `border-color: #f87171` |
| **FADED** | archived, retired, cancelled | Same as base but at low opacity | `background-opacity: 0.35`, `border-opacity: 0.35`, `text-opacity: 0.55` |

### Per-type state matrix

| Entity | States |
|---|---|
| **organization** | active *(SOLID)*, inactive *(DASHED-COLOURED)*, archived *(FADED)* |
| **project** | backlog *(HOLLOW)*, planned *(DASHED-COLOURED)*, in_progress *(HALF-FILL)*, on_hold *(DASHED-GRAY)*, done *(CHECK)*, cancelled *(FADED)* |
| **process** | not_implemented *(DASHED-COLOURED)*, implementing *(DOT)*, operating *(SOLID)*, at_risk *(HATCH)*, broken *(STRIKE)*, retired *(FADED)* |
| **area** | active *(SOLID)*, needs_attention *(HATCH)*, inactive *(DASHED-COLOURED)*, archived *(FADED)* |
| **principle** | active *(SOLID)*, archived *(FADED)* |

> Filtering note: status=archived nodes are *hidden by default* (`display: none` via the `.hidden` class), independent of the FADED visual treatment. The fade applies only when an archived node is forced visible by toggling the *Archivované* filter on. When a node is filtered out by org / type / status / relation, it is removed from layout entirely; only search uses the soft `dim` / `dim-soft` classes.

## Pattern overlays — implementation notes

Every overlay is an inline SVG data URI built once at module load (or per-theme for `HALF-FILL`).

- **Explicit `width="120" height="120"`** on the SVG element is mandatory. Without it browsers fall back to a 300×150 default canvas, which makes `background-fit: cover` rasterise the pattern at the wrong natural size and shift it to a corner of the disc. The `PATTERN_BOX = 120` constant centralises the viewBox + size.
- Every lifecycle rule that uses `background-image` also sets `background-width: 100%`, `background-height: 100%`, `background-position-x: 50%`, `background-position-y: 50%`, `background-clip: node`. Together these guarantee the pattern fills the ellipse and stays centred regardless of disc size.
- `HALF_FILL` is the one theme-coupled overlay: the bottom-half rectangle is filled with `theme.bg` so cytoscape's ellipse mask "erases" the bottom half of the disc. Rebuilt whenever `stylesheet(theme)` runs.

## Owner pip

- Rendered by the SVG overlay layer in `GraphView.tsx`, not by cytoscape, because cytoscape can't draw labelled chips on top of nodes.
- Constants live next to the helper: `PIP_MIN_DISC_R = 16` (rendered px), pip radius = `r * 0.42`, pip offset = `r * 0.72` lower-right of the disc.
- Initials come from `ownerInitials(name)`: `"Jan Pav" → "JP"`, single-word names take their first two letters, diacritics preserved.
- Hidden when the rendered disc is smaller than `PIP_MIN_DISC_R`, so zoom-out doesn't get crowded.

## Org rendering

Organisations are cytoscape compound parents but their native body / label are hidden:

- Native label set to `label: ""` and `text-opacity: 0` so cytoscape doesn't draw anything.
- A coloured **nebula** is drawn as an SVG radial-gradient cloud in the back layer (z-0). Colour is deterministic per org via `colorForOrg(id)` (FNV-1a hash → `NEBULA_HUES` palette).
- The **org label** is rendered in the foreground SVG layer with `pointer-events: auto` so it is the *only* drag handle. Body of the org is `grabbable: false, pannable: true` — so dragging the empty galaxy pans the canvas instead of moving the cluster.
- An **anchor** (`orgAnchorsRef`) holds each org's canonical world position. Nebula and label render at the anchor; the bbox-driven nebula radius still reacts to children. This decoupling means dragging a leaf inside the org doesn't drag the cluster identity along with it.

## Layout (fcose)

Numbers tuned to balance edge pull against node repulsion so structurally tied nodes visibly cluster without label collisions.

| Parameter | Value | Notes |
|---|---|---|
| `nodeRepulsion` | 45000 | Strong push so labels don't collide |
| `idealEdgeLength` | function: 150 / 240 | Structural edges (`belongs_to`, `applies`, `informed_by`) get the shorter target; `related_to` gets 240 so it doesn't drag everything together |
| `edgeElasticity` | 0.65 | Above fcose default 0.45 so edges visibly compete with `nodeRepulsion` |
| `gravity` / `gravityCompound` | 0.22 / 1.0 | Mild pull towards canvas centre / compound centre |
| `nestingFactor` | 0.15 | How much the compound parent attracts non-compound siblings |
| `tilingPaddingVertical/Horizontal` | 140 | Spacing between disconnected components when `tile: true` |
| `quality` | "default" / "proof" | "default" for first load with anchors, "proof" for the explicit *Auto-rozložení* button |

After fcose finishes, `clusterByTypeWithinOrg(cy)` pulls each org's same-type children 18 % closer to their type centroid — visible grouping of orange / purple / pink discs without bunching their bboxes into one another.

The *Auto-rozložení* button preserves manual org placements: it snapshots each org's anchor before fcose, then translates each org's children to align the new bbox centre with the saved anchor.
