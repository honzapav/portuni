---
title: Audit Trail
description: Why every mutation is logged, what's recorded, and how to read the trail.
---

Every mutation in Portuni – `create`, `update`, `connect`, `disconnect`, `store`, `move`, `delete`, `archive` – writes a row to `audit_log`. The table is append-only and immutable from the application side: no tool deletes or updates an audit row.

This sounds like overhead until you remember what Portuni is actually holding: an organization's structural map, used by both humans and agents. The graph is only trustworthy if you can answer "who changed this, when, and why" for any node, edge, or file. Audit log is the answer.

## What's recorded

Each row captures:

| Field | Notes |
|-------|-------|
| `id` | ULID – ordered, unique, sortable by time |
| `user_id` | The Portuni user who initiated the action (`SOLO_USER` in Phase 1) |
| `action` | The mutation – `create_node`, `update_edge`, `store_file`, etc. |
| `entity_type` | `node`, `edge`, `event`, `file`, `actor`, `responsibility`, `remote`, ... |
| `entity_id` | The ID of the affected entity |
| `before` | JSON snapshot of the entity's state before the change (for updates and deletes) |
| `after` | JSON snapshot of the entity's state after the change (for creates and updates) |
| `created_at` | Wall-clock timestamp |

The `before` / `after` pair makes audit entries diff-able – you can render a clean "what changed" view without having to walk historical state yourself.

## Why append-only

Two reasons.

**Trust.** If audit entries can be edited or deleted, they aren't audit entries – they're notes. The whole point is that nobody (including Portuni itself) can rewrite history after the fact. The graph might be wrong, the audit log is what actually happened.

**Multi-LLM identity.** Phase 2 introduces multiple users and multiple LLM agents acting on behalf of those users. When something unexpected appears in the graph, "which agent did this on whose behalf, and from which session?" is the question that determines whether it was intentional. An editable audit log can't answer that.

## What it's NOT for

Audit log is not a general event store. It tracks *changes to structural data*, not knowledge. The distinction:

- **Audit log:** "User X created edge `belongs_to` from project Y to org Z at 14:32."
- **[Events](/concepts/events/):** "Decision: we're using Turso instead of Postgres."

Events are part of the graph's content – they're what people actually want to read later. Audit log is forensic – nobody reads it for fun, but when a question comes up, it's the only thing that matters.

## Phase 1 limitations

In Phase 1 there is exactly one user (`SOLO_USER`). All audit rows attribute every action to that user, regardless of which agent or session triggered it. This isn't a security claim – it's a placeholder until Phase 2 introduces real user identity.

When Phase 2 lands, Portuni will start recording the agent identity (Claude / Codex / Gemini / a specific automation) alongside the user, so the trail captures both *who* authorized the action and *what* executed it. There is no plan to backfill Phase 1 entries; they'll keep showing the solo user.

## Querying the trail

Audit log is a regular table – any SQL client connected to your Turso (or local SQLite) database can query it. Common queries:

- **What happened to this node?** `SELECT * FROM audit_log WHERE entity_id = '...' ORDER BY created_at;`
- **What did user X do today?** `SELECT * FROM audit_log WHERE user_id = '...' AND created_at >= date('now');`
- **What got deleted?** `SELECT * FROM audit_log WHERE action LIKE 'delete_%' ORDER BY created_at DESC;`

There is intentionally no MCP tool for querying audit log. Audit data is for humans investigating, not for agents to discover from. If an agent needs historical context, it should be reading [events](/concepts/events/) instead.

## Storage growth

Audit rows are small (a few hundred bytes each, larger when `before`/`after` snapshots are big), and a normally-used Portuni instance writes maybe a few hundred per day per user. Turso handles this comfortably for the foreseeable future. There is no automatic pruning – pruning audit data defeats the point of having it.

If long-term storage becomes an issue (multi-year retention on a busy team), the right answer is to archive to cold storage, not to truncate.
