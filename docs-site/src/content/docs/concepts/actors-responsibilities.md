---
title: Actors & Responsibilities
description: Who does what – mapping people, automations, and the work they own.
---

[POPP](/concepts/popp/) describes the *shape* of an organization. Actors and responsibilities describe *who does the work* and *what they're responsible for*. The two layers are orthogonal: the same project can have one set of nodes in the graph and a completely different set of people and automations attached to it.

## Actors

An **actor** is anyone or anything that does work in an organization. Two kinds:

| Type | What it is | Example |
|------|-----------|---------|
| `person` | A human – may be a registered Portuni user, or just a name on the map | Honza, Lucie, "the new account manager we'll hire" |
| `automation` | A named functional unit that does work without a human | "Lead enrichment script", "Daily Slack digest" |

Actors are scoped per organization. The same person who works in two organizations gets two actor records – one per org. This keeps responsibility maps clean and aligned with the [organization invariant](/concepts/organization-invariant/).

### Placeholders

People can be **placeholders** – an actor record for a role that exists in the org's design but isn't filled yet. "The CFO we plan to hire," "a second account manager." They behave like real people in every way except they have no `user_id` linking back to a registered Portuni user. Once the role is filled, the placeholder is updated with the user link.

Why bother? Because work doesn't wait for hiring. Mapping a process or project to "this responsibility belongs to a CFO who isn't here yet" is honest – it surfaces the dependency before it becomes a crisis.

### Automations as first-class actors

An automation – a Make scenario, an n8n workflow, a CI script – gets the same treatment as a person. It has a name, an owner organization, and can hold responsibilities just like a human.

This matters because in a [symbiotic workflow](/concepts/design-principles/#symbiotic-work-not-full-automation), the same process can be done by a human, an agent, or an automation. Treating all three as actors means the process map stays the same regardless of who or what is currently executing it.

## Responsibilities

A **responsibility** is a unit of work attached to a node (project, process, or area). Examples:

- On a project: "weekly client status update", "sign off on deliverable"
- On a process: "respond to incoming partner emails within 2h", "run quarterly review"
- On an area: "maintain hiring pipeline freshness", "own quarterly OKR cadence"

Responsibilities live on the node they describe. Moving a project doesn't move its responsibilities – they travel with the project automatically.

### Assignment is many-to-many

A responsibility can be assigned to zero, one, or many actors. An actor can hold many responsibilities across many nodes. The model is intentionally loose:

- **Zero assignees is valid.** "This needs to happen but no one owns it yet" is a real and useful state. Surfacing it on the map is the point.
- **Multiple assignees is valid.** Joint ownership is a real pattern – co-leads, primary plus backup, person plus their automation.

The shape of the data is `(responsibility, actor)` pairs. Adding or removing a pair never affects other assignments.

### Sort order

Responsibilities on a node are ordered – the order is meaningful (most important first) and editable. This shows up everywhere a responsibility list is rendered: tool responses, the frontend, the SessionStart context.

## Owner of an entity

Separate from the responsibility list, every node can have a single **owner** – the actor primarily accountable for the node as a whole. Owner is not "the only person involved"; it's "the one who answers the phone if something's wrong."

Constraints on owner:

- Must be an actor of type `person`.
- Must have a `user_id` (a real registered Portuni user, not a placeholder).
- Must belong to the same organization as the node.

Automations can hold responsibilities, but they cannot be owners. An automation is something *under* an owner, not the owner itself.

## Data sources and tools

Two more attribute lists hang off project/process/area nodes:

- **Data sources** – what the node reads from. Examples: an Asana board, a BigQuery dataset, a CRM segment, a recurring report. Each entry has a name, a kind, and an `external_link` (plain URL – never a connection string with credentials).
- **Tools** – what the node uses to do its work. Examples: Asana, Figma, Notion, a specific MCP server. Each entry has a name and an `external_link`.

These are descriptive metadata – they tell agents and humans "to work on this node, you'll be touching these things." They are not credentials, not configurations, and not edges in the POPP graph.

## How this shows up in tool output

`portuni_get_node` and `portuni_get_context` (depth 0) include actors, responsibilities, data sources, and tools as enriched fields. The SessionStart hook surfaces the node's owner and top responsibilities so an agent walking into a session knows who's who without asking.

## Tool reference

For exact parameters and return shapes, see:

- [Reference: Actors](/reference/actors/)
- [Reference: Responsibilities](/reference/responsibilities/)
