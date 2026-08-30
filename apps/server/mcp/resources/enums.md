# Portuni enums

All enum sets below are strictly enforced -- both at the tool layer
and by SQLite CHECK constraints. Adding a new value is a schema
change. Do not invent values.

## Node types

The five POPP entities. See `portuni://architecture` for what each
one means.

```
organization, project, process, area, principle
```

## Edge relations

Four flat relations. See `portuni://architecture`.

```
related_to, belongs_to, applies, informed_by
```

## Node statuses

Coarse status. Derived automatically from `lifecycle_state` via DB
trigger; prefer setting `lifecycle_state` and let `status` follow.

```
active (default), completed, archived
```

## Lifecycle states

Type-specific primary state. The visible, color-coded one. Each
node type has its own set:

- **organization**: `active`, `inactive`, `archived`
- **area**: `active`, `needs_attention`, `inactive`, `archived`
- **process**: `not_implemented`, `implementing`, `operating`,
  `at_risk`, `broken`, `retired`
- **project**: `backlog`, `planned`, `in_progress`, `on_hold`,
  `done`, `cancelled`
- **principle**: `active`, `archived`

Mapping to coarse status:
`done`, `archived`, `retired`, `cancelled`, `inactive` map to a
non-active status. Everything else maps to `active`.

## Node visibility

```
team (default), private, group
```

Enforced server-side on every read (graph, list, get, context, files,
scope expansion): `team` is visible to every authenticated user,
`private` only to its creator and admins, `group` only to the users and
Google Groups listed in the node's access list (managed in the desktop
app's sharing section; `group` cannot be set directly). Restriction is
inherited along `belongs_to`; the nearest restricted ancestor decides,
a node's own list overrides it. A node the caller cannot see answers
`not_found`. `access_mode = request` shows such a node as a locked chip
(name and type only) and lets the user ask for access in the desktop
app; `private` hides it entirely.

## Event types

Time-ordered knowledge attached to nodes via `portuni_log`.

```
decision, discovery, blocker, reference, milestone, note, change
```

## Event statuses

```
active (default), resolved, superseded, archived
```

- `portuni_resolve` marks an event resolved.
- `portuni_supersede` replaces an event with an updated version
  (the original moves to `superseded`).

## File statuses

Section routing for `portuni_store`. Maps to `wip/` vs `outputs/`
in the mirror layout.

```
wip (default), output
```
