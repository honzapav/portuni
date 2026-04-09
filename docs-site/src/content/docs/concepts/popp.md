---
title: POPP Framework
description: The five node types that model organizational structure.
---

POPP is the organizational model behind Portuni. Five node types capture all work:

| Type | Description | Example |
|------|-------------|---------|
| **Organization** | Top-level entity | Workflow, Tempo, Nautie |
| **Project** | Concrete effort with start and end | Goldea Presale |
| **Process** | Repeatable way of doing something | Partner Account Management |
| **Area** | Domain of ongoing responsibility | People (HR) |
| **Principle** | Rule or belief guiding decisions | Start with assessment |

## Graph, not tree

These are peers connected by edges, not a hierarchy. A project can relate to multiple processes and areas simultaneously. `belongs_to` does not imply a tree -- an entity can belong to multiple parents.

## Edge types

Portuni uses four flat, non-hierarchical edge relations. All are strictly enforced -- both in the MCP tool layer (via Zod enum) and at the database layer (via CHECK constraint). No edge type is privileged; any node can connect to any other node.

| Relation | Meaning |
|----------|---------|
| `related_to` | Lateral, semantically light connection. Near-default -- use when no more specific relation fits |
| `belongs_to` | Entity is scoped to a larger scope. Can have multiple parents -- does not imply a tree |
| `applies` | Concrete work uses a repeatable pattern, e.g. a project applies a process |
| `informed_by` | Knowledge transfer from one node to another (learned from, referenced, drew on) |

Edges are directed: `source` is the entity that has the relationship, `target` is what it points to. For bidirectional relationships, create two edges or query both directions.

## Principles as culture

Principles are not linked to other nodes via an explicit edge. They are the cultural defaults of the organizations they belong to -- anything within a scope implicitly follows the principles of that scope. When unsure how to act, look at the principles in the relevant organization.

This is an intentional design choice: linking every project/process to every applicable principle would bloat the graph with low-signal edges. Culture is a fallback lookup, not pointer spaghetti.

## Example traversal

```
project:Goldea Presale
    --belongs_to--> organization:Workflow
    --applies--> process:Navrhy a cenotvorba
    --applies--> process:Partner Account Management
```

Starting from any node, `portuni_get_context` walks the graph in all directions, returning connected nodes with decreasing detail by depth.
