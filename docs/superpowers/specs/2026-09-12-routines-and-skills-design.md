# Routines, skills and the overview agent: work that runs without being asked

A routine is a task with a schedule and a policy. A skill is a node
compiled for an agent. The overview agent is a routine on the
organization. All three are built from the session runtime: every run of
a routine is a headless session on its node, and skills are produced by
one built-in routine and consumed through scope expansion.

Vision: `docs/vision/portuni-as-workspace.md` (Skills, rutiny, nadhled;
Local vs. central). Step 4 of the runner plan; depends on
`2026-09-12-runner-and-session-design.md` and
`2026-09-12-remote-hosts-and-task-queue-design.md` (a scheduled run
needs a host). Scheduler on central; local mode runs a routine only by
hand.

## Rules

1. **A routine run is a session.** Same table, same events, same chat,
   same handoff. The routine row only says when, where, with what brief
   and what happens to the result.
2. **The handoff is the routine's memory.** Each run resumes from the
   previous run's handoff (`resume { mode: "handoff" }` semantics on a
   fresh session): the orientation carries the pointer, the agent reads
   it. No other state is threaded between runs.
3. **Policy decides what a finished run may do.** `auto`: the agent's
   writes stand and its `portuni_task_comment`/Drive push at the end are
   allowed. `review`: the run ends in `waiting` with a `question { type:
   "review" }` listing the write set; a person approves (nothing more to
   do) or asks for changes (a message on the same session, which resumes
   it).
4. **A skill is generated, never hand-written in Portuni.** The compile
   routine writes it; a person edits the node, not the skill. One
   `SKILL.md` format (name + description frontmatter, Markdown body) for
   Claude Code, Codex and OpenCode.
5. **Central schedules, hosts run.** One scheduler process on central
   (leader lock in the database); it creates sessions through the same
   `startTask` the UI uses, on the routine's host. Local mode has no
   scheduler; "Spustit teď" is the only trigger there.

## Model

### Routine

`routines` (central and local, same DDL):

| column | meaning |
|---|---|
| `id` | ULID |
| `node_id` | the node the run is anchored on |
| `name` | shown in the Rutiny tab |
| `brief` | the task text of every run |
| `kind` | `custom` \| `compile_skill` \| `overview` — built-ins carry their brief in code, `brief` is then a user addendum |
| `schedule` | cron expression (5 fields, UTC) or `null` for trigger-only |
| `trigger` | `null` \| `node_changed` (mirror content or graph fields changed, debounced 10 min) |
| `policy` | `auto` \| `review` |
| `runner`, `instance_id`, `host_id` | placement; null = the organization's defaults |
| `enabled` | |
| `last_session_id`, `last_run_at`, `last_outcome` (`completed` \| `waiting` \| `error` \| `skipped`), `next_run_at` | |
| `created_by`, `created_at`, `updated_at` | |

`sessions` gains `routine_id TEXT NULL`. A routine's sessions are listed
under it in the Rutiny tab and hidden from the Relace tab by default
(filter "Zobrazit rutinní").

### Skill

`node_skills` (central and local):

| column | meaning |
|---|---|
| `node_id` | PK |
| `slug` | directory name, from the node slug, unique |
| `content_hash` | sha256 of the generated `SKILL.md` |
| `source_hash` | hash of the inputs the compile saw (node fields, file list + hashes, edges, responsibilities, principles) |
| `generated_by_session_id`, `generated_at` | |
| `stale` | `0 \| 1`, set when `source_hash` no longer matches the node |

The file lives in the workspace: `<portuniRoot>/.portuni-skills/<slug>/SKILL.md`
on every host and device (pulled like any mirror content, see
Distribution). Skill bodies are not stored in the database; the hash is
enough to know whether a device is current.

## Scheduler

`domain/routines/scheduler.ts`, started by central's `index.ts` only:

- Every minute: `SELECT` routines with `enabled = 1 AND next_run_at <= now`
  under a leader lock (`scheduler_lock` row with a lease; a second central
  instance skips the tick). For each: skip when the previous session is
  still `running` or `waiting` (`last_outcome = skipped`, next slot
  computed), else `startTask` with `session_type: "headless"`,
  `routine_id`, brief = built-in brief + `routine.brief`, placement from
  the row or the organization's defaults, `policy` from the row. Advance
  `next_run_at`.
