# File Sync Adapter – design

> **Status:** Phase 1 implemented April 2026. Google Drive (Service Account) is the first concrete adapter. Pluggable interface, hash identity, two-layer state, per-device sync.db, confirm-first ops are all live. See `src/sync/` for the implementation and `src/sync/README.md` for the user-facing summary.

Design for a pluggable file synchronization layer in Portuni. Replaces the current Drive-only, hardcoded assumptions in `files` and `file_sync` tables with a backend-agnostic adapter model that can target Google Drive, Dropbox, S3-compatible object storage, WebDAV, SFTP, or a local filesystem through one interface.

## Problem

Portuni stores knowledge as a graph. Files attached to graph nodes (reports, transcripts, code, notes) currently live only in a local mirror folder – `portuni_store` copies files locally but does not push anywhere remote. The schema (`files.drive_file_id`, `files.drive_url`, `file_sync.synced_at`) was pre-dimensioned for Google Drive, but no Drive integration exists.

Two goals drive this design:

1. **Team context sharing.** The point of Portuni is a shared knowledge graph. Files attached to nodes must travel with the graph, accessible to every team member and every agent.
2. **No vendor lock-in.** "Drive" is today's choice, not a forever commitment. The system must support switching or mixing backends (Dropbox for one client, S3 for archives, local FS for sensitive material) without rewriting the sync layer.

Near-term use case is one user across two machines. Architecture must scale to a small team without rework.

## Core insight

Two design choices reduce the entire sync problem to a tiny, robust core.

### 1. Hash is identity

Files are identified by their content hash (SHA-256 computed locally, MD5 pulled from remote metadata where available). Paths, names, and timestamps are just labels. This means:

- **Conflict detection is deterministic.** Compare current local hash, current remote hash, and last-seen hash from local cache. Four outcomes, no ambiguity, no timestamp skew.
- **Moves and renames are free.** A file moved locally still has the same hash – the system recognizes it and can propose remote rename instead of re-upload.
- **Works across backends.** Every storage backend exposes some checksum (Drive: md5Checksum, Dropbox: content_hash, S3: ETag, FS: computed SHA). The adapter normalizes to one field.

### 2. Two-layer state

Sync state splits between shared and private:

- **Shared state in Turso** holds what everyone agrees on: current canonical remote hash, who last pushed, when. One row per file.
- **Private state in per-device SQLite** holds what each machine has seen: last synced hash, last sync timestamp. One row per file per device, local only.

No device_id column is needed in Turso. Each device has its own cache file it owns. Team members joining later plug into the same Turso state without schema migration.

This splits "truth about the world" (shared) from "memory of what I last saw" (local). Both rsync and git use variants of this pattern.

## Architecture

Four layers, bottom to top:

```
MCP tools                   portuni_store / portuni_pull
                            portuni_status / portuni_snapshot
                            portuni_delete_file / portuni_move_file
                            portuni_adopt_files / portuni_rename_folder
       |
       v uses
Sync engine                 hash compute, state diff,
                            routing policy resolution,
                            conflict classification
       |
       v reads/writes              uses
State layer                              FileAdapter
  Turso (canonical)                        OpenDALAdapter
  local SQLite (per-device memory)         (future: direct SDKs)
                                           |
                                           v wraps
                                  OpenDAL (Rust, Node.js binding)
                                    Drive, Dropbox, S3, WebDAV, SFTP, FS
```

### Component responsibilities

- **MCP tools** – the only external surface. Every operation is explicit, invoked by a user or agent. No background daemon.
- **Sync engine** – the business logic. Stateless beyond what the two state stores hold. Every operation computes state from scratch at call time.
- **State layer** – Turso for canonical remote state (one file, one row, everyone sees the same thing). Local SQLite at `$PORTUNI_WORKSPACE_ROOT/.portuni/sync.db` for per-device memory.
- **FileAdapter** – pluggable interface. First implementation wraps OpenDAL. Future implementations can use direct SDKs if OpenDAL falls short for a specific backend.
- **OpenDAL** – the unified storage abstraction. Handles 50+ backends through one API. Installed as `npm i opendal`, loads as a native module into the Portuni MCP server process.

