---
title: Data Modes — Local vs Central
description: How a Portuni client reaches your data, and why "syncing files to Drive" and "central mode" are two different things.
---

There are two ideas people constantly mix up: **local vs central mode**, and
**syncing files to Google Drive**. They are different axes. This page is the
mental model — read it once and the rest of Files & Sync clicks into place.

## "Sync" means two different things

Portuni moves data on **two independent planes**, and the word *sync* gets used
for both:

| Plane | What moves | Lives in | Shared via |
|-------|-----------|----------|------------|
| **Graph plane** | nodes, edges, events, and file *records* (name, hash, who pushed) | Turso (the database) | Turso |
| **File-bytes plane** | the actual file *contents* (markdown, PDFs, transcripts) | local mirror folders → a remote | Google Drive (Service Account) |

They are joined by one fact: **Turso stores the canonical content hash** of each
file, while the remote holds the bytes. The graph plane knows *which version is
current*; the file-bytes plane holds *the bytes themselves*.

When someone says "sync to Drive" they mean the **file-bytes plane**. When the
project says "graph sync" it means the **Turso plane**.

## Local vs central is about *how a client reaches the data*

`data_mode` is not a feature switch — it is a transport and trust boundary:

- **Local mode** (default, the owner). The desktop app runs the Portuni server
  itself (the embedded sidecar), talks **directly to Turso**, and runs the
  **file sync engine** on your own machine (mirror folders ↔ Drive). Full power,
  full trust.
- **Central mode** (a teammate). Every graph and file-content request goes to a
  shared server with a **Google login**, so the server can **enforce
  permissions** (groups, per-node visibility). The teammate never holds the raw
  database token or the Drive credentials. The desktop still runs its local
  sidecar — but as a **sync agent**, not as a graph server: it maintains local
  mirror folders and a file watcher, and moves file bytes between those folders
  and the central server using a per-device token. Everything is brokered
  through the central server; nothing on the teammate's machine talks to Turso
  or Drive directly.

The central server is the **same Portuni backend**, just deployed centrally and
reached with an identity instead of a shared secret. The key difference: it has
**no local mirror folders** of its own — it reads and writes file content
directly against the routed remote (Drive) on the teammate's behalf.

## The 2×2

|  | Graph plane | File-bytes plane |
|---|---|---|
| **Local mode** | sidecar → Turso | sync engine → Drive |
| **Central mode** | central server → Turso | central server → Drive (adapter-direct); the local sync agent brokers mirror folders ↔ central server |

Both cells of the central row are live. The central server has no mirror of its
own, so it talks to the remote adapter directly: opening a file in central mode
reads the bytes from Drive through the server, saving writes them back and
refreshes the canonical hash in the graph so both planes stay consistent.
Optimistic concurrency works the same as locally — a stale base version is a
conflict, not a silent overwrite.

### Teammate mirrors — local folders without local credentials

A central-mode teammate still gets real folders on disk. The sync agent
(the sidecar running with `PORTUNI_AGENT_MODE=1`) creates and watches local
mirror folders, and syncs their contents through the central server with the
device token issued at Google login. Before login, mirror-dependent features
simply report themselves unavailable. The result is the local-mirror experience
— agents and editors work against plain folders — with zero shared secrets on
the teammate's machine.

### One desktop, both modes

`data_mode` is **per workspace**, not per machine. The desktop's multi-workspace
config can host a local-mode workspace (your own org, direct Turso + Drive) and
a central-mode workspace (a team you're a teammate in) side by side, each with
its own sidecar, port, and credentials.

## Two ways teammates can collaborate

### Shared-database collaboration (works today)

Everyone runs **local mode** and shares the owner's database access and the same
Drive. Each teammate's machine mirrors the same nodes and syncs the **same Drive
folder**, keyed by the **same graph**.

- **Pro:** file sharing works now.
- **Con:** every teammate holds the **raw database token** — full, unrestricted
  read/write. There are no per-person permissions. This is the exact problem
  central mode exists to solve.

### Central collaboration (the secure default for teams)

Teammates run **central mode**, sign in with Google, and get **enforced
permissions** with no raw database token. Graph, file content, and teammate
mirrors all work through the central server.

| | Files work? | Permissions enforced? | Teammate needs |
|---|---|---|---|
| **Shared-database** | yes | no (raw token) | database token + Drive access |
| **Central** | yes | yes | a Google login |

## Glossary

| Term you'll see | What it means |
|---|---|
| graph sync | the shared knowledge graph in Turso |
| file sync | file bytes moving between your mirror and Drive |
| local mode | the client reaches data directly (the owner) |
| central mode | the client reaches data through the central server, permissions enforced |
| sync agent | the local sidecar in central mode — mirror folders + watcher, brokered through the central server with a device token |

## See also

- [Local Mirrors](/concepts/mirrors/) — the per-device folder model behind the
  file-bytes plane.
- [Filesystem Permissions](/concepts/permissions/) — how local file access is
  scoped.
- [Setting Up Remotes](/guides/setting-up-remotes/) — configuring the Drive
  backend.
