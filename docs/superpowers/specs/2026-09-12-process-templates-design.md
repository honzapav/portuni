# Process templates: a process knows how its projects start

A project is often an instance of a process. The process node carries a
template: what the new project's mirror contains, which responsibilities
it has, which edges connect it. Applying the template is deterministic
code; the process's skill only advises on what to fill in afterwards.

Vision: `docs/vision/portuni-as-workspace.md` (Skills, rutiny, nadhled:
"Šablony projektů … proces nese, jak se z něj zakládá projekt";
Otevřené otázky 5). Depends on nothing in the runner plan; the skill
half depends on `2026-09-12-routines-and-skills-design.md`.

## Rules

1. **No new node type.** The template is content of a process node:
   a folder in its mirror. Any process may carry one; a process without
   one is unchanged.
2. **Deterministic apply.** Creating a project from a process is a
   server-domain function that copies files, creates responsibilities
   and edges from a manifest, with no model in the loop. The result is
   a function of (manifest, inputs) and is testable.
3. **The template is versioned by content.** The manifest's hash at
   apply time is recorded on the project (`nodes.meta.template`), so a
   later change to the process does not touch existing projects and a
   person can see which version a project came from.
4. **Guidance is a skill, not a wizard.** After apply, the new project's
   orientation tells the agent to read the process's skill (compiled
   from the process, `2026-09-12-routines-and-skills-design.md`) for
   what to fill in. No multi-step UI.

## Manifest

`<process mirror>/resources/template/portuni-template.yaml`:

```yaml
version: 1
name: "Implementace Asany"          # shown in the picker; default: process name
inputs:                              # asked once in the create dialog
  - key: client                       # becomes {{client}} in names and files
    label: "Klient"
    required: true
  - key: start
    label: "Začátek"
    type: date
project:
  name: "{{client}} – Asana adopce"
  description: "Implementace Asany pro {{client}} podle procesu {{process.name}}."
  lifecycle_state: planned
  visibility: team
files:                               # copied from resources/template/files/
  - from: "wip/plan.md"
    to: "wip/plan.md"
  - from: "resources/checklist.md"
    to: "resources/checklist.md"
responsibilities:
  - title: "Vedení projektu"
    description: "Odpovídá za harmonogram a komunikaci s klientem."
  - title: "Konfigurace Asany"
edges:
  - relation: informed_by
    to: "{{process.id}}"             # the process itself; always added
  - relation: applies
    to: "01K…"                       # a principle node id
```

Substitution is `{{key}}` for inputs and `{{process.id}}`,
`{{process.name}}`, `{{organization.id}}`, `{{today}}` for context, in
`project.*`, file names and file contents. Unknown keys are an error at
validation, not silently kept. Files under `resources/template/files/`
are the only source; paths outside it are refused.

## Apply

`createProjectFromProcess({ processId, inputs, userId })`
(`domain/templates.ts`):

1. Load the manifest from the process's mirror (local mode) or through
   `getFileRaw` on central; validate (schema, inputs present, files
   exist, edge targets visible to the caller); refuse with a list of
   errors.
2. `createNode` (type `project`, organization = the process's
   organization, fields from `project.*` after substitution) in one
   transaction with the `belongs_to` edge.
3. Create a mirror for the new node on the calling device (local mode /
   the desktop's own sidecar) when the process has one there; write the
   files with substitution; register them (`registerLocalFile` or the
   central create route, so the watcher and sync see them as ordinary
   files).
4. Create responsibilities and edges; record
   `nodes.meta.template = { process_id, manifest_hash, applied_at,
   inputs }`.
5. Audit `template_apply` on the project with the same detail.

Failure after step 2 leaves a project with `meta.template.partial =
true` and the error; the UI offers "Dokončit ze šablony" which re-runs
steps 3–4 idempotently (files that exist are skipped by hash,
responsibilities matched by title, edges by pair).

## API

- `GET /nodes/:id/template` (read): the parsed manifest with `inputs`
  and validation errors, or `null` when the process has none.
- `POST /nodes/:id/template/apply` `{ inputs }` (write on the process's
  organization) → the new project.
- MCP `portuni_create_from_process { process_id, inputs }` (write); the
  new project enters the session's write set the way
  `portuni_create_node` does.

## Web

- **Process detail › Přehled**: a "Šablona" row when the manifest
  exists: name, input list, validation state, "Založit projekt".
- **Founding dialog**: inputs from the manifest, preview of the project
  name, create → opens the new project. Errors from validation listed
  inline.
- **Sidebar › Nový node**: type project gains "ze šablony procesu…" with
  a picker of processes that have a valid manifest in the chosen
  organization.
- **Project detail › Přehled**: "Založeno ze šablony <process> (verze
  <hash7>)" with a link.

## Testing

- Manifest validation table (missing input, unknown placeholder, file
  outside `files/`, invalid edge target).
- Apply on a fixture process in local mode: node fields, files with
  substitution, responsibilities, edges, `meta.template`, audit row.
- Partial failure and idempotent completion.
- Central mode: apply through the agent router creates the files via the
  create route (record-only) so the watcher sees them.

## Phases

1. Manifest, validation, `createProjectFromProcess`, REST, MCP tool.
2. Web: process row, founding dialog, sidebar entry, project badge.
3. Orientation pointer to the process's skill (after skills land).

## Known gaps, accepted

- The template copies files, it does not link them; a later change to
  the process's checklist does not reach existing projects. That is the
  point of a template.
- Templates for processes creating processes or areas are not covered;
  the manifest's `project` block is the only target.
