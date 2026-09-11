---
title: Sync Tools
description: Remote configuration, routing, status, and the destructive operations (move / rename / delete / adopt).
---

The basic file flow – mirror, store, pull, list, status – is documented in [Files & Mirrors](/reference/files/). This page covers the rest of the sync surface: configuring remotes, setting routing policy, and the destructive operations.

For the conceptual model see [Local Mirrors](/concepts/mirrors/).

## Remote configuration

A **remote** is a backend storage configuration. One row per remote in the `remotes` table. The same Portuni instance can have many remotes – e.g. one Google Shared Drive per organization.

### portuni_setup_remote

Create **or update** a named remote (upsert) and store its credentials. Calling it again with an existing `name` replaces that remote's config and drops the cached adapter.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Unique remote name (e.g. `drive-workflow`, `drive-tempo`) |
| `type` | enum | yes | `gdrive`, `dropbox`, `s3`, `fs`, `webdav`, or `sftp` |
| `config` | object | yes | Backend-specific configuration. For `gdrive`: `{ shared_drive_id, root_folder_id? }` |
| `service_account_json` | string | conditional | Required for `gdrive`. Stored via TokenStore (file / keychain / varlock), never in Turso |

For a **Service Account** remote the `shared_drive_id` is mandatory – service accounts have no My Drive storage quota, so they can only write into Shared Drives.

Desktop users don't call `portuni_setup_remote` for Google Drive by hand: **Settings → Synchronizace** runs a Google sign-in and configures the `gdrive` remote (plus a wildcard routing rule) for them, using per-user OAuth. That path also supports a personal My Drive folder (`root_folder_id`) as the target, which the Service-Account path cannot. See [Setting Up Remotes](/guides/setting-up-remotes/). The MCP tools remain the way to configure headless/central deployments and multi-remote routing.

### portuni_list_remotes

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

Returns: array of `{ name, type, authenticated }` per remote – `authenticated` reflects whether credentials for this remote exist on the current device (`fs` remotes are always `true`). No config object and no routing rules are returned; routing lives in `portuni_set_routing_policy` below.

## Routing policy

Routing tells Portuni *which* remote to use for a given `(node_type, org_slug)` combination. Rules are priority-ordered – the first match wins.

### portuni_set_routing_policy