## Data model

### Schema changes in Turso

```sql
-- New: named remote configurations
CREATE TABLE remotes (
  name TEXT PRIMARY KEY,          -- e.g. "projects-hub", "drive-workflow"
  type TEXT NOT NULL,             -- "gdrive", "dropbox", "s3", "fs", "webdav", "sftp"
  config_json TEXT NOT NULL,      -- backend-specific config (shared_drive_id, bucket, root_path, ...)
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- New: routing policy, evaluated top-down, first match wins.
-- id is a surrogate key so multiple rules can coexist at the same priority.
CREATE TABLE remote_routing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  priority INTEGER NOT NULL,
  node_type TEXT,                 -- NULL matches any type
  org_slug TEXT,                  -- NULL matches any org
  remote_name TEXT NOT NULL REFERENCES remotes(name) ON DELETE RESTRICT
);
CREATE INDEX idx_remote_routing_priority ON remote_routing(priority);

-- Files table: remove Drive-specific columns, add adapter-agnostic ones
ALTER TABLE files DROP COLUMN drive_file_id;
ALTER TABLE files DROP COLUMN drive_url;
ALTER TABLE files DROP COLUMN local_path;         -- derived from local_mirrors + remote_path
ALTER TABLE files ADD COLUMN remote_name TEXT;    -- FK to remotes.name
ALTER TABLE files ADD COLUMN remote_path TEXT;    -- full path within remote's root
ALTER TABLE files ADD COLUMN current_remote_hash TEXT;
ALTER TABLE files ADD COLUMN last_pushed_by TEXT;
ALTER TABLE files ADD COLUMN last_pushed_at DATETIME;
ALTER TABLE files ADD COLUMN is_native_format INTEGER DEFAULT 0;  -- 1 for Google Docs etc.

-- file_sync table is removed entirely.
-- Per-device hash state moves to local SQLite (see below).
-- Per-user audit of pull/push actions already flows through audit_log.
DROP TABLE file_sync;
```

When `is_native_format = 1`, the file is a link-only pointer (Google Doc, Notion page).
`current_remote_hash` stays NULL for native files; `modified_at` tracked on remote is the only change signal.
The column is set by `portuni_adopt_files` when importing links and by `portuni_snapshot` when the exported artifact is stored as a regular hashed file (is_native_format = 0 on the snapshot).

### Local cache SQLite (per-device)

Location: `$PORTUNI_WORKSPACE_ROOT/.portuni/sync.db`

```sql
CREATE TABLE IF NOT EXISTS file_state (
  file_id TEXT PRIMARY KEY,              -- matches Turso files.id
  last_synced_hash TEXT NOT NULL,
  last_synced_at DATETIME NOT NULL,
  cached_local_hash TEXT,                -- hash of local file at last check
  cached_mtime INTEGER,                  -- unix ms, for cache invalidation
  cached_size INTEGER                    -- bytes, for cache invalidation
);

CREATE INDEX file_state_cached_hash ON file_state(cached_local_hash);

CREATE TABLE IF NOT EXISTS remote_stat_cache (
  file_id TEXT PRIMARY KEY,
  remote_hash TEXT,
  remote_modified_at DATETIME,
  fetched_at DATETIME NOT NULL            -- used for 30s debounce in portuni_status
);
```

Two tables:

- `file_state` – the authoritative "what I last saw" record, plus a cached local hash keyed by (mtime, size) so we can skip rehashing unchanged files. Same trick as rsync and git.
- `remote_stat_cache` – short-lived cache for remote stat results, so rapid successive `portuni_status` calls don't hammer the Drive API.

## FileAdapter interface

