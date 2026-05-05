---
title: Local Mirrors
description: How nodes map to local filesystem folders, per device.
---

A mirror is the bridge between a node in Portuni's graph and an actual
folder on your disk. Mirrors are **per device**: each machine has its own
view of which nodes are present and where, so two collaborators can have
totally different layouts without stepping on each other.

## What's inside a mirror

When you call `portuni_mirror`, Portuni creates a folder structure for you:

```
{PORTUNI_WORKSPACE_ROOT}/{org-sync-key}/{type-plural}/{node-sync-key}/
  outputs/     -- final deliverables
  wip/         -- work in progress
  resources/   -- reference material
```

For organization-level workspaces, Portuni adds type-based subdirectories
on top so child nodes can attach beneath them:

```
workflow/
  projects/
  processes/
  areas/
  principles/
```

The folder layout is anchored on each node's immutable `sync_key`, not
on its display name. Renaming a node does NOT move its folder or change
its remote path.

## Per-device registry

The shared Turso graph DB does NOT track mirror paths anymore (migration
011 dropped the `local_mirrors` table from Turso). Each device keeps its
own SQLite registry at `~/.portuni/sync.db` (`local_mirrors` table),
together with `file_state` (local hash cache) and `remote_stat`
(short-lived remote metadata cache).

This split has two consequences:

1. **No global state about your laptop.** Personal disk paths don't
   leak into a shared database, and you can keep different parents on
   different machines.
2. **Stale rows are tolerated.** When a node is purged on one device,
   the corresponding registration on another device sticks around until
   that device next looks at it. Readers (`portuni_get_context`,
   `/context`, `portuni_status`) skip stale rows and fire a
   fire-and-forget cleanup; the user-visible result is correct, the
   database self-heals.

## How a path gets resolved

When something needs to know where a node lives on disk, Portuni:

1. Looks up the registration in the per-device `local_mirrors` table.
2. Verifies the node still exists in the shared graph -- if not, the
   row is treated as stale (skipped + cleaned up).
3. Returns the registered path. There is no on-disk existence check at
   this layer; the caller decides whether absence means "not yet
   created" or "deleted out from under us".

For files, the on-disk path is **derived** at read time:
`{mirror_root}/{section}/{subpath}/{filename}`, computed from the
file's `remote_path` minus the node's remote root prefix. The `files`
table no longer stores `local_path` (migration 012); persisting it
across devices and renames was actively misleading.

## Intentional file storage

Files are saved the same way you'd make a git commit -- on purpose,
with meaning, and bound to a remote. The relevant tools:

| Tool | What it does |
|------|--------------|
| `portuni_store` | Copy a file into the mirror folder, upload it via the routed remote, register it in `files`. |
| `portuni_pull` | With `file_id`, download the remote version into the mirror. With `node_id`, preview each file's status without modifying anything. |
| `portuni_status` | Scan tracked files + (optional) discover new local / new remote files. |
| `portuni_list_files` | List files across every node with derived `local_path`. |

Every file has one of two statuses:

- **wip** -- stored under `wip/`; still being worked on.
- **output** -- stored under `outputs/`; the final, shareable version.

## Auto-seed on connect

Each mirror's `.mcp.json` and `.codex/config.toml` (written by
`portuni_mirror`) point the MCP URL at the Portuni server with
`?home_node_id=<id>` baked in. When any MCP-capable harness opens a
session against that URL from inside the mirror, the server seeds the
read scope with the home node and its depth-1 neighbors before the
first tool call -- no hook, no harness-specific glue. See
[Scope enforcement -> Session home node](/concepts/scope-enforcement/#session-home-node)
for the details.
