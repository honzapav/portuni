---
title: Workspaces — Team and Personal
description: The two kinds of Portuni workspace, what each is for, and the words the rest of the docs use for the parts involved.
---

Everything in Portuni happens inside a **workspace**: one graph, one set of
mirror folders, one server behind them. There are two kinds, and they are
named by what they are for, not by where the database sits.

| | Team workspace | Personal workspace |
|---|---|---|
| **For** | an organization: shared graph, people signed in, permissions | one person on one machine |
| **Who reaches the graph** | every teammate, through the organization's central server | only you, through the server embedded in your desktop app |
| **Sharing** | built in: per-user permissions, per-node visibility, Drive as the shared file store | none, by design; nothing leaves the machine |
| **Sign-in** | Google account | none |
| **Set up by** | the organization ([Team Setup](/getting-started/team-setup/)), then each teammate joins with a server URL | you, in a few minutes ([Setup](/getting-started/setup/)) |

A personal workspace is the same Portuni server in a box: what works there
works the same way in a team workspace, and the desktop app, MCP tools and
agents behave identically. The team workspace is the one Portuni is built
around; the personal one is for trying it out and for working alone.

One desktop can hold both. Workspaces are created in Settings, each with its
own sidecar, port and credentials, so a personal workspace for your own notes
can sit next to the team workspace of the organization you work in.

## The parts of a team workspace

A team workspace always involves two processes, and the docs keep their names
apart:

- **Central server** — the Portuni server the organization runs
  (`api.portuni.com` or your own host). It owns the graph database, checks who
  you are and what you may see, holds the Drive credentials and watches the
  shared drive for changes. Teammates' apps and agents talk to it; nobody holds
  a database token or a Drive key on their laptop.
- **Sync agent** — the sidecar your desktop app runs next to a team workspace.
  It has no graph database of its own. It keeps your local mirror folders,
  watches them, moves file bytes between them and the central server with a
  per-device token, opens files from the mirror in the editor, and runs agent
  tasks on your machine. Before you sign in, the sync agent is not running and
  the features that need it say so.
- **Device-local** — the things the sync agent handles itself instead of
  forwarding to the central server: mirror folders, file content and file
  actions, sync status and sync runs, the runner registry, and starting or
  steering a task. In a personal workspace the same things are simply handled
  by the embedded server.

In a personal workspace there is one process, the embedded server, and it
plays every role at once.

## What runs where

| | Central server | Your device in a team workspace | Personal workspace |
|---|---|---|---|
| Graph (nodes, edges, events, file records) | yes | asks the central server | yes, own database |
| Mirror folders and the file watcher | no | yes (sync agent) | yes |
| File content in the editor | serves it from Drive when you have no mirror | from your mirror, else via the central server | from your mirror |
| Google Drive | yes, one service account | through the central server | not available |
| Agent tasks | records them | runs them | runs and records them |
| Permissions and visibility | enforced here | enforced by the central server | one user, nothing to enforce |
| MCP for your CLI agents | proxied from the sync agent, plus remote MCP clients with OAuth | the sync agent's local endpoint | the embedded server's endpoint |

What a given deployment offers beyond the graph (Drive, remote MCP clients,
routines, remote hosts) depends on how the organization configured its central
server and on what has shipped ([Project Status & Roadmap](/getting-started/roadmap/));
it is not part of either kind's definition.

## The one thing people mix up

"Which kind of workspace" and "syncing files to Google Drive" are two
different questions. The first is about how your app reaches the graph. The
second is about where file *bytes* go, and only a team workspace has anywhere
for them to go. The two planes are explained in
[Files: the two sync planes](/concepts/data-modes/).

## Words you will see in the settings and in code

| In the docs | In the app and code |
|---|---|
| team workspace | `data_mode: "central"`, "Připojit se k týmu" in onboarding |
| personal workspace | `data_mode: "local"` |
| central server | `PORTUNI_AUTH_MODE=google`, the `server_url` in a team workspace's settings |
| sync agent | `PORTUNI_AGENT_MODE=1`, the sidecar of a team workspace |
| device-local | the `sync_agent_down` answer (HTTP 501) when the sync agent is not running yet: sign in |
