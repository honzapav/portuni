---
title: Local Mirrors
description: How nodes map to local filesystem folders.
---

A mirror is the bridge between a node in Portuni's graph and an actual folder on your disk. Each mirror lives per-user in the `local_mirrors` table, so everyone on the team can have their own layout without stepping on each other.

## What's inside a mirror

When you call `portuni_mirror`, Portuni creates a folder structure for you:

```
{PORTUNI_WORKSPACE_ROOT}/{slug}/
  outputs/     -- final deliverables
  wip/         -- work in progress
  resources/   -- reference material
```

For organization-level workspaces, Portuni adds type-based subdirectories on top:

```
workflow/
  projects/
  processes/
  areas/
  principles/
```

## How a path gets resolved

When an agent needs to know where a node lives on disk, Portuni goes through a short sequence:

1. Look up the stored `local_path` in `local_mirrors`.
2. If that path exists on disk, use it.
3. If the path is recorded but doesn't exist, ask the user and update the mapping.
4. If no mapping exists at all, treat the node as remote-only.

No scanning, no guessing. One answer settles it for next time.

## Intentional file storage

Files get saved the same way you'd make a git commit – on purpose, with meaning. The three tools that matter:

| Tool | What it does |
|------|--------------|
| `portuni_store` | Copy a file into the mirror folder and register it in the database |
| `portuni_pull` | List files attached to a node, with paths and statuses |
| `portuni_list_files` | List files across every node with filters |

Every file has one of two statuses:

- **wip** – stored in the `wip/` subdirectory; still being worked on
- **output** – stored in the `outputs/` subdirectory; the final, shareable version

## The context hook

Portuni exposes a `/context` endpoint that resolves a filesystem path back to the graph node it belongs to. The `SessionStart` hook (`scripts/portuni-context.sh`) uses this to automatically show you the right graph context when you start work inside a mirror folder. See [Claude Code → The SessionStart hook](/clients/claude-code/#the-sessionstart-hook) for how to register it – including how to handle multiple Portuni instances at once.