```typescript
export interface FileRef {
  path: string;                  // full path within remote's root
  hash: string | null;           // md5/sha256; null for native formats
  size: number;
  modified_at: Date;
  is_native_format: boolean;     // true for Google Docs/Sheets/Slides
  native_format?: "gdoc" | "gsheet" | "gslide" | "notion_page";
}

export interface FileAdapter {
  put(path: string, content: Buffer, opts?: { mimeType?: string }): Promise<FileRef>;
  get(path: string): Promise<Buffer>;
  stat(path: string): Promise<FileRef | null>;    // null = not found
  list(prefix: string): Promise<FileRef[]>;       // recursive
  delete(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  url(path: string): Promise<string>;             // browser-viewable URL
  export?(path: string, format: "pdf" | "markdown" | "docx"): Promise<Buffer>;
}

export interface RemoteConfig {
  name: string;
  type: "gdrive" | "dropbox" | "s3" | "fs" | "webdav" | "sftp";
  config: Record<string, unknown>;
}

export interface DeviceTokens {
  [remoteName: string]: {
    access_token?: string;
    refresh_token: string;
  };
}

export function createAdapter(remote: RemoteConfig, tokens: DeviceTokens): FileAdapter;
```

Seven core methods plus optional `export()` for native formats. Adapter factory takes a remote config plus device-local tokens and returns a ready adapter. Adapters are cached per remote_name within one server process so we do not rebuild OpenDAL operators on every call.

## Routing policy

The `remote_routing` table maps (node_type, org_slug) to a named remote. Resolution is top-down, first match wins. Example policy for a team with workflow + tempo + nautie organizations:

| priority | node_type | org_slug | remote_name |
|---|---|---|---|
| 10 | project | * | projects-hub |
| 20 | process | workflow | drive-workflow |
| 20 | area | workflow | drive-workflow |
| 20 | principle | workflow | drive-workflow |
| 20 | process | tempo | drive-tempo |
| 20 | area | tempo | drive-tempo |
| ... | ... | ... | ... |
| 99 | * | * | default-fallback |

Resolution algorithm inside sync engine:

```
1. Read node.type and resolve node's organization (belongs_to edge).
2. SELECT remote_name FROM remote_routing
   WHERE (node_type = $type OR node_type IS NULL)
     AND (org_slug = $org OR org_slug IS NULL)
   ORDER BY priority ASC LIMIT 1
3. Load remote config from remotes table.
4. Instantiate or reuse FileAdapter for that remote.
```

Remote paths are composed from routing plus node slug plus optional user-provided subpath:

```
{remote root implied by adapter}/{org_slug}/{type_plural}/{node_slug}/{wip|outputs|resources}/{subpath}/{filename}
```

For the Projects Hub (no per-org subdivision), the org component is elided:

```
projects/{node_slug}/{wip|outputs|resources}/{subpath}/{filename}
```

Solo-mode setup: one remote, one wildcard rule, no per-org complexity. Adding organizations later is a policy change, not a code change.

## MCP tool contracts

### portuni_store

```
Input:  { node_id, local_path, description?, status?, subpath? }
        - subpath: optional nested folder within wip|outputs|resources
        - If local_path sits inside the node's mirror, the subpath is auto-detected
          from the relative path.

Algorithm:
  1. Load node, verify it has a local mirror.
  2. Determine target remote via routing policy.
  3. Build remote_path from routing + subpath + filename.
  4. If file is not already at the mirror path, copy it in.
  5. Compute SHA-256 of local content. Warn if size > 100 MB.
  6. Call adapter.put(remote_path, content, { mimeType }).
  7. Upsert files row: remote_name, remote_path, current_remote_hash,
     last_pushed_by, last_pushed_at, updated_at.
  8. Update local sync.db file_state: last_synced_hash = local hash, last_synced_at = now,
     cache (mtime, size, hash).
  9. Write audit entry.

Output: { file_id, remote_name, remote_path, hash, url }

Errors:
  - node_not_found
  - remote_not_configured         (routing matched no remote)
  - remote_not_authenticated      (no token in varlock for this device)
  - local_file_not_found
  - upload_failed                 (network, permissions, quota)
```

