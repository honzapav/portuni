---
title: Events
description: Time-ordered knowledge records attached to nodes.
---

Events are the core unit of knowledge capture in Portuni. They record what happened, when, and on which node.

## What to log

Events capture knowledge worth remembering across sessions:

- **Decisions** -- "Decided to use Turso instead of PostgreSQL"
- **Discoveries** -- "Found that admin access is always the bottleneck"
- **Blockers** -- "Waiting for client to provide access credentials"
- **References** -- "Relevant doc: https://..."
- **Milestones** -- "Phase 1 migration complete"
- **Changes** -- "Switched from SSE to Streamable HTTP transport"
- **Notes** -- General knowledge worth preserving

**Not worth logging:** routine actions (renamed file, ran tests, installed package).

## Event lifecycle

Events have four statuses:

```
active --> resolved     (blocker was fixed, question was answered)
active --> superseded   (replaced by newer version)
active --> archived     (no longer relevant)
```

### Resolving

Use `portuni_resolve` when a blocker is cleared or a question is answered. The resolution is merged into the event's metadata.

### Superseding

Use `portuni_supersede` when a decision changes or information is updated. The old event is marked as `superseded` and a new event is created with a reference to it.

## Events in context

Events appear in tool responses with depth-aware detail:

| Depth | What you see |
|-------|-------------|
| 0 | Full events (up to 50, all fields) |
| 1 | Recent events (up to 5, summary fields) |
| 2+ | No events |

The SessionStart hook shows the 5 most recent active events when you enter a workspace folder.

## Tools

| Tool | Purpose |
|------|---------|
| `portuni_log` | Record an event on a node |
| `portuni_resolve` | Mark event as resolved |
| `portuni_supersede` | Replace with updated version |
| `portuni_list_events` | Query events with filters |
