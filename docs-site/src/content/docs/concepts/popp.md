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

| Relation | Meaning |
|----------|---------|
| `belongs_to` | Entity is part of a larger scope |
| `instance_of` | Concrete run of a general process |
| `applies` | Project uses a process |
| `guided_by` | Entity follows a principle |
| `depends_on` | Hard dependency |
| `related_to` | Loose thematic connection |
| `informed_by` | Knowledge transfer |

Edges are directed: `source` is the entity that has the relationship, `target` is what it points to. For bidirectional relationships, create two edges or query both directions.

## Example traversal

```
project:Goldea Presale
    --belongs_to--> organization:Workflow
    --applies--> process:Navrhy a cenotvorba
    --applies--> process:Partner Account Management
```

Starting from any node, `portuni_get_context` walks the graph in all directions, returning connected nodes with decreasing detail by depth.

## Additional node types

The `type` field is an open string, not an enum. Beyond the core POPP types, the system also supports:

- `methodology` -- reusable approach (e.g. GWS Implementation)
- `process_instance` -- concrete run of a methodology
- `artifact` -- hosted document or report (planned)