### portuni_pull

Two-mode tool. Mode is determined by presence of `file_id` vs `node_id`.

```
Mode A – pull single file:
  Input:  { file_id }
  Does:   Downloads remote content, writes to derived local path,
          updates local sync.db file_state.
  Output: { file_id, local_path, hash }

Mode B – preview node (no side effects):
  Input:  { node_id }
  Does:   Runs the same diff logic as portuni_status but scoped to one node.
          Does not modify any file or state.
  Output: {
    files: [{
      file_id, filename,
      status: "new"|"updated"|"unchanged"|"conflict",
      remote_hash, local_hash, last_synced_hash
    }]
  }
```

The agent typically calls Mode B, presents to the user, then calls Mode A for each file the user confirms.

### portuni_status

Primary operator visibility tool. Called at session end, on demand, or before migrations.

```
Input:  { node_id?, remote_name? }
        - No args: scan all mirrors on this device.
        - node_id: scope to one node.
        - remote_name: scope to files on one backend.

Algorithm:
  For each relevant files row:
    1. local_hash = read from sync.db cache if (mtime, size) unchanged,
                    else compute SHA-256 and update cache.
    2. remote_stat = adapter.stat(remote_path), with 30s debounce from remote_stat_cache.
    3. last_synced_hash = sync.db file_state.
    4. Classify:
       in_sync         local = last_synced = remote
       push            local != last_synced, remote == last_synced
       pull            local == last_synced, remote != last_synced
       conflict        local != last_synced, remote != last_synced
       new_local       local file present, no files row
       new_remote      files row present, no local file, no sync.db entry (never had it locally)
       deleted_local   files row present, no local file, sync.db entry exists (had it, then removed)
       orphan          files row present, local may or may not exist, remote returned null
       native          is_native_format = true (report modified_at only)

  Also run move detection:
    5. missing = files rows where local file is absent.
    6. unknown_local = files on disk not matching any row.
    7. For each unknown_local, if its hash matches a missing row's last_synced_hash,
       mark as "moved" candidate. Collapse large same-prefix shifts into folder renames.

Output: {
  clean: [...], push: [...], pull: [...], conflict: [...],
  new_local: [...], new_remote: [...], deleted_local: [...],
  orphan: [...], native: [...],
  moved: [{ file_id, old_path, new_path, hash }],
  renamed_folders: [{ old_prefix, new_prefix, file_ids: [...] }]
}

For deleted_local entries, the payload includes resolution_options so the agent
can offer: restore_from_remote (pull it back), propagate_delete (delete remote
and unregister), unregister_only (keep remote, drop Portuni row).
```

### portuni_snapshot

Exports a native-format file (Google Doc, Notion page) to a fixed format and stores the result as a regular tracked file.

```
Input:  { doc_url, node_id, format?, filename?, subpath? }
        - format: "pdf" | "markdown" | "docx"  (default "pdf")

Does:   1. Resolve adapter for doc_url (e.g. Drive adapter if it's a Docs URL).
        2. Call adapter.export(remote_path, format).
        3. Feed the buffer into portuni_store logic: write to mirror, upload to
           target remote per routing, create files row.

Output: { file_id, filename, remote_path }
```

### portuni_delete_file

Explicit deletion with two modes distinguishing "gone everywhere" from "unregister only", protected by a confirm-first contract (see Data safety section).

```
Input:  { file_id, mode?: "complete" | "unregister_only", confirmed?: boolean }

If confirmed is not true:
  Returns a preview { action, file, mode, will_remove_from: [...] }.
  No side effects.

If confirmed is true:
  mode = "complete" (default):
    1. adapter.delete(remote_path)     // Drive: soft-deletes to trash (30d recovery)
    2. fs.rm(derived local path)       // if the local file exists
    3. DELETE FROM files WHERE id = file_id
    4. DELETE FROM local sync.db.file_state WHERE file_id = file_id
    5. Audit log entry (before_state includes old hashes and paths).

  mode = "unregister_only":
    1. DELETE FROM files WHERE id = file_id
    2. DELETE FROM local sync.db.file_state WHERE file_id = file_id
    3. Local file and remote content untouched.
    4. Audit log entry.

Output (confirmed): { file_id, mode, deleted_at }
```

