---
title: Events
description: Time-ordered knowledge records attached to nodes.
---

Events are Portuni's memory. They're how agents (and people) capture what happened, when, and on which node – so that the next session doesn't start from scratch.

## What's worth logging

Events capture knowledge that matters across sessions:

- **Decisions** – "Decided to use Turso instead of Postgres"
- **Discoveries** – "Found that admin access is always the bottleneck"
- **Blockers** – "Waiting for the client to provide access credentials"
- **References** – "Relevant doc: https://..."
- **Milestones** – "Phase 1 migration complete"
- **Changes** – "Switched from SSE to Streamable HTTP"
- **Notes** – general knowledge worth keeping

**Not worth logging:** routine actions that'll be obvious from the code itself – renamed a file, ran tests, installed a package. Events are for things a future reader genuinely needs to know.

## How events evolve

An event goes through up to four states over its life:

```
active --> resolved     (blocker fixed, question answered)
active --> superseded   (replaced by a newer version)
active --> archived     (no longer relevant)
```

**Resolving.** Use `portuni_resolve` when a blocker's cleared or a question is answered. The resolution is merged into the event's metadata so the history stays in one place.

**Superseding.** Use `portuni_supersede` when a decision changes or the information's been updated. The old event becomes `superseded` and a new event takes its place, linked back to the original.

## How events show up in context

Events appear in tool responses with detail that scales inversely with distance from where you're looking:

| Depth | What you see |
|-------|--------------|
| 0 | Full events – up to 50, all fields |
| 1 | Recent events – up to 5, summary fields |
| 2+ | No events |

The `SessionStart` hook shows the 5 most recent active events whenever you enter a workspace folder, so you walk into the session already up to speed.

## Tools

| Tool | What it does |
|------|--------------|
| `portuni_log` | Record an event on a node |
| `portuni_resolve` | Mark an event as resolved |
| `portuni_supersede` | Replace one with an updated version |
| `portuni_list_events` | Query events with filters |
