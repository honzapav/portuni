---
title: Files — The Two Sync Planes
description: Why "syncing files to Drive" and "which kind of workspace" are two different things, and how file bytes move in a team workspace.
---

Two ideas get mixed up: **which kind of workspace you are in** and **syncing
files to Google Drive**. The first is explained in
[Workspaces](/concepts/workspaces/). This page is about the second: the two
planes data moves on, and how file bytes travel in a team workspace.

## "Sync" means two different things

Portuni moves data on **two independent planes**, and the word *sync* gets used
for both:

| Plane | What moves | Lives in | Shared via |
|-------|-----------|----------|------------|
| **Graph plane** | nodes, edges, events, and file *records* (name, hash, who pushed) | the graph database | the central server |
| **File-bytes plane** | the actual file *contents* (markdown, PDFs, transcripts) | local mirror folders → a remote | Google Drive (service account on a shared drive) |

They are joined by one fact: **the graph stores the canonical content hash** of
each file, while the remote holds the bytes. The graph plane knows *which
version is current*; the file-bytes plane holds *the bytes themselves*.

When someone says "sync to Drive" they mean the **file-bytes plane**. When the
project says "graph sync" it means the **graph plane**.

## Where each plane lives, per kind of workspace

|  | Graph plane | File-bytes plane |
|---|---|---|
| **Personal workspace** | embedded server → own database | mirror folders, tracked locally, no remote |
| **Team workspace** | central server → graph database | sync agent → your mirror folders, falling back to the central server → Drive; the sync agent also moves bytes between your mirrors and the central server |

A personal workspace never talks to a remote. It cannot be given one:
`portuni_setup_remote` and `portuni_set_routing_policy` refuse with
`LOCAL_MODE_NO_REMOTE`, and so does every push/pull operation (`portuni_store`,
`portuni_pull`, a sync run). Files there classify as `clean` (tracked, present)
or `deleted_local` (tracked, gone from disk), never `push`/`pull`/`conflict`.
Sharing files with anyone is what a team workspace is for.

In a team workspace both cells are live. Opening a file reads your device
mirror when the node has one, including files that exist only locally and have
not been pushed yet, and otherwise reads the bytes from Drive through the
central server (which has no mirror of its own and talks to the Drive adapter
directly). Saving writes the mirror file when one exists (the sync agent pushes
it later, on a deliberate sync) or writes back through the central server,
which refreshes the canonical hash in the graph so both planes stay
consistent. Optimistic concurrency works the same in both kinds of workspace: a
stale base version is a conflict, not a silent overwrite.

### Teammate mirrors: local folders without local credentials

A teammate still gets real folders on disk. The sync agent creates and watches
local mirror folders and syncs their contents through the central server with
the device token issued at Google login. Before login, mirror-dependent
features simply report themselves unavailable. The result is the local-mirror
experience, agents and editors working against plain folders, with zero shared
secrets on the teammate's machine.

### Tasks: the runner runs on your device, the record lives with the graph

Starting a task on a node spawns a runner (Claude Code today) that reads and
writes through your own machine, in both kinds of workspace. What differs is
only where the task's record (its runs, its event log) is stored: in a
personal workspace it is your own database; in a team workspace it is the
central server your graph and files already go through, with permissions
enforced there. Starting, messaging and resuming a task work identically
either way.

## Collaboration happens only in a team workspace

A personal workspace cannot register or route to a remote at all
(`LOCAL_MODE_NO_REMOTE`), so it has no way to share files or database access
with anyone else. An earlier pattern (everyone running the embedded server
against the owner's shared database token and Drive access) held no
per-person permissions; that is exactly the problem the central server was
built to solve, and it is no longer possible to set up.

Teammates sign in with Google and get **enforced permissions** with no raw
database token. Graph, file content and teammate mirrors all work through the
central server.

## Glossary

| Term you'll see | What it means |
|---|---|
| graph sync | the shared knowledge graph in the database |
| file sync | file bytes moving between your mirror and Drive |
| personal workspace | one person, one machine: the embedded server reaches its own database directly, no remote |
| team workspace | the app reaches the graph through the central server, permissions enforced |
| sync agent | the sidecar of a team workspace on your device: mirror folders and watcher, brokered through the central server with a device token |

## See also

- [Workspaces](/concepts/workspaces/) — the two kinds and the words for their
  parts.
- [Local Mirrors](/concepts/mirrors/) — the per-device folder model behind the
  file-bytes plane.
- [Filesystem Permissions](/concepts/permissions/) — how local file access is
  scoped.
- [Setting Up Remotes](/guides/setting-up-remotes/) — configuring the Drive
  backend.