Drive's trash gives a 30-day recovery window. If a user needs a hard permanent delete
for compliance reasons, add a `permanent: true` flag in a future iteration; not part
of Phase 1.

### Supporting tools

- **portuni_setup_remote** `{ name, type, config }` – admin, one-time per remote, creates `remotes` row.
- **portuni_set_routing_policy** `{ rules }` – admin, rare, rewrites `remote_routing`.
- **portuni_connect_device** `{ remote_name? }` – per-device OAuth flow, stores tokens in varlock.
- **portuni_list_remotes** – diagnostic, shows configured remotes and auth status on this device.
- **portuni_move_file** `{ file_id, new_subpath?, new_node_id? }` – explicit move within node or across nodes.
- **portuni_rename_folder** `{ node_id, old_prefix, new_prefix }` – bulk prefix rename, atomic in DB, best-effort on remote.
- **portuni_adopt_files** `{ node_id, paths, status? }` – register existing remote or local files that have no `files` row.

## Move and rename handling

Two complementary mechanisms. Hash-as-identity makes both robust.

### Automatic detection

`portuni_status` scans for:

1. **Missing files** – rows where local file is absent.
2. **Unknown local files** – files on disk with no matching row.
3. **Hash matches** between the two sets – these are moves. The algorithm proposes the rename to the user; on confirmation, sync engine calls `adapter.rename(old, new)` (most OpenDAL backends support this natively) and updates `files.remote_path`. No re-upload.
4. **Folder renames** collapse N same-prefix moves into one prompt.

This handles the common case where a user reorganizes in Finder or on Drive's web UI without touching Portuni.

### Explicit tools

For cases where the user wants certainty rather than detection:

- `portuni_move_file` for single-file operations.
- `portuni_rename_folder` for bulk prefix shifts.
- Cross-remote moves (new_node_id on a different remote) fall back to get+put+delete. Same-remote moves use adapter.rename().

### Node rename

When a node's name changes, its slug changes, which cascades to every file's remote_path. `portuni_sync_mirrors { node_id }` (already in the main spec) detects the mismatch and renames the root folder on the remote in one call. OpenDAL rename on a folder is one Drive API operation.

## Limits and constraints

### Google Drive API

As of April 2026:

- 20,000 calls per 100s per user and per project (combined read + write).
- 3 sustained writes per second per account (hard limit, cannot be raised).
- 5 TB per-file size limit.
- 750 GB per-user per-day upload quota (refreshes after 24h).
- No cost for the API itself; storage consumes the user's Workspace quota.

Practical implications for Portuni:

- Write rate is the binding constraint. `portuni_store` issues 2–3 API calls per file. Sustained throughput is roughly one store per second. Bulk operations (indexing 500 files) take minutes, not hours.
- `portuni_status` reads are well within quota. For 200 files it makes 200 stat calls, comfortably parallelizable to complete in ~20 seconds.
- Quota errors (403, 429) are handled by OpenDAL's built-in exponential backoff.

### Large files

- Files up to 5 TB work. Upload time is network-bound; OpenDAL streams content and supports Drive's resumable upload so interrupted transfers resume from the last checkpoint.
- Hashing cost is mitigated by the (path, mtime, size) cache in sync.db. First hash of a 5 GB video takes ~15-30 seconds; subsequent status checks reuse the cached hash at no cost unless the file changes.
- `portuni_store` warns before uploading files over 100 MB. User confirms.

### Google Docs and similar native formats

