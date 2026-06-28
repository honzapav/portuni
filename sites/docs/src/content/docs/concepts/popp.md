---
title: POPP Framework
description: The five node types that model organizational structure.
---

POPP is the organizational model Portuni is built around. The idea is that any organization – yours included – can be captured with just five kinds of node. Five is enough to be expressive, and few enough to stay legible.

| Type | What it represents | Example |
|------|--------------------|---------|
| **Organization** | The top-level entity | Workflow, Tempo, Nautie |
| **Project** | A concrete effort with a start and an end | Goldea Presale |
| **Process** | A repeatable way of doing something | Partner Account Management |
| **Area** | An ongoing domain of responsibility | People (HR) |
| **Principle** | A rule or belief that guides decisions | Start with assessment |

## A graph, not a tree

These five types are peers, connected by edges. There's no hierarchy baked in – a project can relate to several processes and several areas at once, a process can apply to many projects, and so on. Real work looks like that, so the graph lets you model it honestly.

## The one rule: every node belongs to an organization

Portuni has exactly one hard invariant on the graph's shape: every non-organization node belongs to **exactly one** organization, via a `belongs_to` edge. No orphans, no multi-parent. This exists so that ownership is never ambiguous, local mirror paths are deterministic, and nothing can float outside an organizational scope.

To move a node from one organization to another, disconnect and reconnect in the same operation. The invariant is enforced in three layers:

1. **`portuni_create_node`** refuses to create a non-organization node without an `organization_id`, and writes the node plus its `belongs_to` edge atomically.
2. **`portuni_connect` / `portuni_disconnect`** reject attempts to add a second `belongs_to -> organization`, or to remove the only one.
3. **SQL triggers** catch any direct database access that would bypass the tool layer.

On startup, Portuni verifies the invariant for every non-organization node (including archived ones). A violation aborts startup with the list of offending nodes, so a human can fix it before the server handles any requests.

## Edge types

Portuni uses four flat, non-hierarchical edge relations. All of them are strictly enforced – at the MCP tool layer (via a Zod enum) and at the database layer (via a CHECK constraint). No edge type is privileged; any node can connect to any other node.

| Relation | What it means |
|----------|---------------|
| `related_to` | Lateral, semantically light – use when no more specific relation quite fits |
| `belongs_to` | The node is scoped to its organization. Exactly one per non-organization node (see the invariant above) |
| `applies` | Concrete work uses a repeatable pattern – e.g. a project applies a process |
| `informed_by` | Knowledge transfer between nodes – learned from, referenced, drew on |

Edges are directed: `source` is the entity holding the relationship, `target` is what it points to. For bidirectional relationships, create two edges or just query both directions.

## Principles as culture, not plumbing

You might have expected principles to be wired up with explicit edges too. They aren't – and that's on purpose. Principles are the cultural defaults of whichever organization they belong to; anything inside that scope implicitly follows them. When you're unsure how to act, look at the principles of the relevant organization.

Linking every project and process to every principle it should follow would bloat the graph with low-signal edges. Culture works better as a fallback lookup than as pointer spaghetti.

## A small example

```
project:Goldea Presale
    --belongs_to--> organization:Workflow
    --applies--> process:Navrhy a cenotvorba
    --applies--> process:Partner Account Management
```

Starting from any node, `portuni_get_context` walks the graph in every direction and returns connected nodes with decreasing detail as you move further out.
