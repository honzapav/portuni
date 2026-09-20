# Data modes & the two sync planes

> **Status (2026-09):** Collaboration is central mode only (see
> `docs/superpowers/specs/2026-09-11-one-collaboration-mode-design.md`). A
> local workspace cannot register or route to a remote at all
> (`LOCAL_MODE_NO_REMOTE`, #310/#312) — it tracks files on one machine and
> shares nothing. Central mode serves file **content** and lifecycle
> (create / rename / delete) over the central server via a mirror-less,
> Drive-direct service (`file-content-remote.ts`), and runs agent **tasks**
> (the local sync agent serves the mirror and drives the run; the task's
> agent reaches the local MCP front door, which proxies to central).
> So a central-mode teammate gets **both** the graph **and** file bytes today.
> The historical design rationale lives in
> [`central-file-content-phase-b.md`](../archive/central-file-content-phase-b.md).

> **Purpose:** settle the recurring confusion between "local vs central mode" and
> "syncing files to Google Drive." They are different axes. This doc is the
> canonical mental model; link here instead of re-explaining.

## The one-sentence summary

> The owner (**local mode**) tracks files in mirror folders on his own
> machine and never talks to a remote — sharing files with anyone else means
> switching to central mode. A **central-mode** teammate reaches the data
> through `api.portuni.com` with enforced permissions, and gets **both** the
> **graph** and **file bytes** — the file-bytes half over the server is
> served mirror-less and Drive-direct by `file-content-remote.ts` (design
> rationale archived in
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
  talks **directly to Turso** (raw token) and tracks files in mirror folders
  on your own machine — but never talks to a remote at all
  (`LOCAL_MODE_NO_REMOTE`, #310/#312). Sharing files is central mode's job.
- **central mode (teammate):** the webview's data requests go through the
  `api_request` Tauri command to **`server_url` (`api.portuni.com`)** with a
  Google **JWT**, so the server can **enforce permissions** (groups, node-access
  in `apps/server/auth/`). The teammate never holds the raw Turso token. The
  desktop still runs a **local sidecar as the sync agent** (`PORTUNI_AGENT_MODE=1`)
  for mirrors, file sync, and the MCP front door that **agent sessions** use —
  but it never talks to Turso directly (see the agent-mode section below).

In multi-workspace setups, **each workspace can have a different `data_mode`**:
one workspace can be local (direct Turso, no remote) while another is
central (through the server). This allows a single desktop to host, say, a
central-mode Tempo workspace and a local-mode personal workspace simultaneously.

The central server is literally the **same backend codebase** deployed to a VPS
(`scripts/deploy-vps.sh` rsyncs `dist/`). It just has **no local mirror folders**
and is reached by JWT instead of a bearer token.

## The 2x2 — both cells filled

|  | Graph plane | File-bytes plane |
|---|---|---|
| **local mode** | sidecar -> Turso | sync engine -> tracked locally, no remote |
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
/scope
/sync/pending, /sync/health, /sync/jobs (+ /sync/jobs/:id, /sync/jobs/current)
/runners (+ /runners/instances..., /runners/:runner/models, /runners/org-defaults/:orgId)
/nodes/:id/mirror, /nodes/:id/sync-status, /nodes/:id/sync
/nodes/:id/file
POST /nodes/:id/files
DELETE /nodes/:id/files/:fileId
POST /nodes/:id/files/:fileId/{resolve,rename,move}
POST /sessions
/sessions/:id/{messages,interrupt,continue,close,events,signals}
POST /sessions/:id/questions/:request_id
```

So `local_only` now means exactly **"the local sync agent isn't up — sign
in"**, not "this feature is unbuilt." `/nodes/:id/file` (GET/PUT) is on the
list because the agent serves a device mirror from disk and proxies to central
itself when there is no mirror. `DELETE /nodes/:id/files/:fileId` is on the
list too (#254): the record + remote object are still adapter-direct on the
central server (`agent-router.ts` calls `CentralClient.deleteFileRecord`,
the exact same endpoint a non-agent-mode delete hits), but the device has to
run its own disk-cleanup step (`rm` the mirror copy, drop the `file_state`
row) afterward — the central server has no mirror to clean up, so without
this the local copy survived every delete and the next backfill sweep
re-registered it. `POST /nodes/:id/files/:fileId/resolve` (conflict
resolution — "Ponechat lokální" / "Vzít z remote" / "Obnovit") is on the
list for the same reason (#264): `agent-router.ts` already implemented it
correctly against the device's own mirror (`findEntryByFileId` +
`storeFileCentral`/`pullFileCentral`), but nothing routed the desktop UI's
REST call there before this fix — it went straight to central, which has no
mirror to resolve against at all (409 on `keep_local`, 500 on
`take_remote`/`restore`).

`POST /nodes/:id/files` (create) is on the list too, for a different reason
(#266): central's own create is adapter-direct — it does the Drive `PUT`
before answering — so a device with a mirror never got a sync baseline for
the new file before the editor's own local-only save landed, which the
watcher then classified as a **permanent conflict** (a local hash with no
`last_synced_hash` against a remote hash of `md5("")`, indistinguishable
from a real conflict once it happens). With a mirror on this device,
`agent-router.ts` instead writes the file into the mirror and registers the
record **without waiting on the Drive upload** — the response comes back as
soon as the record exists, not after a round trip to Drive — and pushes in
the background; until that background push lands, the file reads as an
ordinary `push` classification (registered, no `current_remote_hash` yet,
local hash cached), exactly like any other freshly-created local file, then
`clean` once the push completes. A device with **no** mirror for the node
still forwards to central via the handler's own fallback
(`CentralClient.createFile`, a new method wrapping the same
`POST /nodes/:id/files` central already serves) — this route is unconditional
in `is_local_only_path`, so the agent-router handler itself decides per node
whether to serve it locally or forward it, the same shape as the `/file`
GET/PUT fallback above.

`POST /nodes/:id/files/:fileId/rename` is on the list too: central keeps the
record + remote step (`CentralClient.renameFile`, the same POST it already
serves mirror-less), and the agent-router handler renames the device's mirror
copy afterwards — forwarded straight to central, the local file kept its old
name and the next scan reported the record missing locally plus a new
untracked file. Only `/nodes/:id/file-url` and `/nodes/:id/folder-url` still
forward straight to the central server, which serves them Drive-direct
(`file-content-remote.ts`). The old
"available only in local mode" frontend string has been removed; the 501 is
caught as `LocalOnlyError` (`apps/web/src/api.ts`) and now reads as "not
signed in."

### Agent-mode MCP: how agent sessions work in central mode

The `local_only` gate above is for the **REST** plane the webview drives. MCP
sessions are served differently: a teammate's "sync agent" sidecar
(`PORTUNI_AGENT_MODE=1`, see
`docs/archive/plans/2026-07-05-agent-mode-mcp-front-door.md`) serves `/mcp`
itself, and the per-mirror `.mcp.json` in agent mode points at that local front
door instead of central. Device-local tools (`portuni_mirror`, `portuni_status`,
`portuni_store`, `portuni_pull`, `portuni_adopt_files`) run on-device against
the local mirror + the central engine; every other tool (graph reads/writes,
scope, responsibilities, ...) is proxied to central's `/mcp` unchanged. So a
teammate's agent works on real files locally, while graph writes land on central
with permissions enforced. Disk read scope in agent mode is just this device's
own mirror registry: any node with a local mirror here is read at its real
path, no matter where it sits relative to the home node; a node with none is
read via `portuni_read_file` (central/remote-direct, #346 — there is no
sandbox or hardlink projection layer anymore). The dynamic scope *set* is
still tracked upstream on the central session, not on the device.

Proxied tools with a device-side step (`apps/server/mcp/agent-tools.ts`):
- `portuni_move_file`, `portuni_rename_folder`, `portuni_delete_file` run
  their record/remote step on central; the front door snapshots the affected
  record before the proxy and applies the local rm/rename + `file_state`
  cleanup after a confirmed result, rewriting `local_done` /
  `new_local_path` with this device's outcome.
- `portuni_snapshot` exports on central (it holds the Drive credentials) and,
  because central has no mirror, creates the file remote-direct
  (`createFileRemote`). The front door then pulls the new file into the
  device mirror and adds `local_path` to the payload (`null` when the node is
  not mirrored here; `local_error` when the pull was refused, e.g. a dirty
  untracked file at that path).

### Agent-mode sessions: the task runs on the device, the record lives on central

The runner batch's session runtime (`docs/superpowers/specs/2026-09-12-runner-and-session-design.md`,
rule 1 "one implementation") follows the same split as everything else on
this page: the code that actually runs a task — spawning the runner
adapter, provisioning its mirror and orientation, translating its events —
is identical in both modes and always runs **on the device** (the sidecar,
whichever mode it's in). What differs is only which `SessionStore` backs
it. Locally, `boot/session-runtime.ts`'s `getSessionRuntime()` binds
`DbSessionStore` straight to this server's own db. In agent mode,
`agent-router.ts`'s `createAgentRouter(client)` builds its own runtime
(`createAgentSessionRuntime`) bound to `CentralSessionStore`
(`domain/runner/store-central.ts`) instead — every `SessionStore` call
becomes a REST round trip to central's "central record half"
(`api/sessions.ts`: `POST /sessions/record`, `PATCH /sessions/:id`,
`POST /sessions/:id/runs`, `PATCH /sessions/:id/runs/:run_id`,
`GET /sessions/:id/runs`, `POST`/`GET /sessions/:id/events`), which applies
the exact same `auth/session-access.ts` ownership checks a local call would
— central IS the graph db here, so it's the one place that can actually
enforce them.

Provisioning also needed a central-mode counterpart
(`domain/runner/provision-central.ts`): the mirror is created via
`createMirrorForNodeCentral` instead of the local `createMirrorForNode`,
and the task's orientation text comes from `CentralClient.orientation`
(`GET /nodes/:id/orientation`, computed on central, which has the real
graph db) instead of `orientationForNode`'s direct db read — this is the
one orientation gap central mode used to have (materializing a fresh
mirror's `PORTUNI_SCOPE.md` still has no orientation section; that's a
different code path, unrelated to a task's own runtime orientation, and
still cut for the same "no endpoint" reason until it's wired through too).
Suspend's server-generated-handoff fallback (spec: "Suspend and resume")
similarly can't write straight to the graph db in agent mode —
`domain/runner/suspend-fallback-central.ts` writes the handoff file to the
device's own mirror (mirrors are a per-device concept in every mode) and
then patches the session record over the same REST route, instead of
`session-handoff.ts`'s local-db-only `suspendSessionServerSide`.

The third such counterpart is the organization resolver
(`CreateSessionRuntimeDeps.resolveNodeOrgId`, #407). Promoting a draft by
its first message picks the organization's default runner instance, which
means reading the node's `belongs_to` edge — a graph-db query that has no
answer on a device. `createAgentSessionRuntime` injects
`CentralClient.nodeOrganizationId` (`GET /nodes/:id`, the organization peer
of the outgoing `belongs_to` edge in central's own node detail) in place of
the local query; a resolver error degrades to "no organization" (the
runner's own default account) and logs one line, it never fails the
promotion.

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

## One collaboration model (the retired alternative)

### Model 1 — shared token (retired, #310/#311)

Early Portuni had a second, unsafe path: everyone ran **local mode** and
shared **the owner's Turso token** plus Drive access (the same Service
Account / Shared Drive), so each teammate's desktop mirrored the same nodes
and synced the same Drive folder, keyed by the same Turso graph. It worked,
but every teammate held the **raw Turso token — full, unrestricted DB
access** — with no per-user permissions. This is exactly the problem the
central server exists to fix, and a local workspace can no longer register
or route to a remote at all (`LOCAL_MODE_NO_REMOTE`), so this path is not
just discouraged — it is structurally impossible now.

### Model 2 — brokered / central (the only path, shipped)

- Teammates run **central mode**, authenticate with Google, get **enforced
  permissions**, never touch the raw Turso token.
- Both the **graph** and **file bytes** work **today**: file content and
  lifecycle are served over the server, mirror-less and Drive-direct
  (`file-content-remote.ts`; design rationale archived in
  [`central-file-content-phase-b.md`](../archive/central-file-content-phase-b.md)).
- Drive credentials live on the central server alone, as a single service
  account — no device ever holds them.

| | Files work now? | Permissions enforced? | Teammate needs |
|---|---|---|---|
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
