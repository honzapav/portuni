# Deterministic file state — design

**Date:** 2026-06-28
**Status:** draft for review
**Topic:** Make local file state (registration + sync status) deterministic and
agent-independent — "GitHub Desktop for non-technical people, over a cloud
storage adapter (Google Drive)."

---

## Problem

In a Portuni mirror, the file sync status shown in the desktop app is stale. A
file edited on disk keeps showing `synced` until something explicitly recomputes
it. Reproduced in session `b8237195-7015-450b-942a-0cd845a560d3`: an agent
edited `stakeholder-rozhovory.md` in a mirror, the UI kept showing the file as
synced, and the status only flipped to `push` once the agent manually ran
`portuni_status`.

Two things are non-deterministic today, both depending on a human or an AI
remembering to act:

1. **Registration.** A newly created file is only tracked once someone calls
   `portuni_store` (agent) or runs "Synchronizovat" (which adopts untracked
   files during the sync run). CLAUDE.md / the MCP tool description instruct the
   agent "call `portuni_store` immediately after creating a file" — an
   instruction, not an enforced mechanism.
2. **Status currency.** After an edit, the agent is told to call
   `portuni_status`. The UI itself only polls.

## Root cause

`statusScan` (`apps/server/domain/sync/engine.ts:647`) has two modes:

- **slow** (`localHashFor`, `engine.ts:418`): compares mtime+size against the
  sync DB cache; when the file changed it re-hashes the disk live and updates
  `cached_local_hash`.
- **fast** (`a.fast`, `engine.ts:570`): returns `cached_local_hash` straight
  from the sync DB, never touching disk.

The UI status endpoints run **fast**:

- `/nodes/:id/sync-status` → `statusScan({ fast: true })` (`apps/server/api/nodes.ts:291`).
- `/sync/pending` → `computeSyncPending` (cache-based aggregate).

So the UI shows "what we last knew." `cached_local_hash` is only refreshed by a
slow scan, a `storeFile`, or a sync run. **Nothing updates it when a file
changes on disk through any other writer** — an agent's `Edit`, an external
editor, or the in-app editor's save. The badge therefore keeps showing the last
cached class (e.g. `clean`) until a slow path runs.

There is **no filesystem watcher anywhere** in the codebase (confirmed across
`apps/server` TS and `apps/desktop` Rust).

## Goal

The per-session source of truth for "what is on disk" must be kept current
**deterministically, by the system, outside the agent**, covering every writer
— agent, in-app editor, and external editor. A file created through Portuni (now
possible via the in-app New file form / editor) is registered automatically.

## Non-goals

- **No auto-push.** Registration and status are deterministic; uploading bytes
  to the remote (Drive/Turso content) stays the explicit "Synchronizovat"
  action — exactly the git model: working tree tracked automatically, `push`
  deliberate.
- **No real-time remote-change detection.** "Behind / pull needed" continues to
  be discovered on a sync run, not pushed from Drive. This design is about the
  **local** side.
- **Desktop-primary.** The watcher runs in the desktop sidecar. Web / central
  mode is out of scope (central mode has no local mirror; the status endpoint
  already returns `local_only` there).
- **No PostToolUse agent hook.** We deliberately do not add an agent-harness
  hook to call store/status. The watcher is the single mechanism, so the
  agent's role drops to zero — matching "outside the agent, maybe not even when
  it edits."

## Mental model (GitHub over Drive)

| Git / GitHub Desktop | Portuni |
|---|---|
| working tree | mirror folder |
| remote (GitHub) | Google Drive via storage adapter |
| `git status` (modified / new) | sync state (`push`, new files) — **live, deterministic** |
| `git add` (start tracking) | file registration — **automatic** |
| `git push` / sync in GH Desktop | "Synchronizovat" — **deliberate** |

GitHub Desktop keeps its changed-files list live precisely by watching the
working tree. That is the missing piece here.

## Architecture

A new module — the **mirror watcher** — lives in the server process
(`apps/server`), so it runs inside the desktop sidecar (and, gated by an env
flag, in the standalone dev server for testing). It is the one component that
keeps the sync DB's view of disk current.

```
disk change (any writer)
        │
        ▼
  mirror watcher  ──►  reconcile(path)  ──►  sync DB (files row + file_state cache)
        │                                          │
   (debounced)                                     ▼
                                       fast-mode UI reads are now correct
```

### What it watches

- On boot, enumerate registered mirrors (`listUserMirrors(userId)`) and watch
  each mirror root recursively.
- Respect the existing ignore policy (`loadMirrorIgnore`,
  `apps/server/domain/sync/mirror-ignore.ts`): dotfiles/dot-dirs (this already
  excludes the `.portuni-scope/` staging dir and `.git/`), the default junk
  list, and `.portuniignore`.
- Pick up newly created subdirectories (watch them too) and newly registered
  mirrors (re-enumerate when a mirror is created).

### Events → actions

All actions are debounced per path (~300 ms) to collapse the multi-event bursts
editors produce with atomic save (write temp → rename).

- **File created** (not ignored, no existing `files` row): **register-only** —
  create the `files` row + `file_state` with the freshly computed
  `cached_local_hash`, `last_synced_hash = NULL`, **no upload**. The file now
  shows as pending-upload. This is the new "auto `git add`, don't push"
  capability.
