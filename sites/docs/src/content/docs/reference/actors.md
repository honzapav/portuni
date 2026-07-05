---
title: Actors
description: Tools for managing people and automations – the actors who do work across organizations.
---

Actors are anyone or anything that does work. The actor registry is **global and cross-organizational** – an actor does not belong to any single organization, and no actor tool takes an `organization_id`. A single person can be assigned to responsibilities or own nodes across any number of organizations. See [Actors & Responsibilities](/concepts/actors-responsibilities/) for the conceptual model. This page is the tool reference.

## portuni_create_actor

Create a person or automation actor in the global registry.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | enum | yes | `person` or `automation` |
| `name` | string | yes | Display name |
| `is_placeholder` | boolean | no | `person` only. `true` for a role sketch without a real human yet (e.g. "need a lawyer"). Default `false` |
| `user_id` | string | no | `person` only. Link to a registered Portuni user (`users.id`) |
| `notes` | string | no | Internal notes (rationale, context). Not a role description – what an actor does is expressed by responsibilities on specific nodes |
| `external_id` | string | no | External system id (globally unique when set) |

Automation constraints: an `automation` actor cannot be a placeholder and cannot have a `user_id` – both are rejected with a clear error (and backed by a CHECK constraint on the `actors` table).

Returns: the full actor row – `{ id, type, name, is_placeholder, user_id, notes, external_id, created_at, updated_at }`.

## portuni_update_actor

Update an existing actor. Only provided fields change. The same automation constraints apply (automations cannot be placeholders or have a `user_id`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `actor_id` | string | yes | Actor ID |
| `name` | string | no | New display name |
| `is_placeholder` | boolean | no | `person` only. Flip between real person and placeholder role |
| `user_id` | string \| null | no | `person` only. Link or unlink a Portuni user. Pass `null` to clear |
| `notes` | string \| null | no | New internal notes. Pass `null` to clear |
| `external_id` | string | no | New external id |

Returns: the full updated actor row.

## portuni_list_actors

List all actors in the global registry, optionally filtered. Actors are cross-organizational – every actor is returned, not just ones tied to the current focus.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | enum | no | `person` or `automation` |
| `is_placeholder` | boolean | no | Filter by placeholder flag |

Returns: array of actor records.

## portuni_get_actor

Get a single actor with their responsibility assignments across every node.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `actor_id` | string | yes | Actor ID |

Returns the actor record plus an `assignments` array – one entry per `(responsibility, node)` pair the actor holds. Useful for "what is this person on the hook for across the org." Assignments on nodes hidden from the caller by group visibility are filtered out.

## portuni_delete_actor

Hard-delete an actor and cascade-delete every responsibility assignment they hold. The responsibility itself stays – only the assignment is removed. Any `node.owner_id` referencing this actor becomes `NULL`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `actor_id` | string | yes | Actor ID |

There is no soft-delete. If you might want the actor back, set `is_placeholder` to `true` instead.

Renamed from `portuni_archive_actor` (which was a misnomer – the call was always a hard delete). The legacy name no longer resolves; update any saved prompts or scripts to use `portuni_delete_actor`.

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
