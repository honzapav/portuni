---
title: Symbiotic Workflows
description: How to actually use Portuni day-to-day with an AI agent – the loop, the patterns, and the anti-patterns.
---

Portuni is built for the middle space between "I do everything, the agent gives suggestions" and "the agent runs everything without me." This guide is the practical view of how to live in that middle space – the shape of a normal session, the patterns that work, and the things that quietly slow you down.

For the philosophy behind this, see [Design Principles](/concepts/design-principles/).

## The basic loop

A typical session has four beats, in roughly this order:

1. **Anchor.** Move into the mirror folder for the node you're working on. The SessionStart hook automatically injects the graph context (current node, owner, top responsibilities, recent events) so you don't have to brief the agent from scratch.
2. **Pull what you need.** If the agent asks for context that isn't in the SessionStart payload, name the node ("look at process Partner Account Management") or use `portuni_get_context` with depth 1. Don't dump the whole graph into the session.
3. **Work.** Edit, draft, search, refactor – whatever the task needs. The agent is your hands; you decide what to do.
4. **Commit knowledge.** Before ending the session, log what's worth keeping. Decisions go into events (`portuni_log`). New deliverables go through `portuni_store`. If you're done with a blocker, `portuni_resolve` it.

The loop is intentionally cheap to repeat. Anchoring takes seconds. Pulling is one MCP call. The point is that the agent always knows where it is, and you always know what's been captured.

## Where to start a session

Always start in a mirror folder. The SessionStart hook only fires when `cwd` is inside a registered mirror, and a session that starts outside one means the agent has no anchor – every read needs to be explicit, every "where am I" question is unnecessary friction.

If you're going to work on multiple nodes back to back, do them in separate sessions. The agent's mental model is sharper when it has one home node, not three.

## Pulling context, not dumping it

The temptation, especially early on, is to give the agent everything: "here's the whole graph, here's every event from the last month, figure out what to work on." This produces worse output, not better. Pulling deliberately means:

- **Use `portuni_get_context` at depth 1** for the immediate neighborhood. Default to this; expand only when you can name the reason.
- **Use `portuni_get_node` for full detail** on a single node when you actually need owner, responsibilities, data sources, files, and recent events all at once.
- **Use `portuni_list_events` with filters** when you need history – by `since`, by `type`, by `status`. Avoid open-ended "show me everything" queries.

The agent doesn't need the whole graph to be useful. It needs the right slice.

## Logging events well

Events are what makes a session memorable for the *next* session. The bar:

- Decisions, discoveries, blockers, milestones, references – yes.
- Routine actions visible in code or git – no.

A good event answers the question "if a teammate (or my future self) walks into this in a week, what would surprise them?" Renaming a file isn't surprising; deciding to switch from Postgres to Turso is.

If you're not sure, ask the agent: "is this worth logging?" The agent's answer is usually right because it sees what's in the graph already and what isn't.

## Files and mirrors

The pattern is intentional, not automatic – exactly like git:

| What you mean | What to call |
|---------------|--------------|
| "Save this file as a tracked deliverable" | `portuni_store` (default `wip`, switch to `output` when finalizing) |
| "What's the latest from the team on this node?" | `portuni_pull` with `node_id` (preview), then with `file_id` to actually pull |
| "Did anything drift?" | `portuni_status` |
| "Add this folder of existing work into Portuni" | `portuni_adopt_files` |

Don't try to use `portuni_mirror` and then manually `cp` files into the folder hoping they'll be tracked. They won't. `portuni_store` is the moment of intent.

## When the agent should be autonomous

After a clear trigger – "draft a one-page summary of last week's events on this project," "set up the responsibility list for these three new processes" – let the agent run. Don't approve every step. Read the result and react.

Autonomy works when the trigger is concrete and the work is bounded. It doesn't work for open-ended "improve things" prompts; those bleed into changes you didn't expect.

## When to gate the agent

Anything that crosses an organizational boundary, or touches files outside the current mirror, deserves explicit confirmation:

- Cross-organization edges
- Renaming or deleting tracked files
- Setting up new remotes or routing rules
- Changing lifecycle state on a project (kickoff -> done is a real moment, not a routine update)

Most of these tools are confirm-first by design. Lean into that – the prompt to confirm is the chance for you to catch a misalignment between what the agent thinks it's doing and what you actually want.

## Anti-patterns

**Editing files in a sibling mirror.** If you're in the Goldea Presale project and the agent decides to "also update" Partner Account Management's docs, that's an out-of-scope write. Once [scope enforcement](/concepts/scope-enforcement/) ships, this is denied by default; until then, watch for it manually and roll it back.

**Auto-pulling everything at session start.** The SessionStart hook gives you depth 1 for a reason. Pulling depth 3 "just in case" produces a noisy context window and worse responses.

**Logging everything as an event.** If half your events are "ran tests, all green," the next session will skip past them and miss the actual decisions. Be selective.

**Treating the agent as a transcript dumper.** "Here's a 2,000-word chat – figure it out" rarely produces the right structure in Portuni. Decide what's worth keeping, then ask the agent to log it cleanly.

**Skipping the mirror.** Working in a non-mirror folder and remembering to push files manually is the path to drift. Run `portuni_mirror` first, then work; you'll get the SessionStart context, the routing, and the audit trail for free.

## A worked example

You're starting work on a new client engagement under the Workflow org. The flow:

1. **Create the project node:** `portuni_create_node { type: "project", name: "Acme Onboarding", organization_id: "<workflow-id>", lifecycle_state: "kickoff" }`. The atomic create writes the node + its `belongs_to -> Workflow` edge in one transaction.
2. **Create the mirror:** `portuni_mirror { node_id: "<acme-id>", targets: ["local"] }`. Folder appears at `~/Workspaces/portuni/workflow/projects/acme-onboarding/` with `outputs/`, `wip/`, `resources/`. The remote folder auto-scaffolds in the routed Drive.
3. **`cd` into the mirror folder.** SessionStart hook fires; agent has the project context.
4. **Set up the responsibility list:** `portuni_create_responsibility { node_id, title: "Weekly status update", assignee_actor_ids: [...] }`. Repeat for each.
5. **Apply the relevant processes:** `portuni_connect { source: <acme-id>, relation: "applies", target: <process-id> }`.
6. **Drop the kickoff brief in:** `portuni_store { node_id, local_path, status: "wip" }`. File ends up in `wip/`, gets uploaded to the Workflow Projects Hub Shared Drive.
7. **Log the kickoff event:** `portuni_log { node_id, type: "milestone", content: "Project kicked off; first deliverable due ..." }`.

End of session, you can leave. Next time you open the folder, the SessionStart hook surfaces the kickoff event, the responsibility list, and the connected processes – the agent picks up exactly where you left off.

## See also

- [Design Principles](/concepts/design-principles/) – the philosophy
- [POPP](/concepts/popp/) – the node types you'll be creating
- [Actors & Responsibilities](/concepts/actors-responsibilities/) – the people layer
- [Setting up remotes](/guides/setting-up-remotes/) – before any of this works for files, you need a remote