Replace the entire `remote_routing` table with a new list of rules. Every existing rule that is not in the new list is deleted. Use only when the user explicitly asks to overwrite the routing policy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rules` | array | yes | Full ordered list of routing rules — see shape below |

Each rule object:

| Field | Type | Description |
|-------|------|-------------|
| `priority` | number | Lower wins. Use `100` for typical defaults, `10` for high-priority overrides |
| `node_type` | string \| null | Specific node type (`project`, `process`, `area`, `principle`, `organization`), or `null` for any |
| `org_slug` | string \| null | Specific org `sync_key`, or `null` for any |
| `remote_name` | string | Target remote (must already exist) |

Example — route every project across every org to the shared `projects-hub` drive, but route Workflow's processes to the workflow-specific drive:

```
portuni_set_routing_policy {
  rules: [
    { priority: 10,  node_type: "process", org_slug: "workflow", remote_name: "drive-workflow" },
    { priority: 100, node_type: "process", org_slug: null,       remote_name: "shared-processes" },
    { priority: 100, node_type: "project", org_slug: null,       remote_name: "projects-hub" }
  ]
}
```

`resolveRemote(nodeType, orgSlug)` picks the first rule whose `node_type` either matches or is `null`, and whose `org_slug` either matches or is `null`, ordered by ascending `priority` then insertion order.

Returns: `{ count: number }` — the number of rules now in the table.

## Snapshot

### portuni_snapshot

Export a Google Docs/Sheets/Slides URL to PDF / Markdown / DOCX and store it as a tracked file on the node. Use when the user wants a point-in-time copy of a native Google doc tracked on a node — e.g. archiving a spec snapshot before continuing edits.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node to attach the exported file to |
| `doc_url` | string | yes | URL of a Google Doc / Sheet / Slide. Must contain `/d/<id>/` — the Drive file ID is extracted from this segment |
| `format` | enum | no | `pdf` (default), `markdown`, or `docx` |
| `filename` | string | no | Override the default filename (`snapshot-<timestamp>.<ext>`) |
| `subpath` | string \| null | no | Optional subfolder within the node's section |

Returns: `{ file_id, filename, remote_path }`. With a local mirror the exported buffer is stored via the same flow as `portuni_store`; without one (central server, teammate session) it is created directly on the remote and registered. In agent mode the device then pulls the file into its mirror and adds `local_path` (`null` when the node is not mirrored on that device).

## Deliberate sync run

`portuni_status` only reports the current classification — it never touches the remote or cleans anything up. Reconciling drift against the remote happens in a **deliberate sync run**, triggered by the desktop/web UI's "Synchronizovat" action (or, for a teammate mirror in central mode, by the sync agent). One run does, in order:

1. **Retry pending file ops** — replays any move/rename/delete whose remote step didn't finish last time (see [Destructive operations](#destructive-operations) below).
2. **Remote sweep** — a tracked file whose remote object is confirmed gone is removed and tombstoned; a file that appeared anywhere under `wip/`, `outputs/`, or `resources/` (at any depth) is adopted and pulled in the same run (a dot-prefixed filename or subfolder is skipped). A record never pushed from this device is left alone, and nothing is destroyed if the remote itself can't be confirmed reachable. The sweep also refreshes `current_remote_hash` for any tracked, present record — central-mode classification reads that column as its only source of remote truth, so a record with a NULL hash used to read as `remote_missing` forever even though the object was right there in the sweep's own listing (#273), and a record whose hash went stale (a teammate editing the file directly in Drive) used to read as permanently clean, so the edit was never pulled by any device (#276). For a backend that reports a content hash on listing (Drive) this refresh costs no extra remote call; a backend that doesn't (e.g. a plain filesystem remote) only gets a NULL hash resolved (by downloading and hashing), since re-verifying an already-known hash there would mean downloading every tracked file's content on every sync.
3. **Reconcile.** Resolve every tracked record whose remote state is *unknown* — central holds no hash for it and this device has never observed one. A missing hash means "nobody has looked", never "the object is gone" (the sweep proves absence by deleting the record), so without this step such a record is skipped as `remote_missing` on every run, forever. Bounded per run, and self-extinguishing: a resolved record never comes back.
4. Status scan — a pure read of what is now known. `statusScanCentral` has no `fast` parameter: re-deriving truth is the step above, not a mode of reading.
5. Push every `push` candidate, pull every `pull` candidate. A push the remote refuses because it already holds *different* content is reported under `conflicts`, not `errors` — the refusal itself proves the remote object exists, and the device records the hash it just observed, so the file reads as a `conflict` from then on and the row offers "Ponechat lokální"/"Vzít z remote" instead of a push that can never land. This matters most when central's own `current_remote_hash` is NULL: classification would otherwise keep reading the file as an ordinary pending upload forever. A `deleted_local` file is reported, not auto-restored — that needs an explicit decision (see [Resolving conflicts and deletions](#resolving-conflicts-and-deletions)). Every push and pull is serialized per local path against any other push/pull of that same file on this device (a background push from `portuni_store`'s create flow, a sync-run push, a foreground pull, an editor save) — an edit landing mid-push is rehashed and stays a push candidate instead of being masked as clean, and a pull's dirty-local check can't be raced by a write landing after the check but before the overwrite (#277).
6. Clean up untracked local copies that match a delete or move/rename tombstone.
7. Adopt whatever local files are still untracked — including an edited copy of a file just deleted on the remote, which wins over the deletion and gets pushed back.

### Background sync jobs (bulk "Synchronizovat vše")

Running the sequence above for one node is a single blocking request (`POST /nodes/:id/sync`, unchanged — this is what `portuni_status`'s consumers and the MCP-adjacent tooling still use). Syncing *every* pending node at once no longer loops that request client-side: the web/desktop UI's "Synchronizovat vše" instead starts a background job that runs server-side with bounded concurrency across nodes, so closing the overview, switching windows, or one slow node no longer blocks the rest of the batch.

| Endpoint | Method | Description |
|---|---|---|
| `/sync/jobs` | POST | Starts a job. Body `{ node_ids?: string[] }` — omitted defaults to every node with actionable pending work (`GET /sync/pending`'s `total > 0` set). Returns `202` with the job summary immediately; a second start while one is already running for the same user reattaches to it instead of racing a duplicate, appending any node the running job does not already cover. |
| `/sync/jobs/:id` | GET | Job status: `{ id, status: "running" \| "done", started_at, finished_at, total, completed, errored, nodes: [{ node_id, status, result?, error? }] }`. |
| `/sync/jobs/current` | GET | `{ job: <summary> \| null }` — the caller's own currently-running job, so a reopened UI can reattach without remembering the job id. |

Job state is in-memory on the server/sidecar process — it does not survive a restart, only a UI remount (closing/reopening the overview, switching windows). Each node's own sync work is unaffected either way: `runNodeSync`/`syncRunCentral` per node is the same idempotent call the direct route makes, so a lost job is a lost progress view, never lost or duplicated sync work.

### `GET /sync/pending` — actionable work vs. decisions

The cross-mirror aggregate behind the footer badge, the quit guard, and `/sync/jobs`' default node set splits each node's (and the aggregate's) count in two:

- **`total`** — actionable: `push` + untracked file count. This is exactly what a sync run (or a background job) can clear.
- **`decisions`** — needs a human: `conflict` + `deleted_local`. A run leaves both untouched by design (see [Resolving conflicts and deletions](#resolving-conflicts-and-deletions)), so counting them into `total` used to make the badge/quit guard warn about work "Synchronizovat vše" could never actually finish. A node with decisions but no actionable work still appears in the overview (not hidden), just with `total: 0` — and its row offers "Rozhodnout", which opens the node, rather than "Synchronizovat": a run on such a node would report nothing and change nothing. "Synchronizovat vše" likewise covers only nodes with `total > 0`.

`remote_missing` is reported per node but counted in neither — a run does not push or pull it either, and (per the remote-sweep hash backfill above) most `remote_missing` misclassifications now self-correct on the next sweep instead of needing a decision at all. In central mode a device also falls back to a remote hash it observed first-hand on an earlier push or pull when central's record carries none, so a file it has provably reached stops reading as `remote_missing` even before the next sweep.

## Destructive operations

All three operations below are confirm-first. The first call returns a preview without acting; show the preview to the user, then call again with `confirmed: true` to execute. Best-effort ordered (remote, then local, then DB) — a partial failure returns `repair_needed` with a hint, and the operation's intent is recorded so the next sync run retries it automatically until it completes.

### portuni_move_file

Move a tracked file within its node (new subpath or section) or to a different node.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_id` | string | yes | File to move |
| `new_node_id` | string | no | Move to a different node (cross-node move) |
| `new_section` | enum | no | `wip`, `outputs`, or `resources` — re-section within the same node |
| `new_subpath` | string \| null | no | New subpath within the section. Pass `null` to clear |
| `confirmed` | boolean | no | First call returns a preview; pass `true` on the second call to execute |