- **File modified** (has a `files` row): re-hash and upsert `cached_local_hash`
  + mtime + size (the same write `localHashFor` does in slow mode). Fast-mode
  reads then classify it `push`.
- **File deleted** (has a `files` row): mark it locally so status reports
  `deleted_local` (`missing`). **Never** auto-delete the remote — matches
  current semantics (a local delete may be intentional; the user resolves via
  `portuni_pull` or `portuni_delete_file`).

### New capability: register-only

Today there is no "register without upload." `storeFile` (`engine.ts:67`)
registers **and** uploads; `adoptFiles` registers a file that already exists on
the remote. We add a register-only path (e.g. `registerLocalFile` in
`engine.ts`) that:

- assigns the routed remote name + remote_path (via existing routing) so the
  file has a stable destination,
- writes the `files` row and `file_state` with `cached_local_hash` set and
  `last_synced_hash = NULL`,
- does **not** call the adapter.

The classification of "registered, never uploaded" must read as **pending
upload** (`push`), not `orphan`/`conflict`. `scanRow` currently routes a
registered file whose remote does not yet exist to `orphan` (`engine.ts:581`).
This design adds an explicit "never-uploaded" signal (e.g. a `file_state` flag
or a sentinel) so such a file classifies `push`. The existing "Synchronizovat"
push phase already calls `storeFile` for push candidates, so it will upload
these on the next deliberate sync.

### Why fast mode stays

We keep the UI on fast mode. The watcher makes fast mode correct by keeping the
cache current. This is cheaper than switching the UI to slow mode (which would
re-hash on every poll across every mirror for the cross-mirror aggregate) and it
works regardless of which node the UI is showing or whether the app is polling.

### UI

- The existing per-node 5 s poll (`DetailPane.tsx:402`) and 30 s aggregate poll
  (`use-sync-pending.ts`) now read a cache the watcher keeps fresh, so they
  reflect reality within poll latency without any code change.
- **In-app save feels instant (proposed for v1):** `use-file-editor.doSave`
  (`use-file-editor.ts:55`) triggers an immediate per-node sync-status refetch
  after a successful save, so a file edited in Portuni's own editor updates its
  badge at once rather than waiting for the poll. (See open question 2.)
- *(Optional fast-follow, not v1)* push watcher events to the webview
  (SSE or Tauri event) for instant updates from any writer.

### Process ownership / contention

The watcher is gated behind an env flag (e.g. `PORTUNI_WATCH_MIRRORS=1`) that
the desktop app sets when it spawns the sidecar. The standalone dev server
leaves it off by default to avoid two processes writing the same local sync DB.

### Agent instruction changes

Once registration + status are deterministic, the agent obligations are removed:

- CLAUDE.md: drop "your next action MUST be `portuni_store`" and "call
  `portuni_status` before ending the turn"; replace with a one-line note that
  file state is maintained automatically.
- MCP tool descriptions for `portuni_store` / `portuni_status` lose the
  "call immediately after creating a file" imperative (the tools remain
  available for explicit / scripted use, just no longer mandatory).
- The existing PreToolUse `portuni-guard` (write-scope enforcement) is
  unrelated and stays.

## Considered alternatives

- **Switch UI endpoints fast → slow.** Makes the *displayed* status correct on
  read for the active node, but does **not** make registration deterministic
  (discovery only *reports* new files; registering them still needs an explicit
  store/sync), makes the cross-mirror aggregate expensive, and only updates
  while the app polls that node. Rejected as a partial fix.
- **PostToolUse agent hook** (sibling of `portuni-guard`). Deterministic only
  for edits made through an agent's tools; blind to the user's own editor and
  external editors — fails the core requirement. Rejected.
- **Rust `notify` watcher in the desktop shell.** Native and enables instant UI
  push, but the registration/hash/adopt logic all lives in the TS sidecar, so
  Rust would have to call back over HTTP — more moving parts for no extra
  coverage. Kept as a possible future enhancement for instant push only.

## Error handling

- Watcher failures are best-effort and must never crash the sidecar; log and
  continue. A missed event degrades to the existing slow-scan-on-demand
  behavior (correct, just not instant).
- Reconcile per path is idempotent (re-hash + upsert), so duplicate/coalesced
  events are safe.
- On watcher startup, run one slow `statusScan` per mirror to backfill the cache
  for changes that happened while the watcher was down.

## Testing

- Unit: `registerLocalFile` writes a `files` row + `file_state` with
  `last_synced_hash = NULL` and no adapter call; classification of a
  never-uploaded registered file is `push`.
- Unit: reconcile on modify updates `cached_local_hash`; a subsequent
  `fast: true` `statusScan` returns `push`.
- Unit: reconcile on delete yields `deleted_local`; reconcile on create of an
  ignored path is a no-op.
- Integration (temp dir): create → modify → delete a file under a fake mirror,
  drive the reconcile entry points directly (no real FS-event timing in tests),
  assert sync DB state after each.
- Debounce / ignore are pure helpers, tested in isolation.

## Open questions

1. **Never-uploaded signal.** Flag on `file_state` vs. a sentinel
   `last_synced_hash` — implementation plan to pick the least invasive that
   keeps `scanRow` classification clean.
2. **In-app save instant refetch** — confirm this small UI change is in v1
   (recommended) or deferred with the rest of the instant-push work.
3. **Backfill scan cost** on watcher boot for users with many/large mirrors —
   may need to be incremental or backgrounded.
