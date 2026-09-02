---
title: Local Mirrors
description: How nodes map to local filesystem folders, per device.
---

A mirror is the bridge between a node in Portuni's graph and an actual
folder on your disk. Mirrors are **per device**: each machine has its own
view of which nodes are present and where, so two collaborators can have
totally different layouts without stepping on each other.

## What's inside a mirror

A mirror is usually created implicitly the first time an agent terminal is
launched for a node. In the desktop app, the node detail header also offers
a direct "Vytvořit pracovní složku" button when the node has no mirror on
this device yet, so you can create the folder without opening a terminal
first. The Files tab offers the same action: a node with remote files but
no mirror on this device shows a banner instead of the sync button ("Tento
uzel nemá na tomto počítači pracovní složku..."); creating the folder from
there reveals "Synchronizovat" so you can pull the existing files in
explicitly.

When you call `portuni_mirror`, Portuni creates a folder structure for you:

```
{PORTUNI_WORKSPACE_ROOT}/{org-sync-key}/{type-plural}/{node-sync-key}/
  outputs/     -- final deliverables
  wip/         -- work in progress
  resources/   -- reference material
```

Organization-level mirrors get type-based subdirectories **instead of** the
wip/outputs/resources sections, so child nodes can attach beneath them:

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
own SQLite registry at `{PORTUNI_WORKSPACE_ROOT}/.portuni/sync.db`
(`local_mirrors` table), together with `file_state` (local hash cache)
and `remote_stat_cache` (short-lived remote metadata cache).

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

## File state: deterministic metadata, intentional bytes

File handling has two halves that are easy to conflate.

**File-state metadata is kept current automatically.** A mirror watcher
observes every mirror folder — including mirrors registered while it is
running, which it picks up immediately — and reacts to each disk change: a new file in a
tracked section is registered in the local sync DB (local-only — no upload,
no graph knowledge created), and edits and deletes are reconciled into the
cached local hash. The result is that sync status in the UI is always
correct, without any agent calling `portuni_status` or `portuni_store`. A
freshly registered file simply shows as "needs push" until someone
deliberately pushes it. The watcher runs by default in the desktop sidecar;
on a standalone server it is opt-in via `PORTUNI_WATCH_MIRRORS=1`.

**A watcher failure surfaces in the UI, not only the sidecar log.** When
registering or reconciling a file fails (a misconfiguration, an unreadable
file, a mirror that moved away), it used to reach only
`~/Library/Logs/ooo.workflow.portuni/sidecar-<workspace>.log` — the user
just saw that files "were not there". A bounded per-node buffer of recent
failures (path, error message, timestamp) now backs a warning banner on the
node's Files tab and a workspace-wide banner on Nastavení → Synchronizace
(`GET /sync/health`, and the `watcher_errors` field on
`GET /nodes/:id/sync-status`), so a misconfiguration is diagnosable without
opening logs. A later successful reconcile of the same path clears it.

The watcher also understands the two everyday shell operations:

- **`mv` inside a mirror** is recognized by inode identity (the rename
  keeps it on the same volume) and applied as a real move — one record,
  remote rename with the Drive file ID preserved — instead of a
  duplicate registration. A content-hash check guards the pairing; a
  cross-volume move falls back to plain registration.
- **`rm` of a file that was never pushed** unregisters it from Portuni
  entirely (the record was metadata-only). Deleting a pushed file keeps
  the record and the remote copy and shows as "deleted locally" for an
  explicit decision.

Deletions made elsewhere (web UI, MCP tool, another device, or straight in
Drive) propagate back to every device through delete tombstones: an
untracked disk copy that matches a tombstone — same path, same file
identity, content byte-identical to the last synced state — is removed by
the next sync run instead of being re-uploaded. A copy edited after the
delete never matches and stays untracked; local data is never destroyed.

A file deleted directly on the remote (Drive UI, another tool — nothing
that goes through Portuni) is only noticed by the **remote sweep**, which
runs at the start of every deliberate sync ("Synchronizovat"): it removes
the record and writes the tombstone above, and — symmetrically — adopts
any file that showed up anywhere under `wip/`, `outputs/`, or
`resources/` — at any depth — without going through `portuni_store`/`portuni_adopt_files`
(a dot-prefixed filename or subfolder is skipped) —
the run that discovers it pulls it into that device's own mirror in the
same pass, and any other device mirroring the same node picks it up the
next time it runs its own sync. `portuni_status` alone never triggers the
sweep; a record it reports as `remote_missing` (or a file as `new_remote`)
only gets reconciled by an actual sync run. Moves
and renames leave their own tombstone, so a device that missed one cleans
up the stale copy at the old path instead of pushing it back.

Two situations need a human decision, and the sync run never guesses:
a **conflict** (both sides changed) and a **deleted_local** file (removed
locally, still on the remote). The file row in the app shows the choice —
"Ponechat lokální" / "Vzít z remote" for a conflict, "Obnovit" to restore
a deleted local copy — backed by `POST /nodes/:id/files/:fileId/resolve`.
Restoring refuses (with a clear error) to overwrite a local change that
was never pushed.

The footer's unsynced badge, the unsynced overview and the quit guard only
count work a sync run will actually push or adopt (plus conflicts) —
`deleted_local` and `remote_missing` files are surfaced in the node's own
file list instead, since a sync run does not touch them until you resolve
them.

**Moving bytes to the remote stays intentional.** Uploads happen the same way
you'd make a git commit — on purpose, with meaning, via `portuni_store` or
the app's Synchronize action. The watcher never pushes anything. The relevant
tools:

| Tool | What it does |
|------|--------------|
| `portuni_store` | Copy a file into the mirror folder, upload it via the routed remote, register it in `files`. |
| `portuni_pull` | With `file_id`, download the remote version into the mirror. With `node_id`, preview each file's status without modifying anything. |
| `portuni_status` | Scan tracked files + (optional) discover new local / new remote files. |
| `portuni_list_files` | List files across every node with derived `local_path`. |
| `portuni_search_files` | Search file contents on the remote(s) (Drive `fullText`); hits open with `portuni_read_file`. |

Every file has one of two statuses:

- **wip** -- stored under `wip/`; still being worked on.
- **output** -- stored under `outputs/`; the final, shareable version.

## Auto-seed on connect

Each mirror's `.mcp.json`, `.codex/config.toml`, and `.vibe/config.toml`
(written by `portuni_mirror`) point the MCP URL at the Portuni server with
`?home_node_id=<id>` baked in. When any MCP-capable harness opens a
session against that URL from inside the mirror, the server seeds the
read scope with the home node and its depth-1 neighbors before the
first tool call -- no hook, no harness-specific glue. See
[Scope enforcement -> Session home node](/concepts/scope-enforcement/#session-home-node)
for the details.
