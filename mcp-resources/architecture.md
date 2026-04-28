# Portuni architecture

Portuni is the organizational knowledge graph. It captures structure and
connections between work in five entity types ("POPP") joined by four flat
edge relations.

## POPP entities

Strictly enforced; no other types exist. Do not invent new ones.

- **organization**: a team, company, project group, or other "container of
  work". Top-level scope.
- **project**: a bounded piece of work with a goal and (typically) an
  end. Lives inside an organization.
- **process**: a repeatable pattern -- workflow, ritual, automation. Can
  be applied by projects.
- **area**: an ongoing responsibility area inside an organization (sales,
  support, infra, hiring, ...).
- **principle**: a cultural default for an organization (see "Principles
  as culture" below).

## Edge relations

Strictly enforced; only these four. No relation is privileged. Any node
can connect to any other node. The graph is rhizomatic.

- **related_to**: near-default lateral connection. When unsure which
  relation fits, use `related_to`. It is not a fallback -- it is a
  meaningful "these two things are semantically connected".
- **belongs_to**: scope membership (see organization invariant below).
  Single-parent: a node has at most one `belongs_to` to an organization.
- **applies**: concrete work uses a pattern. Typical example: a project
  applies a process.
- **informed_by**: knowledge transfer. Used when one node was shaped or
  influenced by another (decision informed by reference, project
  informed by past project, ...).

## Organization invariant

Every non-organization node MUST have exactly one `belongs_to` edge
pointing to an organization. No orphans. No multi-parent.

- `portuni_create_node` requires `organization_id` for every
  non-organization type and atomically creates the node + its
  `belongs_to` edge. You cannot register a project, process, area, or
  principle without naming its organization.
- Attempting a second `belongs_to` to an organization, or removing the
  only one, is rejected at the tool layer AND by a database trigger.
- To move a node between organizations, prefer `portuni_move_node` --
  it rebinds the existing edge atomically and keeps audit history
  continuous. Do NOT disconnect-then-connect: that briefly violates the
  invariant and triggers will reject the disconnect.

## Principles as culture

Principles are not linked to their subjects via an explicit edge. They
function as cultural defaults applied to everything in scope. When
unsure how to act inside an organization, look at its principles.

Principles still belong to an organization via `belongs_to` (the
invariant applies to principles too) -- they are cultural defaults
*for that organization*, not free-floating rules.

## Events

Time-ordered knowledge attached to nodes: decisions, discoveries,
blockers, references, milestones, notes, changes. Events are not nodes
themselves -- they are append-only history that surfaces in
`portuni_get_node` and `portuni_get_context` responses. See
`portuni://enums` for the closed event-type and event-status sets.