Returns either a preview (when `confirmed` is omitted or `false`) or the executed result. Partial failures return `repair_needed: true` with a hint. Like `portuni_rename_folder`, the remote step stats both the source and destination first and refuses the move outright if an object already sits at the destination path — an untracked file that hasn't been adopted yet is never silently duplicated or overwritten. A move between two different remotes is a copy followed by a delete, so it is not atomic: when the copy lands and the delete of the source fails, that fact is recorded with the operation's intent, and the next sync run finishes it by removing the source copy. Without that record both objects are present and indistinguishable, which the retry refuses to resolve on a guess.

### portuni_rename_folder

Rename a subpath within a node's sync layout. Updates `remote_path` for every file under the prefix, one remote operation per file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node whose folder to rename |
| `old_prefix` | string | yes | Existing subpath prefix (relative to the node's section root) |
| `new_prefix` | string | yes | New subpath prefix |
| `dry_run` | boolean | no | Defaults to `true` — returns a preview of affected files. Call again with `dry_run: false` to apply |
| `limit` | number | no | Max files to rename in this apply call (default 20). Ignored for `dry_run` |

An apply call is bounded by `limit` so a large folder can't time out the caller mid-run. When the result's `remaining` is greater than 0, call again with the **same** `node_id`/`old_prefix`/`new_prefix` — already-renamed files no longer match `old_prefix`, so the next call picks up exactly where the previous one left off, with no extra state to track. Each file's remote step stats both the source and destination first, so a retry that finds the object already at the destination reports it `ok` with `already_at_target: true` instead of failing.

`sync_key` itself is immutable — this tool only changes the visible subpath. The underlying identifier the system uses for routing does not change.

### portuni_delete_file

Delete a tracked file. Two modes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_id` | string | yes | File to delete |
| `mode` | enum | no | `complete` (default — removes remote + local + DB row) or `unregister_only` (DB row only; use when the file is already gone from disk and remote) |
| `confirmed` | boolean | no | First call returns a preview; pass `true` on the second call to execute |

Returns the preview or the executed result. For Drive remotes, "delete" means moving to Drive's trash (30-day recovery window) – Portuni does not hard-delete via the remote API.

## Adoption

### portuni_adopt_files

Register existing **remote** files (not currently tracked) as `files` rows for the given node. Non-destructive. Use after `portuni_status` surfaces `new_remote` entries to bring them under tracking.

:::note[Adopt vs store]
- `portuni_adopt_files` is for files that already live on the remote (created by a teammate or another device). It pulls metadata only, no upload.
- [`portuni_store`](/reference/files/#portuni_store) is for a deliberate **push** to the remote. New local files in a mirror are registered automatically (local-only, no upload) by the mirror watcher, so `portuni_store` is not needed just to make a file visible – only to push it. The watcher is default-on in the desktop sidecar; the standalone server needs `PORTUNI_WATCH_MIRRORS=1`. In a watcher-less environment, call `portuni_store` right after creating a file in a mirror – nothing else registers it there.
:::

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_id` | string | yes | Node to adopt files into |
| `paths` | string[] | yes | Paths on the remote (relative to the node's remote root) |
| `status` | enum | no | `wip` (default) or `output` |

Returns: array of adopted `files` rows, including computed hashes. Existing tracked files at the same paths are skipped (idempotent).

## Resolving conflicts and deletions

A `conflict` (both sides changed) or `deleted_local` (locally removed, still on the remote) file needs a human decision — Portuni never auto-merges or auto-restores. As an agent, resolve it with the same tools used elsewhere:

| Situation | Action | Tool |
|-----------|--------|------|
| `conflict`, keep the local version | Push local over remote | `portuni_store` |
| `conflict`, take the remote version | Overwrite local with remote | `portuni_pull(file_id, force: true)` |
| `deleted_local`, restore it | Download the remote copy back into the mirror | `portuni_pull(file_id)` |

The desktop/web UI exposes the same three actions as buttons on the file row, backed by `POST /nodes/:id/files/:fileId/resolve` with `{ action: "keep_local" | "take_remote" | "restore" }`. It 404s if the file doesn't belong to the node; it 409s on `restore` when it would clobber a local change that was never pushed (the same guard `portuni_pull` applies without `force`), and on `keep_local` when the node has no mirror on this device.

## See also

- [Files & Mirrors](/reference/files/) – the core file flow (mirror, store, pull, list, status)
- [Local Mirrors](/concepts/mirrors/) – how mirrors and remotes fit together
- [Setting up remotes](/guides/setting-up-remotes/) – step-by-step Google Drive Service Account setup
