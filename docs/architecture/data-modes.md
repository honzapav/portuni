# Data modes & the two sync planes

> **Purpose:** settle the recurring confusion between "local vs central mode" and
> "syncing files to Google Drive." They are different axes. This doc is the
> canonical mental model; link here instead of re-explaining.

## The one-sentence summary

> The owner (**local mode**) runs the sync engine on his own machine and pushes
> file bytes to Google Drive himself. A **central-mode** teammate reaches the
> data through `api.portuni.com` with enforced permissions, and today gets the
> **graph** but not **file bytes** — the file-bytes half over the server is the
> unbuilt **Phase B** (see [`central-file-content-phase-b.md`](./central-file-content-phase-b.md)).

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
- **central mode (teammate):** the desktop does **not** spawn a sidecar. Every
  request goes through the `api_request` Tauri command to **`server_url`
  (`api.portuni.com`)** with a Google **JWT**, so the server can **enforce
  permissions** (groups, node-access in `apps/server/auth/`). The teammate never holds
  the raw Turso token.

The central server is literally the **same backend codebase** deployed to a VPS
(`scripts/deploy-vps.sh` rsyncs `dist/`). It just has **no local mirror folders**
and is reached by JWT instead of a bearer token.

## The 2x2 — and the one empty cell

|  | Graph plane | File-bytes plane |
|---|---|---|
| **local mode** | sidecar -> Turso | sync engine -> Drive |
| **central mode** | server -> Turso (**shipped**, the "Phase A" cutover) | **empty — Phase B** |

The empty cell is the whole story. Central mode does **not** "drop Drive by
design." It lacks file bytes because **nobody has built the piece that lets a
central client reach them** — the central server has no local mirror and no
file-content path that talks to Drive directly. So those routes return
`501 local_only`.

### What is `local_only` / "fáze B" in the UI

`is_local_only_path()` in `apps/desktop/src/lib.rs` short-circuits these routes to
`501 {error:"local_only"}` **when in central mode** (in local mode the gate does
not apply at all):

```
/scope, /sandbox-profile
/nodes/:id/file, /files, /files/*, /mirror, /sync-status, /sync, /sandbox-profile
```

The frontend catches the 501 -> `LocalOnlyError` (`apps/web/src/api.ts`) and shows
*"Dostupné jen v lokálním režimu (fáze B)."* That string does **not** mean "file
content is unimplemented." It means: "file content is implemented for **local**
clients; reaching it over the **server** is Phase B." `/nodes/:id/folder-url`
stays central (the server can resolve a Drive web URL without a mirror).

## An important subtlety: editing a file is mirror-local, not Drive-direct

Today `readFileContent` / `writeFileContent`
(`apps/server/domain/sync/file-content.ts`) operate on the **local mirror folder**
(`getMirrorPath` -> `readFile`/`writeFile` on disk). Saving in the editor writes
the **mirror file only and never pushes**; pushing the bytes to Drive is a
**separate** step (`POST /nodes/:id/sync`, surfaced as the unsynced overview).

This is exactly why a central client cannot reuse the current path: a VPS (or a
teammate's machine in central mode) has **no mirror folder** to read or write.
Phase B needs a mirror-less, Drive-direct file-content service.

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

### Model 2 — brokered / central (the secure target, partly built)

- Teammates run **central mode**, authenticate with Google, get **enforced
  permissions**, never touch the raw Turso token.
- Graph works **today**. File bytes are **Phase B** — see
  [`central-file-content-phase-b.md`](./central-file-content-phase-b.md).

| | Files work now? | Permissions enforced? | Teammate needs |
|---|---|---|---|
| **Model 1** (all local) | yes | no (raw Turso token) | Turso token + Drive share |
| **Model 2** (central) | not yet (Phase B) | yes | Google login to `api.portuni.com` |

## Glossary (clearer names for the overloaded terms)

| Term in code/UI today | Clearer meaning |
|---|---|
| "sync" (Turso) | **graph sync** — the shared knowledge graph in Turso |
| "sync" (Drive) | **file sync** — file bytes, local mirror <-> Drive |
| `data_mode: "local"` | **direct mode** — client holds Turso token + Drive itself (owner) |
| `data_mode: "central"` | **brokered mode** — client goes through `api.portuni.com`, permissions enforced |
| "fáze B" (UI string) | "not reachable over the server yet" — needs the Drive-direct file path |

## See also

- [`file-sync.md`](./file-sync.md) — the file-bytes plane in depth (adapters,
  hash identity, two-layer state).
- [`central-file-content-phase-b.md`](./central-file-content-phase-b.md) — scope
  of the unbuilt cell.
- `docs/superpowers/plans/2026-06-10-central-cutover.md` — the Phase A cutover
  that shipped the graph over the server.
