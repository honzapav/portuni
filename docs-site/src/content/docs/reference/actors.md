---
title: Actors
description: Tools for managing people and automations – the actors who do work in an organization.
---

Actors are anyone or anything that does work in an organization. See [Actors & Responsibilities](/concepts/actors-responsibilities/) for the conceptual model. This page is the tool reference.

## portuni_create_actor

Create a person or automation actor in an organization.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `organization_id` | string | yes | The organization this actor belongs to |
| `type` | enum | yes | `person` or `automation` |
| `name` | string | yes | Display name |
| `description` | string | no | Free-form description |
| `notes` | string | no | Internal notes (private workings, hiring rationale, etc.) |
| `placeholder` | boolean | no | `true` for unfilled roles (`person` only). Default `false` |
| `user_id` | string | no | Link to a registered Portuni user (`person` only) |

Returns: `{ actor_id, organization_id, type, name, placeholder }`

## portuni_update_actor

Update any of the fields above. Returns the updated actor.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `actor_id` | string | yes | Actor ID |
| `name` | string | no | New display name |
| `description` | string | no | New description |
| `notes` | string | no | New notes |
| `placeholder` | boolean | no | Toggle placeholder status |
| `user_id` | string | no | Set or clear the linked Portuni user |

## portuni_list_actors

List actors with optional filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `organization_id` | string | no | Filter to one organization |
| `type` | enum | no | `person` or `automation` |
| `placeholder` | boolean | no | Filter by placeholder status |

Returns: array of actor records.

## portuni_get_actor

Get a single actor with their responsibility assignments across every node.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `actor_id` | string | yes | Actor ID |

Returns the actor record plus an `assignments` array – one entry per `(responsibility, node)` pair the actor holds. Useful for "what is this person on the hook for across the org."

## portuni_archive_actor

Hard-delete an actor and cascade-delete every responsibility assignment they hold. The responsibility itself stays – only the assignment is removed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `actor_id` | string | yes | Actor ID |

There is no soft-delete. Archiving is final. If you might want the actor back, update them to a `placeholder` instead.

## portuni_assign_responsibility

Attach an actor to a responsibility. Idempotent – re-assigning the same `(responsibility, actor)` pair is a no-op, not an error.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `responsibility_id` | string | yes | Responsibility ID |
| `actor_id` | string | yes | Actor ID |

## portuni_unassign_responsibility

Remove an actor from a responsibility.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `responsibility_id` | string | yes | Responsibility ID |
| `actor_id` | string | yes | Actor ID |

## See also

- [Responsibilities](/reference/responsibilities/) – tools for the responsibility records themselves
- [Actors & Responsibilities](/concepts/actors-responsibilities/) – conceptual model and design rationale
