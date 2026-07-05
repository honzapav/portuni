---
title: Lifecycle States
description: How each node type tracks where it is in its life – from backlog to done.
---

Every node in Portuni has two layers of state:

1. **`status`** – a coarse, system-wide enum: `active`, `completed`, `archived`. This is what filters and queries lean on.
2. **`lifecycle_state`** – a fine-grained, type-specific enum that says *where in its life* the node currently is. This is what humans and agents actually look at.

`status` is derived from `lifecycle_state` by a database trigger. You set the lifecycle state; the system computes the status. This keeps queries fast (one indexed enum) and the human-visible state expressive (different vocabularies for different node types).

## Why type-specific states

A project goes through `backlog -> planned -> in_progress -> done`. A process doesn't – processes don't sit in a backlog, they move from `not_implemented` through `implementing` to `operating`. Forcing one set of states on every node type produces vague labels nobody trusts.

Instead, each type has its own state machine, with vocabulary that fits the type. The trigger maps each lifecycle state to the right coarse status, so a single `WHERE status = 'active'` query still works.

## States by type

The exact enums live in [`apps/server/shared/popp.ts`](https://github.com/honzapav/portuni/blob/main/apps/server/shared/popp.ts) – the single source of truth shared by the backend and the frontend.

### Project

| State | Coarse status | Meaning |
|-------|---------------|---------|
| `backlog` | active | Captured, not committed to yet |
| `planned` | active | Committed – scheduled, but work hasn't started |
| `in_progress` | active | Execution is happening |
| `on_hold` | active | Paused – expected to resume |
| `done` | completed | Delivered – no more active work expected |
| `cancelled` | archived | Abandoned before completion, kept for reference |

### Process

| State | Coarse status | Meaning |
|-------|---------------|---------|
| `not_implemented` | active | Designed or intended, but not yet running |
| `implementing` | active | Being set up or rolled out |
| `operating` | active | Running as designed |
| `at_risk` | active | Running, but degrading or fragile – needs attention |
| `broken` | active | Not producing its intended result |
| `retired` | archived | Deliberately taken out of use |

### Area

| State | Coarse status | Meaning |
|-------|---------------|---------|
| `active` | active | Currently being managed |
| `needs_attention` | active | Owned, but something is off – review it |
| `inactive` | archived | Not currently worked on |
| `archived` | archived | No longer relevant |

### Principle

Principles are simple – they're either `active` or `archived`. No intermediate states.

### Organization

Organizations are almost as simple: `active`, `inactive`, or `archived`. They don't have a working life cycle in the same way projects do.

## How coarse status is derived

The mapping is deliberately small: `done` maps to `completed`; `archived`, `retired`, `cancelled`, and `inactive` map to `archived`; every other lifecycle state maps to `active`. Note that "active" as a coarse status is broad – a `broken` process and an `on_hold` project both count as coarse-active, because they still demand attention.

## Color coding in the frontend

Lifecycle states map to one of four color buckets in the UI:

| Bucket | Meaning | States |
|--------|---------|--------|
| Green | Live, operational, moving forward | `active`, `operating`, `in_progress`, `done` |
| Yellow | Warning, waiting, in flux | `needs_attention`, `at_risk`, `on_hold`, `implementing` |
| Red | Actionable negative | `broken`, `cancelled` |
| Gray | Dormant, closed out, or not started | `inactive`, `archived`, `retired`, `backlog`, `planned`, `not_implemented` |

The mapping lives in `apps/web/src/types.ts` (the `LIFECYCLE_COLORS` constant). Any state not listed falls through to gray, which is a safe default for new states added later.

## Setting lifecycle state

Both `portuni_create_node` and `portuni_update_node` accept an optional `lifecycle_state` parameter. The value is validated against the type's allowed states – a plain string-array check in the domain layer, backed by a database trigger that rejects invalid combinations even for direct SQL access. Attempting to set a project to `retired` (which only processes have) is rejected.

There are no per-type defaults. `lifecycle_state` is nullable: `portuni_create_node` sets it only when the caller provides it, so a node created without one simply has no lifecycle state (its coarse `status` defaults to `active` independently). Set it when the answer is known; leave it empty when it isn't.

## Why the trigger, not application code

The `status` field could be set in the tool layer alongside `lifecycle_state`, but a trigger is more robust. Direct SQL updates, future REST endpoints, seed scripts – all of them go through the same trigger and stay consistent. The application code stops needing to remember the mapping.

## Filtering and queries

Most queries filter by `status` (the coarse enum) because that's what indexes well and what most callers actually mean. Show me the active projects: `WHERE type = 'project' AND status = 'active'`. The fine-grained `lifecycle_state` is for display and for state-machine transitions, not for bulk filtering.

When you do want to filter by lifecycle state – say, "all projects in `planned`" – the query works the same way; there just isn't a dedicated index, so it scans more.