No hash, no roundtrip sync. Portuni tracks the URL and modifiedTime. Explicit snapshot tool produces a hashed PDF/docx that becomes a regular tracked file. See the owned-vs-linked distinction in `docs/conceptual-map.md`.

## Data safety

Deliberate defensive layers so a sync bug, a misclick, or a race condition cannot quietly lose data.

### Seven defensive properties

1. **Soft-delete by default.** `adapter.delete()` on Drive sends files to trash (30-day recovery window), never permanent-delete. A `permanent: true` flag would be explicit opt-in; not part of Phase 1.

2. **Confirm on destructive.** `portuni_delete_file` and `portuni_rename_folder` without `confirmed: true` return a preview describing what *would* happen (count, paths, total size) and perform no action. Agents must present the preview to the user and receive explicit confirmation before calling again with `confirmed: true`.

3. **Post-upload hash verification.** After `adapter.put()`, the sync engine calls `adapter.stat()` and compares the remote hash against the hash of the bytes sent. On mismatch, `current_remote_hash` is not updated and an error is raised. This catches silent corruption mid-upload.

4. **Respect Drive versioning.** Google Drive keeps file version history for 30 days automatically. Portuni never uses API flags that disable or reset it (e.g. `keepRevisionForever = false` is left default, `keepForever` handling is pass-through). Drive versioning is the safety net under Portuni's own layer.

5. **Dry-run mode for batch operations.** `portuni_rename_folder { dry_run: true }` and any future batch tools return a full change plan without executing it. Agent presents, user confirms, agent calls again without dry_run.

6. **Atomic move.** `portuni_move_file` treats remote rename + DB update as one logical unit. If remote rename succeeds and DB update fails, the rename is reverted. If remote rename fails, DB is untouched. Full audit entry regardless.

7. **Audit log for every destructive op.** `store`, `pull`, `move_file`, `rename_folder`, `delete_file`, `adopt_files` all log: user, action, before_state (including old hashes / paths), after_state, timestamp. Same table as existing graph audit, extended with file-scoped action types. The audit log is append-only and never rewritten.

### What Portuni explicitly is not

- **Not a backup system.** Portuni holds one current version of each file. History lives in Drive's versioning (30 days automatic) or in the user's own backup strategy (Time Machine, external disk, cloud backup). Portuni does not duplicate that layer.
- **Not automatic recovery.** Restoring deleted files happens through Drive's trash, Drive's version history, or OS-level trash. There is no `portuni_restore` tool. The design is: multiple independent layers, each with its own recovery path, Portuni does not try to be all of them.
- **Not a file watcher.** No background daemon observes your filesystem for changes. If you want push-without-asking, use Dropbox or Syncthing alongside. Portuni's role is explicit publish with integrity and graph-aware context.

### Confirmation contract for destructive tools

```
First call (unconfirmed):
  Input:  { file_id, mode }
  Output: {
    preview: {
      action: "delete",
      file: { filename, remote_path, size, current_remote_hash },
      mode: "complete" | "unregister_only",
      will_remove_from: ["remote_drive", "local_disk", "portuni"]  // or subset
    },
    requires_confirmation: true,
    next_call: "portuni_delete_file with confirmed: true"
  }

Second call (confirmed):
  Input:  { file_id, mode, confirmed: true }
  Output: { file_id, mode, deleted_at }
```

The two-call protocol ensures agents always surface the consequence before executing. User can also set `confirmed: true` on the first call when they are scripting known-safe batches.

## Conflict resolution UX

When `portuni_status` classifies a file as conflict, the payload carries enough context for the user to choose:

```json
{
  "file_id": "01FOO...",
  "filename": "report.pdf",
  "reason": "both_modified",
  "local_hash": "abc123",
  "local_modified_at": "2026-04-24T09:15:00Z",
  "remote_hash": "def456",
  "remote_modified_at": "2026-04-24T11:30:00Z",
  "remote_modified_by": "alice@example.com",
  "last_synced_hash": "ghi789",
  "last_synced_at": "2026-04-23T20:00:00Z",
  "resolution_options": [
    "keep_local_push",
    "keep_remote_pull",
    "keep_both_rename_local",
    "inspect_manually"
  ]
}
```

