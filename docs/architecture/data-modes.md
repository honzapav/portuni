# Data modes & the two sync planes

> **Status (2026-07):** Central mode now serves file **content** and lifecycle
> (create / rename / delete) over the central server via a mirror-less,
> Drive-direct service (`file-content-remote.ts`), and supports agent
> **terminals** (the local sync agent serves the mirror + sandbox profile; the
> terminal's agent reaches the local MCP front door, which proxies to central).
> So a central-mode teammate gets **both** the graph **and** file bytes today.
> The historical design rationale lives in
> [`central-file-content-phase-b.md`](../archive/central-file-content-phase-b.md).

> **Purpose:** settle the recurring confusion between "local vs central mode" and
> "syncing files to Google Drive." They are different axes. This doc is the
> canonical mental model; link here instead of re-explaining.

## The one-sentence summary

> The owner (**local mode**) runs the sync engine on his own machine and pushes
> file bytes to Google Drive himself. A **central-mode** teammate reaches the
> data through `api.portuni.com` with enforced permissions, and today gets
> **both** the **graph** and **file bytes** — the file-bytes half over the
> server is served mirror-less and Drive-direct by `file-content-remote.ts`
> (design rationale archived in
> [`central-file-content-phase-b.md`](../archive/central-file-content-phase-b.md)).

## "Sync" means two different things

The word *sync* is overloaded. There are two independent data planes:

| Plane | What moves | Lives in | Shared via |
|---|---|---|---|
| **Graph plane** | nodes, edges, events, file *records* (name, canonical hash, who pushed) | Turso (the DB) | Turso |
| **File-bytes plane** | the actual file *contents* (markdown, PDFs, transcripts) | local mirror folders -> remote | Google Drive (Service Account on a Shared Drive) |

They are glued by one fact: **Turso stores the canonical content hash** of each
file (`hash is identity`, see [`file-sync.md`](./file-sync.md)), while the remote
holds the bytes. So the graph plane knows *the truth about which file is current*,
and the file-bytes plane holds *the bytes themselves*.

When a user says "sync to Drive" they mean the **file-bytes plane**. When the
code says "graph sync" it means the **Turso plane**.

## "local" vs "central" is about *how a client reaches the data*

This is `DesktopConfig.data_mode` (`apps/desktop/src/lib.rs`). It is **not** a
feature toggle — it is a transport/trust boundary:

- **local mode (default, owner):** the desktop spawns the **sidecar**, which
  talks **directly to Turso** (raw token) and runs the **local sync engine**
  (mirror folders <-> Drive). Full power, full trust.
- **central mode (teammate):** the webview's data requests go through the
  `api_request` Tauri command to **`server_url` (`api.portuni.com`)** with a
  Google **JWT**, so the server can **enforce permissions** (groups, node-access
  in `apps/server/auth/`). The teammate never holds the raw Turso token. The
  desktop still runs a **local sidecar as the sync agent** (`PORTUNI_AGENT_MODE=1`)
  for mirrors, file sync, and the MCP front door that agent **terminals** use —
  but it never talks to Turso directly (see the agent-mode section below).

In multi-workspace setups, **each workspace can have a different `data_mode`**:
one workspace can be local (direct Turso + Drive access) while another is
central (through the server). This allows a single desktop to host, say, a
central-mode Tempo workspace and a local-mode personal workspace simultaneously.

The central server is literally the **same backend codebase** deployed to a VPS
(`scripts/deploy-vps.sh` rsyncs `dist/`). It just has **no local mirror folders**
and is reached by JWT instead of a bearer token.

## The 2x2 — both cells filled

|  | Graph plane | File-bytes plane |
|---|---|---|
| **local mode** | sidecar -> Turso | sync engine -> Drive |
| **central mode** | server -> Turso (shipped, the graph cutover) | sync agent -> device mirror; falls back to server -> Drive (mirror-less, `file-content-remote.ts`) |

Central mode does **not** "drop Drive by design," and it no longer lacks file
bytes: the central server reaches them through a **mirror-less, Drive-direct
file-content service** (`file-content-remote.ts`) that resolves the Drive
adapter from the remote's Service Account credential and reads/writes bytes
without any local mirror. File **content** (`GET/PUT /nodes/:id/file`) routes
to the **local sync agent first**: when the node has a device mirror the agent
reads/writes the mirror file directly (so unsynced local files open in the
editor — a registered-but-unpushed or untracked file does not exist on Drive
yet), and the agent itself falls back to central when there is no mirror or
the file is pull-pending. The file **lifecycle** routes forward to the server;
a `501 local_only` now means only that the **local sync agent is not running**
(you are not signed in) — see below.

### What `local_only` means in the UI

Device-local routes are served by the **local sync agent** (the sidecar). When
that agent is **not running** — i.e. the teammate is **not signed in** —
`is_local_only_path()` (`apps/desktop/src/lib.rs`) short-circuits these routes
to `501 {error:"local_only", detail:"sync agent not running"}` in central mode
(in local mode the gate does not apply at all):

```
/scope, /sandbox-profile
/nodes/:id/mirror, /nodes/:id/sync-status, /nodes/:id/sync, /nodes/:id/sandbox-profile
/nodes/:id/file
```

So `local_only` now means exactly **"the local sync agent isn't up — sign
in"**, not "this feature is unbuilt." `/nodes/:id/file` (GET/PUT) is on the
list because the agent serves a device mirror from disk and proxies to central
itself when there is no mirror. The file lifecycle is **not** on that list:
`POST /nodes/:id/files`, `.../files/:id/rename`, `DELETE .../files/:id`, plus
`/nodes/:id/file-url` and `/nodes/:id/folder-url` all forward to the central
server, which serves them mirror-less and Drive-direct
(`file-content-remote.ts`). The old "available only in local mode" frontend
string has been removed; the 501 is caught as `LocalOnlyError`
(`apps/web/src/api.ts`) and now reads as "not signed in."

### Agent-mode MCP: how terminals work in central mode

The `local_only` gate above is for the **REST** plane the webview drives. MCP
terminals are served differently: a teammate's "sync agent" sidecar
(`PORTUNI_AGENT_MODE=1`, see
`docs/archive/plans/2026-07-05-agent-mode-mcp-front-door.md`) serves `/mcp`
itself, and the per-mirror `.mcp.json` in agent mode points at that local front
door instead of central. Device-local tools (`portuni_mirror`, `portuni_status`,
`portuni_store`, `portuni_pull`, `portuni_adopt_files`) run on-device against
the local mirror + the central engine; every other tool (graph reads/writes,
scope, responsibilities, ...) is proxied to central's `/mcp` unchanged. So a
teammate's agent works on real files locally, while graph writes land on central
with permissions enforced. Scope disk projection in agent mode is implemented
via **real** seatbelt-granted paths: the seed set (home + depth-1, resolved
from central) is read at its real mirror, and ad-hoc nodes via
`portuni_read_file` — the old `.portuni-scope/` copy staging is retired (see
[`scope-disk-projection.md`](./scope-disk-projection.md)). The dynamic scope
*set* is still tracked upstream on the central session, not on the device.

Follow-up gap, not yet built:
- `portuni_move_file`, `portuni_rename_folder`, `portuni_delete_file`,
  `portuni_snapshot` have no agent-mode handler — they proxy to central,
  and central **executes them**: it mutates the registry/remote and reports
  `local_done: false` (verified for `portuni_move_file`: status ok,
  `remote_done: true`, `local_done: false`). The teammate's local mirror
  file is left in place, stale — until a later sync happens to reconcile
  it, or forever. This is a known correctness gap (silent local/remote
  divergence, not a clean error); the follow-up is either local
  interception like store/pull, or a central-side guard that refuses these
  calls for agent sessions.

## An important subtlety: local-mode editing is mirror-local, central is Drive-direct

In **local mode**, `readFileContent` / `writeFileContent`
(`apps/server/domain/sync/file-content.ts`) operate on the **local mirror folder**
(`getMirrorPath` -> `readFile`/`writeFile` on disk). Saving in the editor writes
the **mirror file only and never pushes**; pushing the bytes to Drive is a
**separate** step (`POST /nodes/:id/sync`, surfaced as the unsynced overview).

A central client has **no mirror folder** to read or write, so it does **not**
reuse that path. Instead the central server serves file content through a
**mirror-less, Drive-direct** service (`file-content-remote.ts`) that talks to
the Drive adapter directly — reading and writing bytes without any local mirror.

## Two collaboration models (do not conflate them)

### Model 1 — shared token (works today, "small team" path)

- Everyone runs **local mode** and shares **the owner's Turso token** + **Drive
  access** (the same Service Account / Shared Drive).
- Each teammate's desktop mirrors the same nodes and syncs the **same Drive
  folder**, keyed by the **same Turso graph** ("same Portuni base").
- Files travel via **Drive**, graph + canonical state via **Turso**; each device
  keeps its own private `sync.db` ("what this machine has seen").
- Pro: file sharing works **now**. Con: every teammate holds the **raw Turso
  token = full unrestricted DB access**. No per-user permissions. This is the
  exact problem the central server exists to fix.

### Model 2 — brokered / central (the secure target, shipped)

- Teammates run **central mode**, authenticate with Google, get **enforced
  permissions**, never touch the raw Turso token.
- Both the **graph** and **file bytes** work **today**: file content and
  lifecycle are served over the server, mirror-less and Drive-direct
  (`file-content-remote.ts`; design rationale archived in
  [`central-file-content-phase-b.md`](../archive/central-file-content-phase-b.md)).

| | Files work now? | Permissions enforced? | Teammate needs |
|---|---|---|---|
| **Model 1** (all local) | yes | no (raw Turso token) | Turso token + Drive share |
| **Model 2** (central) | yes | yes | Google login to `api.portuni.com` |

## Glossary (clearer names for the overloaded terms)

| Term in code/UI today | Clearer meaning |
|---|---|
| "sync" (Turso) | **graph sync** — the shared knowledge graph in Turso |
| "sync" (Drive) | **file sync** — file bytes, local mirror <-> Drive |
| `data_mode: "local"` | **direct mode** — client holds Turso token + Drive itself (owner) |
| `data_mode: "central"` | **brokered mode** — client goes through `api.portuni.com`, permissions enforced |
| `local_only` (501 error) | "the local sync agent isn't running — sign in" (not "feature unbuilt") |

## See also

- [`file-sync.md`](./file-sync.md) — the file-bytes plane in depth (adapters,
  hash identity, two-layer state).
- [`central-file-content-phase-b.md`](../archive/central-file-content-phase-b.md)
  — design rationale for file content over the server (now shipped).
- `docs/archive/plans/2026-06-10-central-cutover.md` — the graph cutover that
  shipped the graph over the server.
