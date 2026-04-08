---
title: Local Mirrors
description: How nodes map to local filesystem folders.
---

Each node can have a local workspace folder. This mapping is stored per-user in the `local_mirrors` table.

## Mirror structure

When you call `portuni_mirror`, a folder is created:

```
{PORTUNI_WORKSPACE_ROOT}/{slug}/
  outputs/     -- final deliverable files
  wip/         -- work-in-progress files
  resources/   -- reference materials
```

Organization workspace folders additionally contain type-based subdirectories:

```
workflow/
  projects/
  processes/
  areas/
  principles/
```

## Path resolution

When the agent needs a node's local folder:

1. Look up stored `local_path` in `local_mirrors`
2. If path exists on disk -- use it
3. If path doesn't exist -- ask the user, update the mapping
4. If no mapping -- node is remote-only

No scanning, no guessing. One answer resolves it permanently.

## File management

Files are stored intentionally, like git commits:

| Tool | Action |
|------|--------|
| `portuni_store` | Copy file into mirror folder, register in DB |
| `portuni_pull` | List files for a node with paths and statuses |
| `portuni_list_files` | List files across all nodes |

Files have two statuses:
- **wip** -- stored in `wip/` subdirectory
- **output** -- stored in `outputs/` subdirectory

## Context hook

The `/context` endpoint resolves a filesystem path to a graph node. The SessionStart hook (`scripts/portuni-context.sh`) uses this to automatically show graph context when you start working in a mirror folder. See [Setup → SessionStart hook](/getting-started/setup/#sessionstart-hook) for registration details, including how to run the hook against multiple Portuni instances.