- `node_changed` triggers come from the mirror watcher's reconcile chain
  and the graph write paths (`updateNode`, edges, responsibilities): they
  set `routines.next_run_at = now + 10 min` for routines on that node with
  that trigger, so bursts coalesce.
- `POST /routines/:id/run` runs one now, regardless of schedule; that is
  the whole scheduler in local mode.
- Failure: `error` events end the run; the routine records `error` and
  the next slot; three consecutive errors disable the routine and put it
  under "Pozor" in Přehled.

## Review policy

At `run_ended` with `policy = review`, the runtime appends `question {
type: "review", title: "Zkontrolovat výsledek rutiny", detail: <write set
and last assistant message>, options: ["Přijmout", "Vrátit"] }` and sets
`waiting_since`. `Přijmout` answers it and closes the session. `Vrátit`
opens the composer; the next message resumes the session (conversation
mode when the run's `agent_session_id` is still resumable on that host,
handoff otherwise) so the agent reworks it. `type: "review"` is a new
member of the `question.type` union from step 1.

## Skills

### Compile routine (`kind: compile_skill`)

One per node that has `enabled = 1`; created on demand from the Rutiny
tab ("Generovat skill") or for every node of an organization at once.
Trigger `node_changed`, no cron. Built-in brief (in code, Czech, versioned
in `domain/routines/briefs.ts`): read the node (`portuni_get_context`, the
files under `resources/` and `outputs/`, principles reachable by edges,
responsibilities), write `.portuni-skills/<slug>/SKILL.md`: frontmatter
`name: <slug>`, `description` (one sentence: when an agent should invoke
this node), body sections "Co node je", "Jak se na něm pracuje", "Kde co
leží" (paths relative to the mirror), "Principy", "Kdo za co odpovídá",
"Nedávná rozhodnutí". Length cap 6 000 characters; anything longer is a
pointer to a file. Then `portuni_skill_publish { node_id }`, a tool that
hashes the file, writes `node_skills`, clears `stale`.

The routine's write set is `.portuni-skills/<slug>/` only; the policy is
`auto` (a skill is derived content, the node itself is untouched).
Writing there is tier 1 for this routine because provision maps
`.portuni-skills/<slug>` as the run's writable root instead of the node
mirror (a second `writableRoots` entry in the adapters; the node mirror
is read-only for this run).

### Distribution

`.portuni-skills/` is a directory under `portuniRoot` with one remote
binding per organization (central mode: a Drive folder next to the
organization's mirrors, synced by the same engine; local mode: local
only). Each host and device pulls it like a mirror; `node_skills.content_hash`
against the local file tells the UI whether it is current.

Runners find skills through their own project-level discovery, and all
three follow a symlinked skill directory (verified 2026-09-12 with Claude
Code 2.1.269, Codex CLI 0.154.0 `skills/list`, OpenCode 1.18.3: a
`<slug>` symlink to a directory holding `SKILL.md` is listed exactly like
a real directory). `scope-materialize.ts` writes, per mirror, two
symlinks per skill:

- `<mirror>/.claude/skills/<slug>` → `<portuniRoot>/.portuni-skills/<slug>`
  (Claude Code; OpenCode reads it too),
- `<mirror>/.agents/skills/<slug>` → the same target (Codex reads only
  `.agents/skills` and `.codex/skills` in a project, never
  `.claude/skills`; OpenCode reads this one as well),

for the node itself and for every depth-1 neighbour with a skill,
re-run on every skill publish and on every edge change of the node;
symlinks whose target is gone are removed. Both directories are
dot-prefixed, so the mirror watcher and the sync engine ignore them, and
FSEvents never reports the target's changes under the mirror. A new
`SKILL.md` is visible through the link at once; a running session sees
it at its next start, as with any skill. Hand-opened CLIs in a mirror get
the same set with nothing extra to configure.

- `portuni_expand_scope` and `portuni_get_context` return `skill_path`
  for a node that has one; the orientation lists the skills of every
  in-scope node under "Skills k dispozici". Invoking a node is expand
  scope plus reading that path, one step for the agent.

