# Phase B — file content over the central server (scoping)

> **Status:** not started (scoping only). Background:
> [`data-modes.md`](./data-modes.md), [`file-sync.md`](./file-sync.md).
>
> **Goal:** a **central-mode** teammate can browse, read, and edit file
> **content** through `api.portuni.com` — permission-enforced — **without a
> local mirror**. Closes the one empty cell in the data-modes 2x2.

## Why it is not free

The current file-content path is **mirror-bound**:
`readFileContent` / `writeFileContent` (`apps/server/domain/sync/file-content.ts`)
resolve `getMirrorPath(userId, nodeId)` and then `readFile` / `writeFile` against
a folder **on the local disk**. Saving writes the **mirror file only and never
pushes**; Drive upload is a separate `POST /nodes/:id/sync`.

The central server is the **same backend on a VPS** with **no mirror folders**.
So `getMirrorPath` returns null there and the route would 409 `NO_MIRROR` — and
in practice the desktop proxy already short-circuits it to `501 local_only`
(`is_local_only_path`, `apps/desktop/src/lib.rs`). Phase B must add a **mirror-less,
Drive-direct** file-content service.

## Assets already in place (these shrink the scope a lot)

- **Drive adapter via Service Account on a Shared Drive** — `get` / `put` /
  `stat` / `list` / `rename` / `delete` / `url`
  (`apps/server/domain/sync/drive-adapter.ts`, `FileAdapter` in `types.ts`). The SA is a
  **shared identity**: the server can reach the same Shared Drive without any
  teammate's personal Drive credentials.
- **Remote-path resolution** — node + section + relpath -> remote path
  (`apps/server/domain/sync/remote-path.ts`, `routing.ts`, `adapter-cache.ts`).
- **Canonical hash / shared state in Turso** — file records already carry the
  authoritative hash (`hash is identity`).
- **Server-side permission enforcement** — node-access / group visibility in
  `apps/server/auth/`, already applied to graph routes.
- **The central server is the same codebase** — same handlers, same
  `getAdapter`, reachable Turso. Deploy path exists (`scripts/deploy-vps.sh`).

So the new surface is narrow: a file-content service that talks to the **adapter**
instead of the **mirror**, plus conflict detection against the **remote/Turso
hash** instead of a per-device `sync.db`.

## What Phase B must build

1. **Remote-direct file-content service** (new module, e.g.
   `apps/server/domain/sync/file-content-remote.ts`):
   - read: resolve remote path -> `adapter.get(remotePath)` -> bytes.
   - write: `adapter.put(remotePath, bytes)`; on success update the Turso file
     record hash. No local mirror, no `sync.db`.
   - `version` stays the SHA-256 of the bytes, so the editor's optimistic-
     concurrency contract (`baseVersion` / `FileConflictError`) is unchanged
     for the UI.
2. **Conflict model without `sync.db`:** `baseVersion` is checked against the
   **current remote hash** (Turso canonical hash, optionally re-confirmed via
   `adapter.stat().hash`). Mismatch -> `409 CONFLICT` with `currentVersion`,
   same shape the UI already handles.
3. **Listing / lifecycle over the server:** `GET /nodes/:id/files` must read from
   **Turso file records** (graph plane), not the disk. Confirm the list handler
   is not mirror-dependent; if create/rename/delete are wanted in central mode,
   reimplement them adapter-direct (current `engine-mutations.ts` is disk-bound).
   Reasonable phasing: ship **read + edit** first, defer create/rename/delete.
4. **Native formats (gdoc / gsheet / gslide):** not plain-text round-trippable.
   Scope as **read-only**: reject `PUT` with `NOT_EDITABLE` and route the user to
   the Drive web URL (`/nodes/:id/folder-url` already stays central). Optionally
   `adapter.export()` for read-only preview.
5. **Loosen the proxy gate:** make `is_local_only_path` finer-grained so that,
   in central mode, **file-content** routes (`/nodes/:id/file`, and later
   `/files`) are forwarded to the server once it supports them — while
   **mirror / sync / sandbox / scope** stay `local_only` (they genuinely need a
   disk; central teammates have none). Update the Rust unit tests
   (`mod local_only_path_tests`).
6. **Server secrets / deploy:** the VPS env needs the **Service Account JSON**
   (`PORTUNI_REMOTE_<NAME>__SERVICE_ACCOUNT_JSON`, see
   `token-store-varlock.ts`) plus Turso creds. Verify `docs/env-vars.md` and the
   deploy unit are updated.
7. **Permission checks on every file op:** read and write must pass through the
   same node-access enforcement as graph routes, so group visibility is honored
   per file.

## Explicitly out of scope (stays local-only by nature)

These need the user's own machine; central teammates do not use them, so they
remain `local_only` and should **not** be REST-ified in Phase B:

- **Local mirror folders** and the bidirectional mirror sync engine (a central
  client has no folder to sync — it does direct Drive I/O instead).
- **Agent terminals (PTY), sandbox profiles, write-scope** — disk- and
  OS-bound, desktop-only.

## Open decisions

- **Concurrency:** keep hash-based optimistic concurrency (recommended — matches
  local behavior) vs. introduce a lock. Default: optimistic.
- **Latency / caching:** every read hits Drive. Consider a short server-side
  cache keyed by canonical hash; measure before adding.
- **Large / binary files:** stream vs. buffer; enforce a size ceiling (local
  warns at 100 MB, `WARN_SIZE_BYTES` in `engine.ts`).
- **Create / rename / delete in central mode:** include now or defer to B3
  (recommended: defer; read+edit covers the primary teammate need).

## Suggested phasing within Phase B

- **B1 — read-only over server:** browse + view file content in central mode.
  Lowest risk; no write/conflict surface.
- **B2 — edit over server:** `PUT` with conflict-on-remote-hash; update Turso
  record.
- **B3 — create / rename / delete over server:** adapter-direct lifecycle.

## Rough effort

Comparable to a single focused implementation session. The adapter, path
resolution, auth, and Turso state already exist; the genuinely new work is the
**mirror-less file-content service + remote-hash conflict + proxy gate change +
VPS secrets**. The original cutover plan flagged Phase B as "samostatná session,
mimo tento plán" (`docs/superpowers/plans/2026-06-10-central-cutover.md`); this
doc is its concrete scope.
