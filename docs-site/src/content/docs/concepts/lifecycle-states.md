---
title: Lifecycle States
description: How each node type tracks where it is in its life – from kickoff to done.
---

Every node in Portuni has two layers of state:

1. **`status`** – a coarse, system-wide enum: `active`, `completed`, `archived`. This is what filters and queries lean on.
2. **`lifecycle_state`** – a fine-grained, type-specific enum that says *where in its life* the node currently is. This is what humans and agents actually look at.

`status` is derived from `lifecycle_state` by a database trigger. You set the lifecycle state; the system computes the status. This keeps queries fast (one indexed enum) and the human-visible state expressive (different vocabularies for different node types).

## Why type-specific states

A project goes through `kickoff -> planning -> operating -> done`. A process doesn't – processes don't have "kickoff," they have "draft -> active -> deprecated." Forcing one set of states on every node type produces vague labels nobody trusts.

Instead, each type has its own state machine, with vocabulary that fits the type. The trigger maps each lifecycle state to the right coarse status, so a single `WHERE status = 'active'` query still works.

## States by type

The exact enums live in [`src/popp.ts`](https://github.com/honzapav/portuni/blob/main/src/popp.ts) – the single source of truth shared by the backend and the frontend. The general shape:

### Project

| State | Coarse status | Meaning |
|-------|---------------|---------|
| `kickoff` | active | Just started – scope and team being defined |
| `planning` | active | Approach decided, work being broken down |
| `operating` | active | Execution is happening |
| `done` | completed | Delivered – no more active work expected |
| `archived` | archived | Closed out, kept for reference |

### Process

| State | Coarse status | Meaning |
|-------|---------------|---------|
| `draft` | active | Being written or reworked |
| `operating` | active | In active use |
| `deprecated` | active | Still works, but a replacement exists |
| `archived` | archived | No longer used |

### Area

| State | Coarse status | Meaning |
|-------|---------------|---------|
| `operating` | active | Currently being managed |
| `dormant` | active | Owned but not actively worked on |
| `archived` | archived | No longer relevant |

### Principle

Principles are simple – they're either `active` or `archived`. No intermediate states.

### Organization

Organizations follow the same simple model: `active` or `archived`. Organizations don't have a working life cycle in the same way projects do.

## Color coding in the frontend

Lifecycle states map to one of four color buckets in the UI:

| Bucket | Meaning | Examples |
|--------|---------|----------|
| Green | Live, operational, moving forward | `active`, `operating`, `in_progress`, `done` |
| Yellow | Warning, waiting, in flux | `needs_attention`, `kickoff`, `planning`, `dormant` |
| Red | Blocked or problematic | (reserved for future error states) |
| Gray | Default fallback | Anything not explicitly mapped |

The mapping lives in `app/src/types.ts` (the `LIFECYCLE_COLORS` constant). Any state not listed falls through to gray, which is a safe default for new states added later.

## Setting lifecycle state

Both `portuni_create_node` and `portuni_update_node` accept an optional `lifecycle_state` parameter. The Zod enum validates the value against the type's allowed states – attempting to set a project to `deprecated` (which only processes have) is rejected before hitting the database.

Defaults at creation time:

| Type | Default lifecycle state |
|------|-------------------------|
| `project` | `kickoff` |
| `process` | `draft` |
| `area` | `operating` |
| `principle` | `active` |
| `organization` | `active` |

## Why the trigger, not application code

The `status` field could be set in the tool layer alongside `lifecycle_state`, but a trigger is more robust. Direct SQL updates, future REST endpoints, seed scripts – all of them go through the same trigger and stay consistent. The application code stops needing to remember the mapping.

## Filtering and queries

Most queries filter by `status` (the coarse enum) because that's what indexes well and what most callers actually mean. Show me the active projects: `WHERE type = 'project' AND status = 'active'`. The fine-grained `lifecycle_state` is for display and for state-machine transitions, not for bulk filtering.

When you do want to filter by lifecycle state – say, "all projects in `planning`" – the query works the same way; there just isn't a dedicated index, so it scans more.
