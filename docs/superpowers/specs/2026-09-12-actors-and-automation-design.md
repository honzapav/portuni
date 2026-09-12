# Actors: roles across the workspace, automations that show their work

An actor is a person or an automation, always workspace-wide. This spec
gives an actor a role and organization relations, and makes an
automation actor a real thing: a set of routines with one function,
bound to one or more nodes, visible and editable where people look for
who does what.

Vision: `docs/vision/portuni-as-workspace.md` (Skills, rutiny, nadhled:
"Kontext firmy a člověka je skill organizace a skill aktéra";
Asana). Depends on `2026-09-12-routines-and-skills-design.md` (routines,
compile routine) and `2026-09-12-remote-hosts-and-task-queue-design.md`
(the team agent an automation runs on). Today: `actors` (`type
person|automation`, `user_id`, `external_id`, `notes`),
`responsibilities` per node with `responsibility_assignments` to actors
(`domain/actors.ts`, `api/actors.ts`, `ActorsPage.tsx`).

## Rules

1. **Actors are workspace-wide.** No organization column on `actors`;
   relations to organizations are rows, and one actor may relate to
   several.
2. **An automation actor is the face of its routines.** It has no
   credentials, no host and no runner of its own: every run is a routine
   run on the team agent under the routine's placement. What the actor
   adds is identity (a name people assign responsibilities to), a
   specification people can read and edit, and one place to see that it
   exists and works.
3. **One function, many nodes.** The same automation may serve several
   nodes (weekly digest on three projects). The specification is shared;
   each binding is one routine row with the same brief and its own
   schedule, host and last run.
4. **Editing the specification edits the routines.** The actor's
   `spec` is the brief of every routine bound to it; saving it updates
   them all. A routine bound to an actor has no brief of its own.
5. **Asana, if linked, is where a person sees the actor at work.** The
   automation's runs on an Asana-linked node use the same bot account
   and the same `Za: <actor name>` prefix as any headless run; nothing
   new on the Asana side.

## Model

`actors` gains: `role TEXT NULL` (free text for people: "Account
manager", "Consultant"; for automations the function in one line),
`spec TEXT NULL` (automations only: the brief, Markdown), `enabled
INTEGER NOT NULL DEFAULT 1` (automations only; disabling pauses every
bound routine).

`actor_organizations` (new): `actor_id`, `organization_id` (a node of
type organization), `relation TEXT` (`member | contractor | client |
serves`), PK on the pair. People get `member`/`contractor`/`client`;
automations get `serves`. `listActors` accepts `organization_id` to
filter through this table; without it the list is the whole workspace,
as today.

`routines` gains `actor_id TEXT NULL REFERENCES actors(id) ON DELETE
SET NULL`. A routine with an `actor_id` reads its brief from
`actors.spec` (`brief` column ignored) and runs as `session.user_id` =
the actor's creator (`actors.created_by`, new column), with the actor's
name shown as the author in chat, Asana comments and events
(`session_events.user_message.source = "actor"`; the event log keeps the
real `user_id` for audit).

Responsibilities are unchanged: assigning an automation actor to a
responsibility is the human-facing statement "this is done by the
digest bot"; the routine bindings are the machine-facing one. The
Rutiny tab shows both on a node.

## Flows

- **Create an automation** (Aktéři page › Nová automatizace): name,
  role (one line), spec (Markdown, prefilled with a template: cíl,
  vstupy, výstup, kdy se ptát), organizations it serves. Saving creates
  the actor only; no routine yet.
- **Bind to a node** (node detail › Rutiny › Přidat automatizaci, or
  the actor page › Nody › Přidat): pick the actor, schedule or trigger,
  policy, placement defaults. Creates a routine with `actor_id`.
- **See it work** (actor page): the spec, the bound nodes with last
  run / next run / outcome per binding, the last 20 runs across all
  bindings with links to their chats, error state if any binding is
  disabled after repeated errors, and the toggle `enabled`.
- **Edit the spec**: on the actor page; saving bumps
  `actors.updated_at`; the next run of every binding uses it. A run
  already live keeps the brief it started with.
- **Compile the actor skill** (people): the compile routine from
  `2026-09-12-routines-and-skills-design.md` accepts an actor as its
  subject and produces `.portuni-skills/actor-<slug>/SKILL.md` from
  role, relations, responsibilities and the notes; the organization
  skill lists its people this way. Not for automations.

## API

- `POST|PATCH /actors` accept `role`, `spec`, `enabled`,
  `organizations: [{ organization_id, relation }]`; `GET /actors?organization_id=`.
- `GET /actors/:id` gains `routines: [...]` (bindings with last/next
  run) and `recent_sessions`.
- `POST /nodes/:id/routines` accepts `actor_id` (then `brief` is
  refused); `PATCH /routines/:id` cannot set `brief` on a bound routine.
- MCP: `portuni_create_actor` / `portuni_update_actor` gain the same
  fields; `portuni_list_actors` gains `organization_id`. No new tools.

## Web

- **Aktéři** page: type filter, organization filter, automations show
  role, bound node count and a status dot (ok / error / disabled).
- **Actor detail** (new route, replaces the edit dialog for
  automations): the flows above.
- **Node detail › Rutiny**: rows bound to an actor show the actor's name
  and link to it instead of an inline brief.
- **Přehled › Na pozadí**: routine sessions carry the actor name.

## Testing

- `actor_organizations` filtering; a person in two organizations listed
  once.
- Spec edit propagates to all bindings' next runs; a live run keeps its
  brief.
- `enabled = 0` skips every binding in the scheduler with
  `last_outcome = skipped`.
- Author attribution: `user_message.source = "actor"` with the real
  `user_id` in the audit row.
- Compile routine with an actor subject writes `actor-<slug>`.

## Phases

1. Columns, `actor_organizations`, `routines.actor_id`, API, scheduler
   attribution.
2. Actor detail page and the two binding entry points.
3. Actor skill subject in the compile routine.

## Known gaps, accepted

- An automation runs as its creator's identity for permissions. A
  creator who leaves the workspace leaves the automation without an
  identity; the scheduler reports `error` with that reason and an admin
  reassigns `created_by`.
- Free-text `role` for people; a closed vocabulary can come when the
  organization skill needs one.
