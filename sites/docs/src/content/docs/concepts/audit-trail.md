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
| `user_id` | The Portuni user who initiated the action |
| `action` | The mutation – `create_node`, `update_node`, `connect`, `disconnect`, etc. |
| `target_type` | `node`, `edge`, `event`, `file`, `actor`, `responsibility`, `remote`, ... |
| `target_id` | The ID of the affected entity |
| `detail` | Optional JSON with the mutation's key parameters – typically the tool's input arguments (e.g. `{ input: args }` for updates, or the create parameters for creates) |
| `timestamp` | Wall-clock timestamp |

There are no before/after snapshots. The `detail` column records *what was asked for*, not a diff of the entity's state – reconstructing "what the node looked like before" means walking earlier audit entries, not reading one row.

## Why append-only

Two reasons.

**Trust.** If audit entries can be edited or deleted, they aren't audit entries – they're notes. The whole point is that nobody (including Portuni itself) can rewrite history after the fact. The graph might be wrong, the audit log is what actually happened.

**Multi-user identity.** With multiple users and multiple LLM agents acting on their behalf, "who did this on whose behalf, and from which session?" is the question that determines whether an unexpected change was intentional. An editable audit log can't answer that.

## What it's NOT for

Audit log is not a general event store. It tracks *changes to structural data*, not knowledge. The distinction:

- **Audit log:** "User X created edge `belongs_to` from project Y to org Z at 14:32."
- **[Events](/concepts/events/):** "Decision: we're using Turso instead of Postgres."

Events are part of the graph's content – they're what people actually want to read later. Audit log is forensic – nobody reads it for fun, but when a question comes up, it's the only thing that matters.

## User identity

Which user an audit row is attributed to depends on the auth mode. With `PORTUNI_AUTH_MODE=google`, every request resolves a real user identity (Google login, session or device token) before it touches the database, so audit rows carry the actual user who made the change. With the default `PORTUNI_AUTH_MODE=env` (solo bearer token), every action is attributed to the single solo user – fine for a one-person instance, meaningless for a team.

What is not yet recorded is the *agent* identity – which harness (Claude / Codex / a specific automation) executed the action on the user's behalf. The trail captures who authorized, not what executed. Entries written in env mode keep showing the solo user; there is no backfill.

## Querying the trail

Audit log is a regular table – any SQL client connected to your Turso (or local SQLite) database can query it. Common queries:

- **What happened to this node?** `SELECT * FROM audit_log WHERE target_id = '...' ORDER BY timestamp;`
- **What did user X do today?** `SELECT * FROM audit_log WHERE user_id = '...' AND timestamp >= date('now');`
- **What got deleted?** `SELECT * FROM audit_log WHERE action LIKE 'delete_%' ORDER BY timestamp DESC;`

There is intentionally no MCP tool for querying audit log. Audit data is for humans investigating, not for agents to discover from. If an agent needs historical context, it should be reading [events](/concepts/events/) instead.

## Storage growth

Audit rows are small (a few hundred bytes each, larger when the `detail` JSON carries big inputs), and a normally-used Portuni instance writes maybe a few hundred per day per user. Turso handles this comfortably for the foreseeable future. There is no automatic pruning – pruning audit data defeats the point of having it.

If long-term storage becomes an issue (multi-year retention on a busy team), the right answer is to archive to cold storage, not to truncate.