Agent presents, user decides, agent invokes the corresponding explicit tool. Portuni never auto-merges and never silently overwrites.

## Setup flow

### First-time admin setup

One-time per Portuni deployment, done by whoever sets up the Turso database:

1. `portuni_setup_remote { name, type, config }` for each backend. Creates a `remotes` row.
2. `portuni_set_routing_policy { rules }` to configure mapping from node-type/org to remote-name.

Solo mode: one remote, one wildcard rule.

### First-time device setup

One-time per device (user's laptop, new machine, new teammate):

1. `portuni_connect_device` reads the `remotes` table.
2. For each remote, launches OAuth consent flow in a browser.
3. Stores the refresh token in varlock under `portuni.remote.<name>.refresh_token`.
4. Calls `adapter.stat()` against each remote to verify the token works.
5. Initializes `$PORTUNI_WORKSPACE_ROOT/.portuni/sync.db` if absent.

Subsequent machines of the same user use the same Google account and the same remote configs. Each machine gets its own refresh token stored locally.

## Testing strategy

### Unit tests (fast, no network)

- Hash diff classification logic with fabricated inputs for every state combination.
- Move detection algorithm with synthetic missing/unknown sets.
- Folder rename collapse.
- Routing policy resolution with various rule permutations.

### Integration tests (slow, need OpenDAL and a test remote)

- Use OpenDAL's built-in local FS backend as a "remote" in tests. No network, no auth, real adapter code.
- Full `portuni_store` -> `portuni_status` -> `portuni_pull` cycles on FS backend.
- Conflict scenarios: edit locally, edit on "remote" FS, run status.
- Move detection: rename local file, verify portuni_status proposes move.

### Smoke tests against real Drive

- Separate suite, opt-in via env var. Runs against a Google test account with a dedicated shared drive.
- Verifies OAuth flow, resumable upload on a large file, rate-limit retry behavior.
- Not part of the default `npm test` because it is slow and costs Google quota.

### What is mocked vs real

- **FileAdapter is never mocked in unit tests for sync engine.** The FS backend of OpenDAL is our "test double" – it is a real adapter that happens to be local. This avoids mock-vs-real drift: the same adapter code runs in tests and production, only the backend config differs.
- **OAuth flow is mocked in tests.** Real auth is only exercised in manual setup.

## Phasing

### Phase 1 – this spec's scope

- OpenDAL-based FileAdapter with Google Drive as the first concrete backend.
- Schema migration for `remotes`, `remote_routing`, updated `files` columns, local `sync.db`.
- Five primary MCP tools: store, pull, status, snapshot, delete_file.
- Supporting tools: setup_remote, set_routing_policy, connect_device, list_remotes, adopt_files.
- Move detection in `portuni_status`; explicit `move_file` and `rename_folder`.
- Solo user, one Drive shared drive, two devices (test scenario).
- Tests: unit + integration against OpenDAL FS backend + opt-in smoke against real Drive.
- MCP instructions updated so Claude knows when to call portuni_status (session end, before major migrations).

### Phase 2 – team and second backend

- Second teammate joins: no schema change, just new device setup flow.
- Second backend (Dropbox or S3): add one RemoteConfig, adapter already supports it through OpenDAL.
- Optional: Claude Code SessionEnd hook for automatic status warning.

### Phase 3 and beyond

- Background agent that proposes adoption of new_remote / new_local files detected during status.
- Notion adapter via official Notion MCP for link-level tracking (no content sync).
- Cross-remote migration tool for bulk reorganizations.

### Explicit non-goals

- **No background daemon, no file watcher, no automatic push.** Every sync action is intentional.
- **No CRDT, no real-time collaborative editing.** Out of scope for file sync; different problem domain.
- **No roundtrip of rich-format documents** (Google Docs, Notion). These are linked, not mirrored. See `docs/conceptual-map.md`.
- **No automatic conflict merge.** Conflicts are always presented to the user.

## Alternatives considered

**Direct Google Drive SDK.** Simpler dependency profile (just `googleapis` npm), full TypeScript control. Rejected as the primary path because adding the next backend (Dropbox, S3) means reimplementing everything. Kept as fallback if OpenDAL's Node binding proves unreliable in practice – the FileAdapter interface is small enough to re-implement in a day.

**rclone as adapter runtime.** Wraps 70+ backends through CLI. Rejected because it requires an external binary dependency and shell-exec from an MCP server feels unclean. Also, rclone's bidirectional sync model (`bisync`) is tuned for continuous sync, not intentional push; adapting it fights the tool.

**Syncthing or other P2P live sync.** Excellent for continuous mesh sync between machines, wrong shape for intentional publish-style workflow. Could be useful later as a user-choice for the `wip/` layer, entirely outside Portuni's concern.

**CRDT (Yjs, Automerge).** Solves real-time collaborative editing of structured documents. Files in Portuni are mostly blobs (PDFs, images, code, markdown). CRDTs do not fit blob storage. Obsidian's third-party plugins using Yjs confirm this is a separate use case.

**Git as the backend.** Native versioning, nice mental model. Rejected because binary files bloat repos; git-annex exists to fix this but adds another layer of complexity. A possible future backend for text-heavy projects, not a primary strategy.

## Open questions

1. **Token rotation.** How do we handle Google OAuth refresh token expiry or revocation across devices? Per-device re-auth is simple but annoying. Centralized token vault (e.g. one device pushes fresh tokens to Turso encrypted) is more elegant but adds complexity. Phase 1: per-device re-auth, document the flow.
2. **Large binary quotas.** What is the right user warning threshold? 100 MB feels conservative; 1 GB feels dangerous. Measure in practice.
3. **Folder move vs delete+recreate semantics.** If a user deletes a folder on Drive web UI and creates a new one with the same name somewhere else, is that a move or two unrelated events? Hash matching handles file content, not folder identity. For now, treat as separate operations.
4. **Stat cache invalidation for team scenarios.** The 30s remote_stat_cache is fine for solo. In a team, if user A pushes and user B runs status 10s later, B's cache misses the change. Acceptable for Phase 1; add cache invalidation (e.g. cache key includes `files.last_pushed_at`) in Phase 2.
5. ~~Deletion propagation.~~ Resolved in spec. `portuni_status` distinguishes `deleted_local` (files row + sync.db entry present, local missing) from `new_remote` (files row present, no sync.db entry – never pulled locally). `portuni_delete_file` offers `complete` and `unregister_only` modes. No auto-propagation either way.
6. **Cold-start cost.** On a new device, first `portuni_status` has no sync.db cache, so it rehashes every local file and stats every remote. For a large project this could take minutes. Consider seeding sync.db from an initial pull operation rather than expecting status to bootstrap itself.

## Setup checklist

- [ ] Add `npm i opendal` to root package.json.
- [ ] Create migration for new `remotes`, `remote_routing` tables plus `files` column changes.
- [ ] Remove `file_sync.local_path`; migrate existing data to local sync.db on each device.
- [ ] Implement FileAdapter interface with OpenDALAdapter as first concrete class.
- [ ] Implement sync engine: hash computation, state diff, routing resolution, move detection.
- [ ] Implement the four primary MCP tools plus supporting admin/setup tools.
- [ ] Write unit tests with synthetic state fixtures.
- [ ] Write integration tests against OpenDAL FS backend.
- [ ] Write opt-in smoke tests against real Google Drive test account.
- [ ] Update MCP server instructions so Claude knows when to call portuni_status.
- [ ] Document OAuth setup for Google Drive in project README.
- [ ] Manual test: solo user, two physical machines, round-trip edits with conflict detection.
