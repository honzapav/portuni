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
- **Central mode** (a teammate). The desktop app runs **no** local server.
  Every request goes to a shared server (`api.portuni.com`) with a **Google
  login**, so the server can **enforce permissions** (groups, per-node
  visibility). The teammate never holds the raw database token.

The central server is the **same Portuni backend**, just deployed centrally and
reached with an identity instead of a shared secret. The key difference: it has
**no local mirror folders** of its own.

## The 2×2 — and the one cell that isn't built yet

|  | Graph plane | File-bytes plane |
|---|---|---|
| **Local mode** | server → Turso | sync engine → Drive |
| **Central mode** | server → Turso (available) | **not available yet** |

That empty cell is the thing to understand: central mode does **not** drop Drive
on purpose. A central client simply has no local mirror, and the shared server
does not yet read and write file *content* directly against Drive on a
teammate's behalf. So in central mode, file content, mirrors, and sync are
currently unavailable, and the app says so rather than failing silently.

:::caution[Status]
**Central-mode file content is planned, not shipped.** A teammate in central
mode can work with the **graph** today, but cannot yet read or edit file
**content** through the server. Tracking: the "files over the central server"
work on the [roadmap](/getting-started/roadmap/). Until it lands, file content
is a **local-mode** capability.
:::

### Why editing a file is a local-mode thing today

When you open and save a file in the app, Portuni reads and writes the file in
your **local mirror folder** — and pushing those bytes up to Drive is a
**separate** step (the sync action, surfaced as the unsynced overview). A
central-mode teammate has no mirror folder to read or write, which is exactly
the gap above.

## Two ways teammates can collaborate

### Shared-database collaboration (works today)

Everyone runs **local mode** and shares the owner's database access and the same
Drive. Each teammate's machine mirrors the same nodes and syncs the **same Drive
folder**, keyed by the **same graph**.

- **Pro:** file sharing works now.
- **Con:** every teammate holds the **raw database token** — full, unrestricted
  read/write. There are no per-person permissions. This is the exact problem
  central mode exists to solve.

### Central collaboration (the secure target)

Teammates run **central mode**, sign in with Google, and get **enforced
permissions** with no raw database token. The graph works today; file content
over the server is the planned piece described above.

| | Files work now? | Permissions enforced? | Teammate needs |
|---|---|---|---|
| **Shared-database** | yes | no (raw token) | database token + Drive access |
| **Central** | not yet | yes | a Google login |

## Glossary

| Term you'll see | What it means |
|---|---|
| graph sync | the shared knowledge graph in Turso |
| file sync | file bytes moving between your mirror and Drive |
| local mode | the client reaches data directly (the owner) |
| central mode | the client reaches data through `api.portuni.com`, permissions enforced |

## See also

- [Local Mirrors](/concepts/mirrors/) — the per-device folder model behind the
  file-bytes plane.
- [Filesystem Permissions](/concepts/permissions/) — how local file access is
  scoped.
- [Setting Up Remotes](/guides/setting-up-remotes/) — configuring the Drive
  backend.
- [Project status & roadmap](/getting-started/roadmap/) — where central-mode
  file content sits.
