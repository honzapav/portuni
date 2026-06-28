---
title: Design Principles
description: Why Portuni works the way it does – the small set of rules every other decision derives from.
---

Portuni is opinionated. The architecture, the tool surface, even what's deliberately missing – all of it follows from a handful of principles. Knowing them makes the rest of the system feel obvious; ignoring them leads to PRs that get bounced.

## Human decides, agent assists

Every piece of knowledge enters Portuni because a person decided it was worth keeping. The agent can suggest, edit, draft, and organize – but the act of saving an event, attaching a file, or creating an edge is a human-gated decision. There is no background capture, no silent ingestion of chat transcripts, no "I noticed something interesting and saved it for you."

This is what makes Portuni's graph trustworthy: every node, edge, and event was put there on purpose. If you didn't decide it, it isn't in there.

## Intentional, not automatic

Knowledge transfer between sessions is `git pull`, not iCloud. The pattern across the whole tool surface is:

- `portuni_pull` to fetch a teammate's update
- `portuni_log` to record a decision
- `portuni_store` to attach a file

Every one of those is explicit. There is no daemon polling for changes, no auto-sync of "everything you might want to see," no subscription-style updates. The agent reaches for context when it needs context, and the user is in the loop.

The same shape applies to file sync: `portuni_status` shows what's drifted, but it never reconciles on its own. The user sees the diff and acts.

## Tasks can be autonomous after a trigger

"Intentional" is about how knowledge moves, not about how much work the agent does. Once a user kicks off a task – "draft a summary of last week's events on this project," "set up the mirror folder structure for these three new processes" – the agent can run end-to-end without asking permission for each step.

Autonomy is downstream of an explicit trigger. It is never an ambient default.

## Predictable structure, minimal hierarchy

The visible parts of Portuni – folder names, mirror layouts, sync paths – are flat and predictable. Two-level structure (org / type-plural / node) and then nothing. No deep nesting, no per-team variations, no "we organize Drive a bit differently."

Predictability is the prerequisite for trust. If you can find a project's folder without asking, you start to believe the rest of the system works the same way. If you can't, you don't.

This is also why node renames don't break paths: every node has an immutable [`sync_key`](/concepts/mirrors/), and every path is built from it.

## Edges emerge from work

Edges in the graph aren't a one-time onboarding ceremony. They're proposed at project initiation (from descriptions), refined during execution (from events and decisions), and crystallized at closure (from learnings). In Phase 1 they're managed manually; later phases will let background AI processes suggest and auto-create edges as a byproduct of using the system.

The architecture is designed from the start to support this: the graph is small enough to walk, edges are typed, and the [POPP framework](/concepts/popp/) gives a stable vocabulary for what connects to what.

## Thin core, plays well with others

Portuni owns the knowledge graph and the relationships between things. It does not own task management (that's Asana / Linear), spreadsheets (Sheets / Airtable), or rich documents (Docs / Notion). It links them through edges, mirrors, and external URLs – and stays out of their way.

The pluggable [file sync](/concepts/mirrors/) layer is the same idea applied to storage: Drive is the first concrete adapter, but Dropbox / S3 / FS / WebDAV / SFTP slot in through the same interface. No backend lock-in.

## Symbiotic work, not full automation

There is a middle space between "I do everything myself, the AI gives suggestions" and "the system does everything without me." Portuni lives in that middle space:

- **I stay at the wheel.** I think, I direct, I decide.
- **The agent amplifies what I can do.** It searches, drafts, edits, organizes.
- **A task in a process can be done by a human, an agent (with a human), or an automation (without a human).** Three execution modes, one process – no buzzwords needed.

This is why the [scope model](/concepts/scope-enforcement/) constrains what an agent can touch on its own: the goal isn't to keep the agent from helping, it's to keep the human firmly in the loop on what matters.

## Consequences

If a feature feels like it's fighting one of these principles, it's probably the wrong feature. A few examples of things Portuni explicitly does **not** do:

- Background sync of files into the graph
- Auto-discovery of edges from chat history
- Cross-organization "interesting things" feeds
- Hidden state that the user can't audit

Everything Portuni does, you asked for.
