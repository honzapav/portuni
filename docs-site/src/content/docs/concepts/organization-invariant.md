---
title: Organization Invariant
description: The single hard topology rule – every non-organization node belongs to exactly one organization.
---

Portuni's graph has exactly one structural rule it refuses to bend on: every non-organization node belongs to exactly one organization, via a `belongs_to` edge. No orphans, no multi-parent. This page explains what that means in practice, why the rule exists, and how it's enforced.

## The rule, precisely

For every node `n` whose type is **not** `organization`:

- There must be exactly one edge `n --belongs_to--> organization`.
- The target organization must exist and not be archived in a way that would orphan `n`.
- That edge cannot be removed in isolation – removing it requires creating a replacement in the same operation.

Organization nodes themselves are exempt – they're the root of the topology and don't belong to anything.

## Why this rule exists

The original spec allowed multi-parent: a process could belong to several organizations at once. In practice this caused two problems:

1. **Mirror paths became ambiguous.** If a process belongs to both Workflow and Tempo, where does its folder live? Two copies? A symlink? A cross-org "shared" drive? Every answer added complexity, and pairs of teams quickly disagreed on which to use.
2. **Cross-organization noise.** Events on a multi-parent process showed up in both organizations' contexts, even when one of them had nothing to do with the change. The graph became noisier without being more useful.

The fix was to pick one invariant and hold it: a node belongs to exactly one organization, full stop. A genuinely shared process becomes two processes – one per org – linked with `related_to` or `informed_by`. The duplication is real, but it's honest: each organization owns its version, and changes don't bleed.

## How it's enforced

Three layers of defense, because losing this invariant silently is the worst possible outcome.

### 1. The tool layer (atomic create)

`portuni_create_node` for any non-organization type **requires** an `organization_id` parameter. The tool runs an atomic `db.batch()` that inserts the node and its `belongs_to` edge in a single transaction – the node never exists in an orphan state, even for a microsecond.

### 2. The tool layer (connect / disconnect checks)

`portuni_connect` rejects any attempt to add a second `belongs_to -> organization` edge for a non-organization source. The error tells you which existing org the node belongs to and how to move it.

`portuni_disconnect` rejects removal of the only `belongs_to -> organization` edge for a non-organization source. To move a node between organizations, disconnect the old edge and connect the new one **in the same operation** (the tool exposes a flag for this, so the database never sees a moment of orphan state).

### 3. SQL triggers (defense in depth)

Two triggers catch any direct database access that would bypass the tool layer:

- `prevent_multi_parent_org` – fires on `INSERT` of an edge; refuses if it would create a second `belongs_to -> organization` edge for a non-organization source.
- `prevent_orphan_on_edge_delete` – fires on `DELETE` of an edge; refuses if it would leave a non-organization node with zero `belongs_to -> organization` edges.

These guard against seed scripts, future REST endpoints, and any other path that doesn't go through the MCP tools.

## Startup integrity sweep

Every time Portuni boots, `ensureSchema()` runs an integrity sweep over every non-organization node (including archived ones). If any node violates the invariant, startup aborts with the list of offenders.

There is no "warning and continue." Portuni does not serve requests over an inconsistent graph – silent warnings are exactly how the original violations crept in.

## Why no `BEFORE INSERT` trigger on `nodes`

You might wonder why the create-time enforcement lives in the tool layer instead of a database trigger. The answer is a SQLite limitation: SQLite doesn't support deferred constraints, so a `BEFORE INSERT` trigger on `nodes` would fire before the companion `belongs_to` edge could be inserted. It would always fail.

The atomic `db.batch()` in `portuni_create_node` is the equivalent guarantee – the node and its edge are inserted in one transaction, and the database never observes an in-between state.

## What this means in practice

- **Move a node between orgs:** disconnect + connect, atomic.
- **Find all nodes in an org:** filter by `belongs_to -> organization_id`. No tree walk needed.
- **Local mirror paths are deterministic:** `{workspace_root}/{org-sync-key}/{type-plural}/{node-sync-key}/`. Single org → single path → no ambiguity for any tool, agent, or human.
- **Routing policies stay simple:** `(node_type, org_slug) -> remote` is unambiguous because every node has exactly one org.
- **Cross-org work is explicit:** you create two nodes and link them with `related_to` or `informed_by`. The duplication is the feature.

The rest of the graph stays open – `related_to`, `applies`, `informed_by` edges can connect anything to anything. Just not `belongs_to`.
