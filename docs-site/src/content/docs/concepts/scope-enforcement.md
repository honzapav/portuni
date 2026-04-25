---
title: Scope Enforcement
description: How a session's reach is bounded – what an agent can read and where it can write.
---

:::caution[In design – not yet implemented]
This page describes a design that is specified but not yet implemented in code (see `docs/superpowers/specs/2026-04-24-scope-model.md` in the repo). The current behavior is unconstrained: agents can read any node and write to any directory the harness allows. This page documents the intended end state so contributors and users can shape it. Don't rely on any of these guarantees yet.
:::

A Portuni session always has two boundaries: what files the agent can write to, and what nodes it can read from. Without bounds, the agent in a "Goldea Presale" project session can edit files in a sibling process mirror, or list every project across every organization the user can see. Neither is the intended behavior.

The scope model adds two enforceable, complementary mechanisms – one for filesystem writes, one for graph reads – both anchored on the same idea: the **session home node**.

## Session home node

When a session starts, Portuni picks a single anchor:

- It looks at the current working directory.
- It walks upward through registered local mirrors and finds the nearest ancestor that is a Portuni mirror.
- The node owning that mirror becomes the **session home node**.

If `cwd` isn't inside any mirror, the session has no home node. Scope enforcement degrades to "warn only" – the agent is working outside Portuni territory and Portuni can't meaningfully bound it.

Everything else in this page is built on top of this single anchor.

## Filesystem write scope – three tiers

Writes divide into three concentric zones, each with different default behavior:

```
+---------------------------------------------------------------+
| Tier 3 – Outside PORTUNI_ROOT                                 |
| e.g. ~/Desktop, ~/.ssh, /tmp, unrelated repos                 |
| -> HARD FLOOR: always ask, no exceptions                      |
+---------------------------------------------------------------+
       ^
       |
+------+--------------------------------------------------------+
| PORTUNI_ROOT (e.g. ~/Dev/projekty/)                           |
|  +----------------------------------------------------------+ |
|  | Tier 2 – Inside PORTUNI_ROOT, outside current mirror      | |
|  | e.g. session home is workflow/projects/goldea-presale/,  | |
|  |      target is workflow/processes/partner-account-mgmt/  | |
|  | -> DENY by default; bypass with explicit confirmation    | |
|  +----------------------------------------------------------+ |
|  +----------------------------------------------------------+ |
|  | Tier 1 – Current mirror                                   | |
|  | e.g. workflow/projects/goldea-presale/**                  | |
|  | -> FREE WRITE                                             | |
|  +----------------------------------------------------------+ |
+---------------------------------------------------------------+
```

`PORTUNI_ROOT` is a single environment variable that names the directory containing every Portuni mirror on the machine. It defaults to the nearest common ancestor of all registered mirrors.

### How it's enforced

Portuni does **not** intercept filesystem operations at runtime – cross-harness interception is fragile and easy to bypass. Instead, when a mirror is created or renamed, Portuni writes per-harness configuration into `local_path`:

- **`.claude/settings.json`** – `permissions.allow` for the current mirror, `permissions.deny` for every other mirror in the registry plus a fallback denying writes outside `PORTUNI_ROOT`.
- **`.codex/config.toml`** – `sandbox_workspace_write.writable_roots = [<this mirror>]`. Codex's Seatbelt / Landlock enforces this at the kernel.
- **`CLAUDE.md` / `AGENTS.md` / `.cursor/rules`** – plain-text rules so the agent has the same picture even if the harness config is missing.

When the registry changes (mirror added, removed, or renamed), every affected mirror's config is regenerated.

### Backstop hook

A `PreToolUse` hook (`portuni-guard`) is shipped optionally. When installed, it queries Portuni's `/scope` endpoint before every `Edit`, `Write`, or `NotebookEdit` and returns one of:

- Tier 1 -> allow
- Tier 2 -> deny with "target is in sibling mirror `<name>`; run from that mirror or confirm the cross-mirror write"
- Tier 3 -> deny with "target is outside `PORTUNI_ROOT`; confirm the write is intended"

This catches drift in the declarative config, harness bugs, and cases where the config was never written.

### What this doesn't cover

- Writes inside the current mirror that aren't part of the node's artifacts (the user's own scratch files that happen to live there). Scope is directory-based, not artifact-based.
- Writes via `Bash` commands that bypass the harness's file tools. Some shell tricks slip past Seatbelt and Landlock; neither sandbox is complete.
- Hard isolation. For high-stakes work (contractor access, sensitive client data), the recommended path is Dagger Container Use – one container per node, no path escape by construction. Portuni doesn't ship that; it points at it.

## Read scope – session scope set

Graph reads are bounded by a **session scope set** – the set of node IDs the agent is allowed to fetch in this session. Initially narrow, expanded only by explicit, audited actions.

### Initial scope set

At session start the scope set contains:

1. The session home node.
2. Every node directly connected to it by an edge (depth 1, both directions).

Without a home node (cwd outside any mirror), the scope set starts empty. Every read requires expansion.

### Three ways to expand

| Path | Trigger | User confirmation |
|------|---------|-------------------|
| User-initiated pull | User names a node in the prompt ("look at project Evoluce") | Not needed – the user already asked |
| Agent-initiated expansion | Agent calls a read tool with an out-of-scope node | Required – server elicits confirmation via MCP |
| Connection-following | Agent walks an edge from an in-scope node | Allowed if the neighbor is within depth 1 of any in-scope node |

Every expansion is logged to the audit trail with the reason (the user's quoted phrase, or the agent's stated rationale).

## Why this is its own page (and not a permission system)

Scope is **orthogonal** to permissions. Permissions (visibility, Google Groups membership) decide what a user is allowed to see at all. Scope decides what an in-progress session is currently focused on – a second, intentionality-shaped filter applied on top of permissions.

A user with read access to every node in their org still gets a narrow scope set when they start a session in one project. The agent isn't omniscient by default; it's focused, and expansion is auditable.

## Implementation status

| Piece | Status |
|-------|--------|
| Spec | Written – `docs/superpowers/specs/2026-04-24-scope-model.md` |
| Session home node detection | Not yet implemented |
| Per-harness config generation on `register_mirror` | Not yet implemented |
| `/scope` endpoint + `portuni-guard` hook | Not yet implemented |
| Session scope set + `portuni_expand_scope` | Not yet implemented |
| Audit entries for scope expansions | Not yet implemented |

When this lands, this page will lose the warning banner.