### Organization and actor skills

The compile routine on an organization node produces the organization
skill (who we are, how we work, principles, the map of projects and
processes with their slugs). Actor skills wait for the actor model to
carry role and relations (vision, open); not in this spec.

## Overview agent (`kind: overview`)

One routine per organization, created by "Zapnout agenta nadhledu" in the
organization's Rutiny tab, weekly by default, `policy: review`, scope =
the organization with `portuni_expand_scope` allowed without asking
(headless `auto` expansion inside the organization's subtree only; the
scope-sensitive floor still applies). Built-in brief: walk the graph,
compare with recent events and files, and produce proposals: missing
nodes, stale descriptions, responsibilities without an actor, projects
without a process, principles nobody references. Each proposal is one
`portuni_log` event of type `proposal` (new event type) on the node it
concerns, with `refs` to the evidence; the run's last message is the
summary. The review question lists the proposals; `Přijmout` keeps the
events (a person then acts on them from the node's Události), `Vrátit`
asks for a rework. Proposals are the answer to the vision's "missing
pieces" question: an agent logs them, people accept.

## API

- `GET /nodes/:id/routines`, `POST /nodes/:id/routines` `{ name, brief,
  kind, schedule, trigger, policy, runner?, instance_id?, host_id? }`
  (write), `PATCH /routines/:id`, `DELETE /routines/:id` (manage),
  `POST /routines/:id/run` (write), `GET /routines/:id/sessions`.
- `GET /nodes/:id/skill` (`node_skills` row + whether this device's file
  matches), `POST /nodes/:id/skill/compile` (creates the compile routine
  if missing and runs it).
- MCP: `portuni_skill_publish` (write, only from a session whose
  `routine_id` is a compile routine on that node), `portuni_run_routine
  { routine_id }` (write). `portuni_expand_scope` / `get_context` gain
  `skill_path`.
- `GET /overview` gains `background: { running, waiting, errors }` for
  routine sessions.

## Web

- **Node detail › Rutiny** tab (next to Relace): rows with name, kind,
  schedule/trigger, policy, last run (outcome, link to its chat), next
  run, enabled toggle; actions Spustit teď, Upravit, Smazat; "Generovat
  skill" and, on organizations, "Zapnout agenta nadhledu".
- **Node detail header**: skill badge (current / stale / none) linking to
  the skill file in the editor (read-only).
- **Přehled**: section "Na pozadí" (running and waiting routine sessions,
  review questions first) and routine errors under "Pozor".
- **SessionChat**: a review question renders with Přijmout / Vrátit.

## Testing

- Scheduler: due selection, leader lock, skip while running, three errors
  disable, `node_changed` debounce, `run now` in local mode without a
  scheduler.
- Review policy with the fake runner: `waiting` at end, Přijmout closes,
  Vrátit resumes with a message.
- Compile routine: provision maps the skill directory as the writable
  root and the mirror read-only; `portuni_skill_publish` refuses from a
  non-compile session; `stale` flips on a node change; symlink
  materialization for home and neighbours.
- Overview: `proposal` events carry `refs`; the review lists them.
- Human: a weekly overview run on the Workflow organization, one compile
  on a process node, Codex and Claude both invoking the skill.

## Phases

1. **Routines**: table, scheduler, review policy, `run now`, Rutiny tab,
   Přehled "Na pozadí".
2. **Skills**: `node_skills`, compile routine, publish tool, distribution
   and symlinks, `skill_path` in scope tools, header badge.
3. **Overview agent**: `proposal` event type, built-in brief, organization
   Rutiny action.
4. **Docs**: `sites/docs` concepts "Routines and skills", reference for
   the new tools and routes.

## Known gaps, accepted

- A skill compiled by one runner is consumed by all three; quality
  differences between runners are visible in the output and fixed by
  rerunning, not by per-runner briefs.
- `.portuni-skills` is one Drive folder per organization; a node shared
  across organizations (edges only, never membership) has its skill in
  the organization it belongs to.
- No scheduler in local mode by design; a person who wants the overview
  agent weekly on a local workspace presses Spustit teď.
