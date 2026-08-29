# Deterministic File Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sync run reconciles every file change made outside Portuni (deleted or added on the remote, moved by another device, half-finished mutations) without an agent, and surfaces the two real human decisions (conflict, locally deleted file) as UI actions.

**Architecture:** A server-side *remote sweep* (list-diff of the node's remote folder against `files`) runs at the start of every deliberate sync run and produces record deletions + tombstones and adoptions; devices react through the existing tombstone/pull mechanisms. Mutations write an intent row to a new `pending_file_ops` table first and are retried idempotently by the sync run. The `orphan` class is replaced by `pull` / `remote_missing` / `remote_error`. A `resolve` endpoint backs the UI buttons.

**Tech Stack:** Node 24 + TypeScript (server), libSQL/Turso, React + Vite (web), `node --test` with `tsx` (tests), biome (lint).

**Spec:** `docs/superpowers/specs/2026-08-28-deterministic-file-reconciliation-design.md`

## Global Constraints

- Run tests with `node --import tsx --test test/<file>.test.ts` (node binary: `~/.nvm/versions/node/v24.18.0/bin/node`; use the full path if `node` is not on PATH). Full suite: `npm test`. Typecheck: `npx tsc --noEmit -p tsconfig.json`. Lint: `npx biome check <files>`. Web: `npm --prefix apps/web run typecheck` and `npm --prefix apps/web run build`.
- Conventional Commits with scopes `sync`, `mcp`, `api`, `web`, `docs`. Never bump versions or tag.
- No emoji in code. Czech UI strings use diacritics.
- Never auto-merge content. The only automatic overwrite is a local copy byte-identical to its last synced state.
- Detection runs only in the sync run, never in `sync-status` polling (`fast: true` scans stay DB-only).
- Public docs in `sites/docs/` change in the same branch (Task 9).

## File map

| File | Responsibility |
|---|---|
| `apps/server/shared/api-types.ts` | `SyncClass` without `orphan`; new `SyncRunResponse` fields; `SyncPendingNode.remote_missing` |
| `apps/server/domain/sync/engine.ts` | local classification (`scanRow`), `StatusResult` buckets, tombstone matching incl. moves, `computeSyncPending` |
| `apps/server/domain/sync/central/engine-central.ts` | central classification, `syncRunCentral` calls the sweep |
| `apps/server/domain/sync/remote-sweep.ts` (new) | `remoteSweep`: deleted-on-remote + adopt new remote files |
| `apps/server/domain/sync/pending-ops.ts` (new) | `pending_file_ops` intent rows + idempotent retry |
| `apps/server/domain/sync/engine-mutations.ts` | enqueue/complete pending ops in move/rename/delete/renameFolder; `node_id` in move/rename audit |
| `apps/server/domain/sync/file-content-remote.ts` | `deleteFileRemote` enqueues/completes a pending op |
| `apps/server/domain/sync/sync-remote-api.ts` | sync-info tombstones include moved-from paths |
| `apps/server/infra/schema.ts`, `apps/server/infra/schema-migrations.ts` | `pending_file_ops` DDL + migration 023 |
| `apps/server/api/nodes.ts` | `handleSyncRun` order; `handleRemoteSweep`; `handleResolveFile`; status buckets |
| `apps/server/api/router.ts`, `apps/server/api/agent-router.ts` | routes for `/sync/remote-sweep` and `/files/:id/resolve` |
| `apps/server/domain/sync/central/client.ts` | `CentralClient.remoteSweep` |
| `apps/server/mcp/agent-tools.ts`, `apps/server/mcp/tools/sync-status.ts` | preview status names, tool descriptions |
| `apps/web/src/api.ts`, `apps/web/src/components/DetailPane.files.tsx`, `DetailPane.tsx`, `SyncOverview.tsx` | new classes, resolve buttons |
| `test/sync-engine-classes.test.ts`, `test/sync-remote-sweep.test.ts`, `test/sync-pending-ops.test.ts`, `test/sync-resolve-rest.test.ts` (new), `test/sync-tombstones.test.ts`, `test/engine-central.test.ts`, `test/agent-router.test.ts` | tests |
| `sites/docs/src/content/docs/reference/files.md`, `reference/sync.md`, `concepts/mirrors.md`, `apps/server/mcp/resources/sync-model.md`, `docs/architecture/file-sync.md`, `CLAUDE.md` | docs |

---

### Task 1: Replace the `orphan` class

**Files:**
- Modify: `apps/server/shared/api-types.ts:133-141` (`SyncClass`), `:191-205` (`SyncPendingNode`)
- Modify: `apps/server/domain/sync/engine.ts:552` (`StatusFileEntry.class`), `:597` (`StatusResult`), `:701` (`ScanBucket`), `:720-740`, `:767`, `:781-798` (`scanRow`), `:864` (bucket init), `:1223-1260` (preview entries), `computeSyncPending` (search `orphan`)
- Modify: `apps/server/domain/sync/central/engine-central.ts:185-187`, `:203-207`, `:257`, `:1060-1073`
- Modify: `apps/server/api/nodes.ts:328-340` (status buckets), `:610` (skipped)
- Modify: `apps/server/mcp/agent-tools.ts:84`, `:130`, `:149`, `:206`; `apps/server/mcp/tools/sync-status.ts:11` (description text)
- Modify: `apps/web/src/components/DetailPane.files.tsx:159`, `:176`, `:885-905`; `apps/web/src/components/SyncOverview.tsx:116`
- Modify tests referencing `scan.orphan`: `test/register-local-file.test.ts:99`, `test/sync-watcher-regression.test.ts:199`, `test/move-node-files.test.ts:74`
- Test: `test/sync-engine-classes.test.ts` (new)

**Interfaces:**
- Produces: `SyncClass = "clean" | "push" | "pull" | "conflict" | "remote_missing" | "remote_error" | "native" | "deleted_local"`; `StatusResult.remote_missing: StatusFileEntry[]`, `StatusResult.remote_error: StatusFileEntry[]` (the `orphan` bucket is removed); `SyncPendingNode.remote_missing: number` (replaces `orphan`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/sync-engine-classes.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, statusScan } from "../apps/server/domain/sync/engine.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests, deleteFileState } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-classes-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("classification without orphan", () => {
  it("remote content this device never synced classifies pull", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const localPath = join(mirrorRoot, "wip", "a.md");
    await writeFile(localPath, "obsah");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath });
    // Simulate a second device: no local copy, no baseline.
    await rm(localPath);
    await deleteFileState(r.file_id);
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: false });
    assert.equal(scan.pull_candidates.length, 1);
    assert.equal(scan.pull_candidates[0].file_id, r.file_id);
    assert.equal(scan.pull_candidates[0].class, "pull");
    assert.ok(!("orphan" in scan), "orphan bucket must be gone");
  });

  it("a record whose remote object vanished after a sync classifies remote_missing", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const localPath = join(mirrorRoot, "wip", "a.md");
    await writeFile(localPath, "obsah");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath });
    await rm(join(remoteRoot, r.remote_path));
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: false });
    assert.equal(scan.remote_missing.length, 1);
    assert.equal(scan.remote_missing[0].class, "remote_missing");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/sync-engine-classes.test.ts`
Expected: both FAIL (first: `pull_candidates.length` is 0 — the entry lands in `orphan`; second: `scan.remote_missing` is undefined).

- [ ] **Step 3: Change the shared types**

In `apps/server/shared/api-types.ts` replace the `SyncClass` union and the pending aggregate field:

```ts
export type SyncClass =
  | "clean"
  | "push"
  | "pull"
  | "conflict"
  // Record exists, remote object does not: registered elsewhere and never
  // pushed, or gone from the remote and awaiting the next sync run's sweep.
  | "remote_missing"
  // Remote stat failed (network/auth). Transient; skipped by the sync run.
  | "remote_error"
  | "native"
  | "deleted_local";
```

In `SyncPendingNode` rename `orphan: number;` to `remote_missing: number;` and update the comment above it (`push/conflict/untracked/remote_missing/deleted`).

- [ ] **Step 4: Change the local engine**

In `apps/server/domain/sync/engine.ts`:

1. `StatusFileEntry.class`: `"clean" | "push" | "pull" | "conflict" | "remote_missing" | "remote_error" | "native"`.
2. `StatusResult`: replace `orphan: StatusFileEntry[];` with `remote_missing: StatusFileEntry[]; remote_error: StatusFileEntry[];`.
3. `ScanBucket`: replace `"orphan"` with `"remote_missing" | "remote_error"`.
4. In `scanRow`:
   - node info missing (line ~720): bucket `remote_error`, class `remote_error`.
   - `if (!remoteName || !remotePath)` → `remote_error`.
   - `if (rs === null)` → `remote_error`.
   - `if (!rs.exists)` block: keep the `push` branch; the fallthrough returns `{ bucket: "remote_missing", entry: { ...base, class: "remote_missing" } }`.
   - `if (localHash === null)` block: keep `deleted_local` when a baseline exists; otherwise return `{ bucket: "pull_candidates", entry: { ...base, class: "pull" } }` with the comment `// Remote content exists but this device never synced it -> fetchable.`
5. `statusScan` result init: replace `orphan: []` with `remote_missing: [], remote_error: []`.
6. Preview mapping (line ~1223 `status:` union and `toEntry`): replace `"orphan"` with `"remote_missing" | "remote_error"` and emit `for (const e of scan.remote_missing) files.push(toEntry("remote_missing")(e)); for (const e of scan.remote_error) files.push(toEntry("remote_error")(e));`.
7. `computeSyncPending` (search for `orphan` in the function): `const remote_missing = scan.remote_missing.length;` and use it in `total` and the returned object.
8. Update the log message at line ~688 to `files will show as remote_error until it recovers`.

- [ ] **Step 5: Change the central engine**

In `apps/server/domain/sync/central/engine-central.ts`:
- `classifyRecord`: `!ctx.si.remote_name || !rec.remote_path` → `{ bucket: "remote_error", entry: { ...base, class: "remote_error" } }`; the `!remoteExists` fallthrough → `remote_missing`.
- bucket init in `statusScanForContext`: `remote_missing: [], remote_error: []`.
- `computeSyncPendingCentral`: `const remote_missing = scan.remote_missing.length;` and return `remote_missing` instead of `orphan`.
- `syncRunCentral` skipped loop: `[...scan.clean, ...scan.remote_missing, ...scan.remote_error, ...scan.native]`.

- [ ] **Step 6: Change API, MCP and web consumers**

- `apps/server/api/nodes.ts` `handleSyncStatus`: replace `push(result.orphan, "orphan");` with `push(result.remote_missing, "remote_missing"); push(result.remote_error, "remote_error");`. In `handleSyncRun` skipped loop use `[...scan.clean, ...scan.remote_missing, ...scan.remote_error, ...scan.native]`.
- `apps/server/mcp/agent-tools.ts`: `PreviewStatus` union gets `"remote_missing" | "remote_error"` instead of `"orphan"`; the aggregate object and `agg.*.push` lines use the two new buckets; the preview mapping emits both.
- `apps/server/mcp/tools/sync-status.ts` description: `clean/push/pull/conflict/remote_missing/remote_error/native`.
- `apps/web/src/components/DetailPane.files.tsx`: `SYNC_LABEL` gains `remote_missing: "chybí na remote"`, `remote_error: "remote nedostupný"` (remove `orphan`); `syncCssVar` maps both to `var(--color-status-archived)`; the `hasOrphan` flag at line 159/176 becomes `hasRemoteMissing` with title `"Některé soubory chybí na remote"`.
- `apps/web/src/components/SyncOverview.tsx:116`: `n.remote_missing > 0 && <span title="Chybí na remote">…{n.remote_missing}</span>`.
- Tests: change `scan.orphan` to `scan.remote_missing` in `test/register-local-file.test.ts:99`, `test/sync-watcher-regression.test.ts:199`, `test/move-node-files.test.ts:74`.

- [ ] **Step 7: Run tests, typecheck, web typecheck**

Run: `node --import tsx --test test/sync-engine-classes.test.ts test/register-local-file.test.ts test/sync-watcher-regression.test.ts test/move-node-files.test.ts test/engine-central.test.ts && npx tsc --noEmit -p tsconfig.json && npm --prefix apps/web run typecheck`
Expected: all PASS, no type errors. `grep -rn "orphan" apps/server apps/web/src --include=*.ts --include=*.tsx` returns only the edge/node "orphan node" usages (`domain/edges.ts`, `mcp/tools/edges.ts`, schema triggers).

- [ ] **Step 8: Commit**

```bash
git add apps/server apps/web/src test/sync-engine-classes.test.ts test/register-local-file.test.ts test/sync-watcher-regression.test.ts test/move-node-files.test.ts
git commit -m "feat(sync): replace the orphan class with pull / remote_missing / remote_error"
```

---

### Task 2: Moves and renames leave tombstones

**Files:**
- Modify: `apps/server/domain/sync/engine-mutations.ts` (`moveFile` audit at ~`:276-295`, `renameFolder` per-file audit at ~`:426-432`, `renameFile` audit at ~`:870-885`)
- Modify: `apps/server/domain/sync/engine.ts:943-1010` (`matchDeleteTombstones`), `:1029-1050` (`cleanupDeletedRemote`), `DeletedRemoteEntry` type (search `interface DeletedRemoteEntry`)
- Modify: `apps/server/domain/sync/sync-remote-api.ts:37-40` (`DeletedTombstone`), `:93-101` (tombstone query), `:120-125`
- Modify: `apps/server/domain/sync/central/engine-central.ts:287-330` (`matchTombstonesForContext`)
- Test: `test/sync-tombstones.test.ts`

**Interfaces:**
- Produces: audit rows `sync_move` / `sync_rename` carry top-level `node_id` and `old_remote_path`; `DeletedTombstone { file_id, remote_path, record_alive: boolean }`; `DeletedRemoteEntry.record_alive: boolean`; `cleanupDeletedRemote` keeps `file_state` when `record_alive`.

- [ ] **Step 1: Write the failing tests** (append to `test/sync-tombstones.test.ts`)

```ts
describe("move tombstones", () => {
  it("an untracked copy left at a moved-from path is cleaned up, not adopted", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const oldLocal = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldLocal, "obsah");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath: oldLocal });
    // Move through Portuni; then put the old copy back as if this device
    // had missed the local step (another device, or a failed front door).
    const { moveFile } = await import("../apps/server/domain/sync/engine-mutations.js");
    const mv = await moveFile(db, { userId: "U1", fileId: r.file_id, newSection: "outputs", confirmed: true });
    assert.equal("status" in mv && mv.status, "ok");
    await writeFile(oldLocal, "obsah");
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    assert.equal(scan.new_local.length, 0, "old copy must not surface as new_local");
    assert.equal(scan.deleted_remote.length, 1);
    assert.equal(scan.deleted_remote[0].record_alive, true);
    const cleaned = await cleanupDeletedRemote(scan.deleted_remote);
    assert.equal(cleaned.cleaned.length, 1);
    await assert.rejects(() => stat(oldLocal));
    assert.ok(await getFileState(r.file_id), "file_state of a live record must survive");
  });

  it("an old copy edited after the move stays new_local", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const oldLocal = join(mirrorRoot, "wip", "a.md");
    await writeFile(oldLocal, "obsah");
    const r = await storeFile(db, { userId: "U1", nodeId, localPath: oldLocal });
    const { moveFile } = await import("../apps/server/domain/sync/engine-mutations.js");
    await moveFile(db, { userId: "U1", fileId: r.file_id, newSection: "outputs", confirmed: true });
    await writeFile(oldLocal, "obsah upraveny");
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    assert.equal(scan.new_local.length, 1);
    assert.equal(scan.deleted_remote.length, 0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/sync-tombstones.test.ts`
Expected: first test FAILS at `scan.new_local.length` (1 !== 0).

- [ ] **Step 3: Add `node_id` + old path to move/rename audit rows**

In `engine-mutations.ts`:
- `moveFile` success audit detail: add `node_id: fr.node_id as string, old_remote_path: oldRemotePath,` at the top level (keep `old`/`new`).
- `renameFile` audit detail: add `node_id: nodeId,`.
- `renameFolder`: inside the per-file loop, after the successful `UPDATE files SET remote_path`, insert one audit row per file:

```ts
await db.execute({
  sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
        VALUES (?, ?, 'sync_rename', 'file', ?, ?, ?)`,
  args: [
    ulid(),
    a.userId,
    f.file_id,
    JSON.stringify({
      node_id: a.nodeId,
      old_remote_path: f.old_remote_path,
      new_remote_path: f.new_remote_path,
      via: "rename_folder",
    }),
    now,
  ],
});
```

- [ ] **Step 4: Extend tombstone matching**

In `engine.ts`:
- `DeletedRemoteEntry`: add `record_alive: boolean;`.
- `matchDeleteTombstones` query:

```ts
sql: `SELECT target_id, action,
             COALESCE(json_extract(detail, '$.remote_path'),
                      json_extract(detail, '$.old_remote_path')) AS remote_path
      FROM audit_log
      WHERE target_type = 'file'
        AND action IN ('sync_delete', 'sync_delete_remote', 'sync_move', 'sync_rename')
        AND json_extract(detail, '$.node_id') = ?
      ORDER BY timestamp DESC LIMIT 200`,
```

  After a match, set `record_alive: t.action === "sync_move" || t.action === "sync_rename"`. A moved record's current path must differ from the tombstoned path — skip the tombstone when `record_alive` and the `files` row's `remote_path` still equals `remotePath` (the move was undone); do this with one `SELECT remote_path FROM files WHERE id = ?` per candidate.
- `cleanupDeletedRemote`: `if (!e.record_alive) await deleteFileState(e.file_id).catch(() => undefined);`

In `sync-remote-api.ts`:
- `DeletedTombstone` gains `record_alive: boolean`.
- Query: same `action IN (...)` and `COALESCE` as above, select `action` too; map `record_alive: r.action === "sync_move" || r.action === "sync_rename"`.

In `engine-central.ts` `matchTombstonesForContext`: when `t.record_alive`, skip if `ctx.si.files.find((f) => f.id === t.file_id)?.remote_path === t.remote_path`; push `record_alive: t.record_alive`.

Also update every other constructor of `DeletedRemoteEntry` (search `deleted.push({` in both engines) to include `record_alive: false` where the tombstone is a delete.

- [ ] **Step 5: Run tests**

Run: `node --import tsx --test test/sync-tombstones.test.ts test/engine-central.test.ts test/sync-engine-move.test.ts test/sync-engine-rename-folder.test.ts test/sync-rename.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server test/sync-tombstones.test.ts
git commit -m "feat(sync): moves and renames leave tombstones so stale copies are cleaned up, not pushed back"
```

---

### Task 3: `remoteSweep` — deletions and adoptions from the remote listing

**Files:**
- Create: `apps/server/domain/sync/remote-sweep.ts`
- Test: `test/sync-remote-sweep.test.ts` (new)

**Interfaces:**
- Consumes: `getAdapter` (`adapter-cache.ts`), `resolveNodeInfo` (`node-info.ts`), `resolveRemote` (`routing.ts`), `buildNodeRoot` (`remote-path.ts`), `adoptFiles` (`engine-mutations.ts`).
- Produces:

```ts
export interface RemoteSweepArgs { userId: string; nodeId: string }
export interface RemoteSweepFile { file_id: string; filename: string; remote_path: string }
export interface RemoteSweepResult {
  adopted: RemoteSweepFile[];
  deleted_on_remote: RemoteSweepFile[];
  errors: Array<{ remote_path: string; error: string }>;
}
export async function remoteSweep(db: Client, a: RemoteSweepArgs): Promise<RemoteSweepResult>
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/sync-remote-sweep.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile } from "../apps/server/domain/sync/engine.js";
import { remoteSweep } from "../apps/server/domain/sync/remote-sweep.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { registerLocalFile } from "../apps/server/domain/sync/engine.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-sweep-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

async function pushed(db: Awaited<ReturnType<typeof makeSharedDb>>["db"], nodeId: string, mirrorRoot: string, name: string) {
  await mkdir(join(mirrorRoot, "wip"), { recursive: true });
  const localPath = join(mirrorRoot, "wip", name);
  await writeFile(localPath, `obsah ${name}`);
  return storeFile(db, { userId: "U1", nodeId, localPath });
}

describe("remoteSweep", () => {
  it("removes the record of a file deleted on the remote and writes a tombstone", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    await rm(join(remoteRoot, r.remote_path));
    const out = await remoteSweep(db, { userId: "U1", nodeId });
    assert.deepEqual(out.deleted_on_remote.map((f) => f.file_id), [r.file_id]);
    const row = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [r.file_id] });
    assert.equal(row.rows.length, 0);
    const tomb = await db.execute({
      sql: `SELECT json_extract(detail, '$.node_id') AS n, json_extract(detail, '$.remote_path') AS p, json_extract(detail, '$.reason') AS reason
            FROM audit_log WHERE action = 'sync_delete_remote' AND target_id = ?`,
      args: [r.file_id],
    });
    assert.equal(tomb.rows.length, 1);
    assert.equal(tomb.rows[0].n, nodeId);
    assert.equal(tomb.rows[0].p, r.remote_path);
    assert.equal(tomb.rows[0].reason, "remote_sweep");
  });

  it("leaves a registered-but-never-pushed record alone", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const localPath = join(mirrorRoot, "wip", "pending.md");
    await writeFile(localPath, "not pushed yet");
    const reg = await registerLocalFile(db, { userId: "U1", nodeId, localPath });
    const out = await remoteSweep(db, { userId: "U1", nodeId });
    assert.equal(out.deleted_on_remote.length, 0);
    const row = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [reg.file_id] });
    assert.equal(row.rows.length, 1);
  });

  it("adopts a file that appeared on the remote under a tracked section", async () => {
    const { db, nodeId, remoteRoot, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const nodeRoot = `${orgSyncKey}/projects/${nodeSyncKey}`;
    await mkdir(join(remoteRoot, nodeRoot, "outputs"), { recursive: true });
    await writeFile(join(remoteRoot, nodeRoot, "outputs", "report.md"), "from drive");
    await mkdir(join(remoteRoot, nodeRoot, "wip"), { recursive: true });
    await writeFile(join(remoteRoot, nodeRoot, "wip", ".DS_Store"), "junk");
    await writeFile(join(remoteRoot, nodeRoot, "notes.txt"), "outside sections");
    const out = await remoteSweep(db, { userId: "U1", nodeId });
    assert.deepEqual(out.adopted.map((f) => f.remote_path), [`${nodeRoot}/outputs/report.md`]);
    const row = await db.execute({
      sql: "SELECT status, current_remote_hash FROM files WHERE id = ?",
      args: [out.adopted[0].file_id],
    });
    assert.equal(row.rows[0].status, "output");
    assert.ok(row.rows[0].current_remote_hash);
  });

  it("does not delete anything when the listing fails", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    await rm(remoteRoot, { recursive: true, force: true }); // whole remote gone = unreachable
    const out = await remoteSweep(db, { userId: "U1", nodeId });
    assert.equal(out.deleted_on_remote.length, 0);
    assert.equal(out.errors.length, 1);
    const row = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [r.file_id] });
    assert.equal(row.rows.length, 1);
  });
});
```

Note for the last test: check how the fs adapter (`opendal-adapter.ts`) behaves when the root is missing — if `list` returns `[]` instead of throwing, replace the arrangement with a remote config pointing to a non-existent root (`upsertRemote` with `config: { root: join(workspace, "missing") }` and `invalidateAdapter("test-fs")`), and assert that the sweep treats a listing that returns nothing while records exist as an error unless every candidate also fails `adapter.stat`. The stat double-check below is what makes the assertion hold either way.

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/sync-remote-sweep.test.ts`
Expected: FAIL — cannot find module `remote-sweep.js`.

- [ ] **Step 3: Implement `remote-sweep.ts`**

```ts
// Remote sweep: reconcile the node's `files` rows against what the remote
// actually holds. Runs only inside a deliberate sync run (server side, where
// the remote credentials live).
//   - a pushed record whose object is gone from the remote -> record deleted
//     + sync_delete_remote tombstone (devices clean up byte-identical copies;
//     edited copies come back as new_local and get pushed again)
//   - a remote file under wip/outputs/resources that no record tracks ->
//     adopted (devices pull it in the same run)
import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { getAdapter } from "./adapter-cache.js";
import { resolveRemote } from "./routing.js";
import { resolveNodeInfo } from "./node-info.js";
import { buildNodeRoot } from "./remote-path.js";
import { adoptFiles } from "./engine-mutations.js";
import type { FileRef } from "./types.js";

export interface RemoteSweepArgs { userId: string; nodeId: string }
export interface RemoteSweepFile { file_id: string; filename: string; remote_path: string }
export interface RemoteSweepResult {
  adopted: RemoteSweepFile[];
  deleted_on_remote: RemoteSweepFile[];
  errors: Array<{ remote_path: string; error: string }>;
}

const SECTIONS = new Set(["wip", "outputs", "resources"]);

// Only files directly under <nodeRoot>/<section>/... qualify for adoption.
// An organization's root spans its children's subtrees; those paths have a
// type-plural segment (projects/...) where the section would be and are
// skipped here -- the child node's own sweep handles them.
function adoptableSection(nodeRoot: string, remotePath: string): "wip" | "outputs" | "resources" | null {
  const rel = remotePath.startsWith(`${nodeRoot}/`) ? remotePath.slice(nodeRoot.length + 1) : null;
  if (!rel) return null;
  const [section, ...rest] = rel.split("/");
  if (!SECTIONS.has(section) || rest.length === 0) return null;
  if (rest.some((seg) => seg.startsWith("."))) return null;
  return section as "wip" | "outputs" | "resources";
}

export async function remoteSweep(db: Client, a: RemoteSweepArgs): Promise<RemoteSweepResult> {
  const out: RemoteSweepResult = { adopted: [], deleted_on_remote: [], errors: [] };
  const info = await resolveNodeInfo(db, a.nodeId);
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  if (!remoteName) return out;
  const adapter = await getAdapter(db, remoteName);
  const nodeRoot = buildNodeRoot(info);

  let listing: FileRef[];
  try {
    listing = await adapter.list(nodeRoot);
  } catch (e) {
    out.errors.push({ remote_path: nodeRoot, error: `list failed: ${(e as Error).message}` });
    return out;
  }
  const present = new Map<string, FileRef>();
  for (const f of listing) present.set(f.path.normalize("NFC"), f);

  // 1. Deleted on the remote. Only rows that once had a remote object
  // (pushed or native) -- a never-pushed registration has nothing to lose.
  const rows = await db.execute({
    sql: `SELECT id, filename, remote_path, current_remote_hash, is_native_format
          FROM files WHERE node_id = ? AND remote_name = ? AND remote_path IS NOT NULL`,
    args: [a.nodeId, remoteName],
  });
  for (const r of rows.rows) {
    const remotePath = r.remote_path as string;
    const hadObject = (r.current_remote_hash as string | null) !== null || Number(r.is_native_format) === 1;
    if (!hadObject || present.has(remotePath.normalize("NFC"))) continue;
    // A listing can lag a fresh upload; confirm the object is really gone
    // before destroying the record.
    let stat: FileRef | null;
    try {
      stat = await adapter.stat(remotePath);
    } catch (e) {
      out.errors.push({ remote_path: remotePath, error: `stat failed: ${(e as Error).message}` });
      continue;
    }
    if (stat !== null) continue;
    const now = new Date().toISOString();
    await db.execute({ sql: "DELETE FROM files WHERE id = ?", args: [r.id as string] });
    await db.execute({
      sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
            VALUES (?, ?, 'sync_delete_remote', 'file', ?, ?, ?)`,
      args: [
        ulid(),
        a.userId,
        r.id as string,
        JSON.stringify({
          node_id: a.nodeId,
          remote_name: remoteName,
          remote_path: remotePath,
          filename: r.filename as string,
          mode: "complete",
          reason: "remote_sweep",
          hash: (r.current_remote_hash as string | null) ?? null,
        }),
        now,
      ],
    });
    out.deleted_on_remote.push({ file_id: r.id as string, filename: r.filename as string, remote_path: remotePath });
  }

  // 2. New on the remote. Known = any record anywhere under this root (an
  // org mirror lists its children's files too).
  const likePrefix = nodeRoot.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const known = await db.execute({
    sql: "SELECT remote_path FROM files WHERE remote_name = ? AND remote_path LIKE ? ESCAPE '\\'",
    args: [remoteName, `${likePrefix}/%`],
  });
  const knownSet = new Set(known.rows.map((r) => (r.remote_path as string).normalize("NFC")));
  const bySection = new Map<"wip" | "output", string[]>();
  for (const [path, ref] of present) {
    if (knownSet.has(path)) continue;
    const section = adoptableSection(nodeRoot, ref.path);
    if (!section) continue;
    const status = section === "outputs" ? "output" : "wip";
    if (!bySection.has(status)) bySection.set(status, []);
    bySection.get(status)!.push(ref.path);
  }
  for (const [status, paths] of bySection) {
    const res = await adoptFiles(db, { userId: a.userId, nodeId: a.nodeId, paths, status });
    for (const f of res.adopted) out.adopted.push({ file_id: f.file_id, filename: f.filename, remote_path: f.remote_path });
    for (const s of res.skipped) {
      if (s.reason !== "already tracked") out.errors.push({ remote_path: s.remote_path, error: s.reason });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test test/sync-remote-sweep.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/domain/sync/remote-sweep.ts test/sync-remote-sweep.test.ts
git commit -m "feat(sync): remote sweep reconciles deletions and new files on the remote"
```

---

### Task 4: Wire the sweep into the local sync run

**Files:**
- Modify: `apps/server/shared/api-types.ts:173-188` (`SyncRunResponse`)
- Modify: `apps/server/api/nodes.ts:535-645` (`handleSyncRun`)
- Modify: `apps/server/domain/sync/central/engine-central.ts:895-905` (result init, so the type still compiles), `apps/server/mcp/agent-tools.ts` sync-run result construction if any (search `deleted_remote: []`)
- Modify: `apps/web/src/components/DetailPane.files.tsx:806-830` (result lines)
- Test: `test/sync-run-sweep.test.ts` (new)

**Interfaces:**
- Produces: `SyncRunResponse.adopted_remote: SyncRunFile[]`, `SyncRunResponse.deleted_on_remote: SyncRunFile[]`, `SyncRunResponse.sweep_errors: Array<{ remote_path: string; error: string }>`.

- [ ] **Step 1: Write the failing test** — exercise `handleSyncRun` through the HTTP layer the way `test/rest-smoke.test.ts` does (copy its server bootstrap: `startHttpServer` + router with the shared db and a bearer token), then:

```ts
// test/sync-run-sweep.test.ts (bootstrap copied from test/rest-smoke.test.ts; only the cases are shown)
it("sync run removes the local copy of a file deleted on the remote", async () => {
  // arrange: push wip/a.md, delete it under remoteRoot
  const res = await fetch(`${base}/nodes/${nodeId}/sync`, { method: "POST", headers });
  const body = await res.json();
  assert.deepEqual(body.deleted_on_remote.map((f: { file_id: string }) => f.file_id), [fileId]);
  assert.deepEqual(body.deleted_remote.map((f: { file_id: string }) => f.file_id), [fileId]);
  await assert.rejects(() => stat(localPath));
});

it("sync run pushes back a locally edited copy of a file deleted on the remote", async () => {
  // arrange: push wip/a.md, delete on remote, then edit the local copy
  const body = await (await fetch(`${base}/nodes/${nodeId}/sync`, { method: "POST", headers })).json();
  assert.equal(body.deleted_on_remote.length, 1);
  assert.equal(body.adopted.length, 1);           // re-registered from disk
  assert.ok(await stat(localPath));
  assert.equal(await readFile(join(remoteRoot, remotePath), "utf8"), "obsah upraveny");
});

it("sync run adopts and pulls a file that appeared on the remote", async () => {
  // arrange: write <remoteRoot>/<nodeRoot>/outputs/report.md
  const body = await (await fetch(`${base}/nodes/${nodeId}/sync`, { method: "POST", headers })).json();
  assert.equal(body.adopted_remote.length, 1);
  assert.equal(body.pulled.length, 1);
  assert.equal(await readFile(join(mirrorRoot, "outputs", "report.md"), "utf8"), "from drive");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/sync-run-sweep.test.ts`
Expected: FAIL — `deleted_on_remote` undefined / local copy still present.

- [ ] **Step 3: Extend `SyncRunResponse`**

```ts
export type SyncRunResponse = {
  pushed: SyncRunFile[];
  pulled: SyncRunFile[];
  adopted: SyncRunFile[];
  // Records created for files that appeared on the remote (remote sweep);
  // they are pulled in the same run.
  adopted_remote: SyncRunFile[];
  conflicts: SyncRunFile[];
  deleted_local: SyncRunFile[];
  deleted_remote: SyncRunFile[];
  // Records removed because their remote object is gone (remote sweep).
  deleted_on_remote: SyncRunFile[];
  sweep_errors: Array<{ remote_path: string; error: string }>;
  errors: SyncRunErrorFile[];
  skipped: SyncRunSkippedFile[];
};
```

Add `adopted_remote: [], deleted_on_remote: [], sweep_errors: []` to every `SyncRunResponse` literal (`nodes.ts`, `engine-central.ts`, any in `agent-tools.ts`).

- [ ] **Step 4: Reorder `handleSyncRun`**

At the top of the `try` block (before `statusScan`):

```ts
const sweep = await remoteSweep(db, { userId: identity.userId, nodeId });
```

After the `result` literal:

```ts
for (const f of sweep.adopted) result.adopted_remote.push({ file_id: f.file_id, filename: f.filename });
for (const f of sweep.deleted_on_remote) result.deleted_on_remote.push({ file_id: f.file_id, filename: f.filename });
result.sweep_errors.push(...sweep.errors);
```

Import `remoteSweep` from `../domain/sync/remote-sweep.js`. Keep the rest of the run as it is: the scan now classifies adopted records as `pull` (Task 1), and the deleted records' local copies are untracked and hit `matchDeleteTombstones` → `cleanupDeletedRemote` (existing code below the pull loop); edited copies fall through to the adopt loop and are pushed by `storeFile`.

- [ ] **Step 5: Show the new lines in the web result box** (`DetailPane.files.tsx`, next to the `deleted_remote` line)

```tsx
{(result.adopted_remote?.length ?? 0) > 0 && (
  <div>Nové z remote: {result.adopted_remote.map((f) => f.filename).join(", ")}</div>
)}
{(result.deleted_on_remote?.length ?? 0) > 0 && (
  <div>Smazáno na remote: {result.deleted_on_remote.map((f) => f.filename).join(", ")}</div>
)}
{(result.sweep_errors?.length ?? 0) > 0 && (
  <div style={{ color: "var(--color-danger)" }}>
    Kontrola remote selhala: {result.sweep_errors.map((e) => e.remote_path).join(", ")}
  </div>
)}
```

- [ ] **Step 6: Run tests, typecheck, web typecheck**

Run: `node --import tsx --test test/sync-run-sweep.test.ts test/rest-smoke.test.ts && npx tsc --noEmit -p tsconfig.json && npm --prefix apps/web run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server apps/web/src test/sync-run-sweep.test.ts
git commit -m "feat(sync): sync run sweeps the remote before scanning"
```

---

### Task 5: Central mode — sweep endpoint and client

**Files:**
- Modify: `apps/server/api/nodes.ts` (new `handleRemoteSweep`), `apps/server/api/router.ts:470-500` (route `POST /nodes/:id/sync/remote-sweep`, before the `/sync` matcher)
- Modify: `apps/server/domain/sync/central/client.ts:35-76` (interface) and the HTTP implementation next to `deleteFileRecord`
- Modify: `apps/server/domain/sync/central/engine-central.ts:885-905` (`syncRunCentral`)
- Modify: `test/engine-central.test.ts:35-120` (`FakeCentral`), `test/agent-tools.test.ts` `FakeCentral`, `test/agent-router.test.ts` fake client
- Test: `test/engine-central.test.ts`

**Interfaces:**
- Produces: `CentralClient.remoteSweep(nodeId: string): Promise<RemoteSweepResult>`; server route `POST /nodes/:id/sync/remote-sweep` → `RemoteSweepResult` (min-scope: same as `POST /nodes/:id/sync`; check `apps/server/auth/min-scopes.ts` and add the path with the same scope as `/sync`).

- [ ] **Step 1: Write the failing test** (append to `test/engine-central.test.ts`; extend `FakeCentral` with `sweepResult: RemoteSweepResult = { adopted: [], deleted_on_remote: [], errors: [] }` and `async remoteSweep(nodeId: string) { if (nodeId !== NODE_ID) throw new CentralHttpError("not found", 404, "NOT_FOUND"); this.sweepCalls++; return this.sweepResult; }` plus `sweepCalls = 0`)

```ts
it("sync run calls the central remote sweep first and reports its results", async () => {
  const fake = new FakeCentral();
  await setupMirror();
  fake.sweepResult = {
    adopted: [{ file_id: "F9", filename: "report.md", remote_path: posix.join(NODE_ROOT, "outputs/report.md") }],
    deleted_on_remote: [],
    errors: [],
  };
  const r = await syncRunCentral(fake, { userId: "U1", nodeId: NODE_ID });
  assert.equal(fake.sweepCalls, 1);
  assert.deepEqual(r.adopted_remote, [{ file_id: "F9", filename: "report.md" }]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/engine-central.test.ts`
Expected: FAIL — `fake.remoteSweep` not part of `CentralClient` / `adopted_remote` undefined (TypeScript error counts as the failure here; `tsx` reports it at import).

- [ ] **Step 3: Server endpoint**

In `nodes.ts`:

```ts
// Central-mode entry point for the sync agent: the remote credentials live
// here, so the sweep (and pending-op retry, Task 6) runs server side and the
// device consumes the outcome through sync-info tombstones + pull.
export async function handleRemoteSweep(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<void> {
  try {
    const db = getDb();
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    respondJson(res, 200, await remoteSweep(db, { userId: identity.userId, nodeId }));
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/sync/remote-sweep`, err);
  }
}
```

In `router.ts`, before the `syncRunMatch` block:

```ts
const sweepMatch = pathname.match(/^\/nodes\/([^/]+)\/sync\/remote-sweep$/);
if (sweepMatch && req.method === "POST") {
  await handleRemoteSweep(req, res, identity, decodeURIComponent(sweepMatch[1]));
  return;
}
```

(Mirror the exact style of the surrounding matchers — check whether they `return true` or `return`.) Add the path to `min-scopes.ts` with the scope used for `POST /nodes/:id/sync`.

- [ ] **Step 4: Client + sync run**

`client.ts` interface: `remoteSweep(nodeId: string): Promise<RemoteSweepResult>;` (import the type from `../remote-sweep.js`). Implementation next to `deleteFileRecord`:

```ts
async remoteSweep(nodeId) {
  const p = `/nodes/${encodeURIComponent(nodeId)}/sync/remote-sweep`;
  const r = await request("POST", p);
  invalidate(nodeId);
  if (r.status !== 200) throwFor(r.status, p, r.json);
  return r.json as RemoteSweepResult;
},
```

`syncRunCentral`: before `loadNodeContext`:

```ts
const sweep = await client.remoteSweep(a.nodeId);
```

and after the `result` literal push `sweep.adopted` into `result.adopted_remote`, `sweep.deleted_on_remote` into `result.deleted_on_remote`, `sweep.errors` into `result.sweep_errors` (same mapping as Task 4). `loadNodeContext` must run after the sweep so the sync-info carries the new records and tombstones (`invalidate(nodeId)` in the client guarantees a fresh fetch).

Add a no-op `remoteSweep` to the fake clients in `test/agent-tools.test.ts` and `test/agent-router.test.ts` (`async remoteSweep() { return { adopted: [], deleted_on_remote: [], errors: [] }; }`).

- [ ] **Step 5: Run tests**

Run: `node --import tsx --test test/engine-central.test.ts test/agent-tools.test.ts test/agent-router.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server test
git commit -m "feat(sync): central remote-sweep endpoint, agent sync run calls it first"
```

---

### Task 6: Pending file operations — intents with idempotent retry

**Files:**
- Modify: `apps/server/infra/schema.ts` (DDL next to the `audit_log` table), `apps/server/infra/schema-migrations.ts:1139-1147` (migration `023_pending_file_ops`)
- Create: `apps/server/domain/sync/pending-ops.ts`
- Modify: `apps/server/domain/sync/engine-mutations.ts` (`moveFile`, `renameFile`, `renameFolder`, `deleteFile`), `apps/server/domain/sync/file-content-remote.ts:659-760` (`deleteFileRemote`)
- Modify: `apps/server/api/nodes.ts` (`handleSyncRun`, `handleRemoteSweep` call the retry first), `apps/server/shared/api-types.ts` (`SyncRunResponse.pending_repairs`), `apps/server/domain/sync/remote-sweep.ts` (`RemoteSweepResult.repaired`, `.pending_repairs`)
- Test: `test/sync-pending-ops.test.ts` (new), `test/sync-engine-partial-failure.test.ts` (existing partial-failure fixtures — reuse its adapter-failure injection pattern)

**Interfaces:**

```ts
// pending-ops.ts
export type PendingOp =
  | { op: "move"; from_remote_name: string; from_remote_path: string; to_remote_name: string; to_remote_path: string; to_node_id: string; filename: string }
  | { op: "delete"; remote_name: string; remote_path: string; filename: string };
export interface PendingOpRow { id: string; user_id: string; node_id: string; file_id: string; payload: PendingOp; attempts: number; last_error: string | null }
export async function enqueuePendingOp(db: Client, a: { userId: string; nodeId: string; fileId: string; payload: PendingOp }): Promise<string>
export async function completePendingOp(db: Client, id: string): Promise<void>
export async function failPendingOp(db: Client, id: string, error: string): Promise<void>
export async function listPendingOps(db: Client, nodeId: string): Promise<PendingOpRow[]>
export interface RetryResult { repaired: Array<{ file_id: string; op: PendingOp["op"] }>; pending_repairs: Array<{ file_id: string; op: PendingOp["op"]; attempts: number; last_error: string | null }> }
export async function retryPendingFileOps(db: Client, a: { userId: string; nodeId: string }): Promise<RetryResult>
```

- [ ] **Step 1: DDL + migration**

`schema.ts` (with the other `CREATE TABLE IF NOT EXISTS` statements):

```sql
CREATE TABLE IF NOT EXISTS pending_file_ops (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_file_ops_node ON pending_file_ops(node_id);
```

`schema-migrations.ts`, appended to `MIGRATIONS`:

```ts
{
  id: "023_pending_file_ops",
  isApplied: async (db) => {
    const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_file_ops'");
    return r.rows.length > 0;
  },
  up: async (db) => {
    await db.execute(`CREATE TABLE IF NOT EXISTS pending_file_ops (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, node_id TEXT NOT NULL, file_id TEXT NOT NULL,
      payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at DATETIME NOT NULL DEFAULT (datetime('now')))`);
    await db.execute("CREATE INDEX IF NOT EXISTS idx_pending_file_ops_node ON pending_file_ops(node_id)");
  },
},
```

Run `node --import tsx --test test/migration-022-drop-nodes-summary.test.ts test/db-foreign-keys.test.ts` to confirm the schema still loads.

- [ ] **Step 2: Write the failing tests**

```ts
// test/sync-pending-ops.test.ts (same beforeEach/afterEach as test/sync-remote-sweep.test.ts)
import { enqueuePendingOp, listPendingOps, retryPendingFileOps } from "../apps/server/domain/sync/pending-ops.js";
import { moveFile, deleteFile } from "../apps/server/domain/sync/engine-mutations.js";
import { getAdapter, invalidateAdapter } from "../apps/server/domain/sync/adapter-cache.js";

describe("pending file ops", () => {
  it("a completed move leaves no pending op", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    await moveFile(db, { userId: "U1", fileId: r.file_id, newSection: "outputs", confirmed: true });
    assert.equal((await listPendingOps(db, nodeId)).length, 0);
  });

  it("a move whose remote step fails stays pending and is completed by the retry", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    // Break the remote: make the rename fail once by replacing the adapter.
    const real = await getAdapter(db, "test-fs");
    let fail = true;
    const broken = { ...real, rename: async (from: string, to: string) => { if (fail) throw new Error("boom"); return real.rename(from, to); } };
    (await import("../apps/server/domain/sync/adapter-cache.js")).__setAdapterForTests?.("test-fs", broken);
    const mv = await moveFile(db, { userId: "U1", fileId: r.file_id, newSection: "outputs", confirmed: true });
    assert.equal("status" in mv && mv.status, "repair_needed");
    const pending = await listPendingOps(db, nodeId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].payload.op, "move");
    assert.equal(pending[0].last_error, "boom");
    fail = false;
    const retry = await retryPendingFileOps(db, { userId: "U1", nodeId });
    assert.deepEqual(retry.repaired, [{ file_id: r.file_id, op: "move", filename: "a.md" }]);
    assert.equal((await listPendingOps(db, nodeId)).length, 0);
    const row = await db.execute({ sql: "SELECT remote_path FROM files WHERE id = ?", args: [r.file_id] });
    assert.ok((row.rows[0].remote_path as string).includes("/outputs/"));
    assert.ok(await stat(join(remoteRoot, row.rows[0].remote_path as string)));
  });

  it("retry of a move already applied on the remote only fixes the record", async () => {
    const { db, nodeId, remoteRoot, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    const nodeRoot = `${orgSyncKey}/projects/${nodeSyncKey}`;
    const to = `${nodeRoot}/outputs/a.md`;
    await mkdir(join(remoteRoot, nodeRoot, "outputs"), { recursive: true });
    await rename(join(remoteRoot, r.remote_path), join(remoteRoot, to));
    await enqueuePendingOp(db, { userId: "U1", nodeId, fileId: r.file_id, payload: {
      op: "move", from_remote_name: "test-fs", from_remote_path: r.remote_path,
      to_remote_name: "test-fs", to_remote_path: to, to_node_id: nodeId, filename: "a.md",
    } });
    const retry = await retryPendingFileOps(db, { userId: "U1", nodeId });
    assert.equal(retry.repaired.length, 1);
    const row = await db.execute({ sql: "SELECT remote_path FROM files WHERE id = ?", args: [r.file_id] });
    assert.equal(row.rows[0].remote_path, to);
  });

  it("a delete whose remote step fails is completed by the retry and leaves a tombstone", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const r = await pushed(db, nodeId, mirrorRoot, "a.md");
    const real = await getAdapter(db, "test-fs");
    let fail = true;
    const broken = { ...real, delete: async (p: string) => { if (fail) throw new Error("boom"); return real.delete(p); } };
    (await import("../apps/server/domain/sync/adapter-cache.js")).__setAdapterForTests?.("test-fs", broken);
    const d = await deleteFile(db, { userId: "U1", fileId: r.file_id, confirmed: true });
    assert.equal(d.status, "repair_needed");
    fail = false;
    const retry = await retryPendingFileOps(db, { userId: "U1", nodeId });
    assert.deepEqual(retry.repaired, [{ file_id: r.file_id, op: "delete", filename: "a.md" }]);
    const row = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [r.file_id] });
    assert.equal(row.rows.length, 0);
    const tomb = await db.execute({ sql: "SELECT id FROM audit_log WHERE action = 'sync_delete' AND target_id = ?", args: [r.file_id] });
    assert.equal(tomb.rows.length, 1);
  });

  it("an op that keeps failing is reported, not dropped", async () => {
    const { db, nodeId } = await makeSharedDb();
    await enqueuePendingOp(db, { userId: "U1", nodeId, fileId: "F-missing", payload: {
      op: "delete", remote_name: "test-fs", remote_path: "workflow/projects/stan-gws/wip/x.md", filename: "x.md",
    } });
    const retry = await retryPendingFileOps(db, { userId: "U1", nodeId });
    // The record is gone and the remote object never existed: the op can
    // complete as a no-op delete (idempotent).
    assert.equal(retry.repaired.length, 1);
  });
});
```

Add to `adapter-cache.ts`:

```ts
export function __setAdapterForTests(name: string, adapter: FileAdapter): void { cache.set(name, adapter); }
```

- [ ] **Step 3: Run to verify failure**

Run: `node --import tsx --test test/sync-pending-ops.test.ts`
Expected: FAIL — module `pending-ops.js` missing.

- [ ] **Step 4: Implement `pending-ops.ts`**

```ts
import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { getAdapter } from "./adapter-cache.js";
import { deleteFileState } from "./local-db.js";

export type PendingOp =
  | { op: "move"; from_remote_name: string; from_remote_path: string; to_remote_name: string; to_remote_path: string; to_node_id: string; filename: string }
  | { op: "delete"; remote_name: string; remote_path: string; filename: string };

export interface PendingOpRow {
  id: string; user_id: string; node_id: string; file_id: string;
  payload: PendingOp; attempts: number; last_error: string | null;
}

export async function enqueuePendingOp(
  db: Client,
  a: { userId: string; nodeId: string; fileId: string; payload: PendingOp },
): Promise<string> {
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO pending_file_ops (id, user_id, node_id, file_id, payload) VALUES (?, ?, ?, ?, ?)`,
    args: [id, a.userId, a.nodeId, a.fileId, JSON.stringify(a.payload)],
  });
  return id;
}

export async function completePendingOp(db: Client, id: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM pending_file_ops WHERE id = ?", args: [id] });
}

export async function failPendingOp(db: Client, id: string, error: string): Promise<void> {
  await db.execute({
    sql: `UPDATE pending_file_ops SET attempts = attempts + 1, last_error = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [error, id],
  });
}

export async function listPendingOps(db: Client, nodeId: string): Promise<PendingOpRow[]> {
  const r = await db.execute({
    sql: "SELECT id, user_id, node_id, file_id, payload, attempts, last_error FROM pending_file_ops WHERE node_id = ? ORDER BY created_at",
    args: [nodeId],
  });
  return r.rows.map((row) => ({
    id: row.id as string, user_id: row.user_id as string, node_id: row.node_id as string,
    file_id: row.file_id as string, payload: JSON.parse(row.payload as string) as PendingOp,
    attempts: Number(row.attempts), last_error: (row.last_error as string | null) ?? null,
  }));
}

// Idempotent executors. Each one looks at the remote first and only does the
// steps that are still missing, then fixes the record and audits the outcome
// with the same rows the first-time path writes (tombstones included).
async function runMove(db: Client, row: PendingOpRow, p: Extract<PendingOp, { op: "move" }>): Promise<void> {
  const src = await getAdapter(db, p.from_remote_name);
  const dst = p.to_remote_name === p.from_remote_name ? src : await getAdapter(db, p.to_remote_name);
  const atFrom = await src.stat(p.from_remote_path);
  const atTo = await dst.stat(p.to_remote_path);
  if (atFrom && atTo) throw new Error(`both ${p.from_remote_path} and ${p.to_remote_path} exist on the remote`);
  if (!atFrom && !atTo) throw new Error(`neither ${p.from_remote_path} nor ${p.to_remote_path} exists on the remote`);
  if (atFrom && !atTo) {
    if (src === dst) await src.rename(p.from_remote_path, p.to_remote_path);
    else { await dst.put(p.to_remote_path, await src.get(p.from_remote_path)); await src.delete(p.from_remote_path); }
  }
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE files SET remote_name = ?, remote_path = ?, node_id = ?, filename = ?, updated_at = ? WHERE id = ?`,
    args: [p.to_remote_name, p.to_remote_path, p.to_node_id, p.filename, now, row.file_id],
  });
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_move', 'file', ?, ?, ?)`,
    args: [ulid(), row.user_id, row.file_id, JSON.stringify({
      node_id: row.node_id, old_remote_path: p.from_remote_path, repaired: true,
      old: { remote_name: p.from_remote_name, remote_path: p.from_remote_path },
      new: { remote_name: p.to_remote_name, remote_path: p.to_remote_path },
    }), now],
  });
}

async function runDelete(db: Client, row: PendingOpRow, p: Extract<PendingOp, { op: "delete" }>): Promise<void> {
  const adapter = await getAdapter(db, p.remote_name);
  if ((await adapter.stat(p.remote_path)) !== null) await adapter.delete(p.remote_path);
  await db.execute({ sql: "DELETE FROM files WHERE id = ?", args: [row.file_id] });
  await deleteFileState(row.file_id).catch(() => undefined);
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_delete', 'file', ?, ?, ?)`,
    args: [ulid(), row.user_id, row.file_id, JSON.stringify({
      mode: "complete", node_id: row.node_id, remote_name: p.remote_name,
      remote_path: p.remote_path, filename: p.filename, repaired: true,
    }), new Date().toISOString()],
  });
}

export interface RetryResult {
  repaired: Array<{ file_id: string; op: PendingOp["op"]; filename: string }>;
  pending_repairs: Array<{ file_id: string; op: PendingOp["op"]; attempts: number; last_error: string | null }>;
}

export async function retryPendingFileOps(db: Client, a: { userId: string; nodeId: string }): Promise<RetryResult> {
  const out: RetryResult = { repaired: [], pending_repairs: [] };
  for (const row of await listPendingOps(db, a.nodeId)) {
    try {
      if (row.payload.op === "move") await runMove(db, row, row.payload);
      else await runDelete(db, row, row.payload);
      await completePendingOp(db, row.id);
      out.repaired.push({ file_id: row.file_id, op: row.payload.op, filename: row.payload.filename });
    } catch (e) {
      const error = (e as Error).message;
      await failPendingOp(db, row.id, error);
      out.pending_repairs.push({ file_id: row.file_id, op: row.payload.op, attempts: row.attempts + 1, last_error: error });
    }
  }
  return out;
}
```

- [ ] **Step 5: Enqueue in the mutation functions**

`engine-mutations.ts`:
- `moveFile` (confirmed path): before the remote step, `const opId = await enqueuePendingOp(db, { userId: a.userId, nodeId: fr.node_id as string, fileId: a.fileId, payload: { op: "move", from_remote_name: oldRemoteName, from_remote_path: oldRemotePath, to_remote_name: newRemoteName, to_remote_path: newRemotePath, to_node_id: targetNodeId, filename } });`. In the remote `catch`, call `await failPendingOp(db, opId, (e as Error).message)` before returning `repair_needed`. After the DB update (step 3) call `await completePendingOp(db, opId)`. The local-phase failure branch also completes the op (the remote + record are done; the local side is the tombstone's job now) — keep its `repair_needed` return for API compatibility.
- `renameFile`: same enqueue with `to_node_id: nodeId`, `filename: fn`; complete after the DB update; on `adapter.rename` throw, fail the op and rethrow.
- `renameFolder` (applied): enqueue per file before `adapter.rename`; complete after that file's DB update; on the remote `catch`, fail the op.
- `deleteFile` (`mode === "complete"` with a remote binding): enqueue `{ op: "delete", remote_name, remote_path, filename }` before the remote step; fail it in the `catch`; complete after the `DELETE FROM files`. `unregister_only` does not enqueue.

`file-content-remote.ts` `deleteFileRemote`: same enqueue/fail/complete around its remote step (this is the central server path).

- [ ] **Step 6: Run the retry at the start of every sync run**

- `remote-sweep.ts`: add `repaired: RetryResult["repaired"]` and `pending_repairs: RetryResult["pending_repairs"]` to `RemoteSweepResult`; at the top of `remoteSweep` call `const retry = await retryPendingFileOps(db, a);` and copy both arrays into `out` (so central mode gets them through the endpoint for free).
- `api-types.ts`: `SyncRunResponse.pending_repairs: Array<{ file_id: string; op: string; attempts: number; last_error: string | null }>` and `repaired: SyncRunFile[]`.
- `nodes.ts` `handleSyncRun` and `engine-central.ts` `syncRunCentral`: copy `sweep.repaired` (`{ file_id, filename }`) and `sweep.pending_repairs` into the result. Add `repaired: [], pending_repairs: []` to the `sweepResult` literals of the fake clients from Task 5.
- Web result box: `{result.pending_repairs.length > 0 && <div style={{ color: "var(--color-danger)" }}>Nedokončené operace: {result.pending_repairs.length} (poslední chyba: {result.pending_repairs[0].last_error})</div>}`.

- [ ] **Step 7: Run tests**

Run: `node --import tsx --test test/sync-pending-ops.test.ts test/sync-engine-move.test.ts test/sync-engine-delete.test.ts test/sync-engine-delete-repair.test.ts test/sync-engine-partial-failure.test.ts test/sync-engine-rename-folder.test.ts test/sync-rename.test.ts test/sync-remote-sweep.test.ts test/engine-central.test.ts && npx tsc --noEmit -p tsconfig.json && npm --prefix apps/web run typecheck`
Expected: PASS. Existing partial-failure tests still see `repair_needed` (the return shapes are unchanged).

- [ ] **Step 8: Commit**

```bash
git add apps/server apps/web/src test
git commit -m "feat(sync): file mutations are pending ops, retried by the sync run until complete"
```

---

### Task 7: Resolve endpoint (local + agent)

**Files:**
- Modify: `apps/server/api/nodes.ts` (`handleResolveFile`), `apps/server/api/router.ts` (route, before the bare `/files/:id` matcher), `apps/server/auth/min-scopes.ts`
- Modify: `apps/server/api/agent-router.ts` (agent route), `apps/server/domain/sync/central/engine-central.ts` (`StoreFileCentralArgs.force`), `apps/server/mcp/agent-tools.ts:53` (export `findEntryByFileId`)
- Test: `test/sync-resolve-rest.test.ts` (new, local; bootstrap from `test/rest-smoke.test.ts`), `test/agent-router.test.ts` (agent case)

**Interfaces:**
- Produces: `POST /nodes/:id/files/:fileId/resolve` body `{ action: "keep_local" | "take_remote" | "restore" }` → `{ file_id, action, status: "ok" }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/sync-resolve-rest.test.ts (cases; bootstrap as in test/rest-smoke.test.ts)
it("keep_local pushes the local version over a remote edit", async () => {
  // arrange: push wip/a.md; edit remote copy to "remote"; edit local to "local" -> conflict
  const r = await fetch(`${base}/nodes/${nodeId}/files/${fileId}/resolve`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "keep_local" }),
  });
  assert.equal(r.status, 200);
  assert.equal(await readFile(join(remoteRoot, remotePath), "utf8"), "local");
  const status = await (await fetch(`${base}/nodes/${nodeId}/sync-status`, { headers })).json();
  assert.equal(status.files.find((f: { file_id: string }) => f.file_id === fileId).sync_class, "clean");
});

it("take_remote overwrites the local edit with the remote version", async () => {
  // same arrangement
  // POST { action: "take_remote" } -> local file reads "remote", status clean
});

it("restore re-downloads a locally deleted file", async () => {
  // arrange: push, rm local copy -> deleted_local
  // POST { action: "restore" } -> local file exists, status clean
});

it("rejects an unknown action with 400", async () => { /* body { action: "nope" } -> 400 */ });
```

Agent case in `test/agent-router.test.ts` (uses its `FakeCentral`): after seeding a conflict (`seedRemote("wip/a.md", "remote")`, local write "local", `file_state` with a differing baseline), `POST /nodes/:id/files/:fileId/resolve { action: "keep_local" }` → `fake.bytes.get(remotePath)` equals `local`; `take_remote` → local file reads `remote`.

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/sync-resolve-rest.test.ts test/agent-router.test.ts`
Expected: FAIL with 404 on the resolve route.

- [ ] **Step 3: Local handler**

```ts
// nodes.ts
const RESOLVE_ACTIONS = new Set(["keep_local", "take_remote", "restore"]);

export async function handleResolveFile(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
  fileId: string,
): Promise<void> {
  try {
    const body = (await parseBody(req)) as { action?: string } | undefined;
    const action = body?.action;
    if (!action || !RESOLVE_ACTIONS.has(action)) {
      respondJson(res, 400, { error: "action must be keep_local | take_remote | restore" });
      return;
    }
    const db = getDb();
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    if (action === "keep_local") {
      const row = await db.execute({ sql: "SELECT node_id, remote_path FROM files WHERE id = ?", args: [fileId] });
      if (row.rows.length === 0) { respondJson(res, 404, { error: "file not found" }); return; }
      const mirrorRoot = await getMirrorPath(identity.userId, nodeId);
      if (!mirrorRoot) { respondJson(res, 409, { error: "node has no mirror on this device" }); return; }
      const localPath = deriveLocalPath({
        mirrorRoot,
        nodeRoot: buildNodeRoot(await resolveNodeInfo(db, nodeId)),
        remotePath: row.rows[0].remote_path as string,
      });
      await storeFile(db, { userId: identity.userId, nodeId, localPath });
    } else {
      await pullFile(db, { userId: identity.userId, fileId, force: action === "take_remote" });
    }
    respondJson(res, 200, { file_id: fileId, action, status: "ok" });
  } catch (err) {
    respondError(res, `POST /nodes/${nodeId}/files/${fileId}/resolve`, err);
  }
}
```

Router (before the bare `/files/:id` DELETE matcher): `const resolveMatch = pathname.match(/^\/nodes\/([^/]+)\/files\/([^/]+)\/resolve$/);` → `handleResolveFile`. Add the path to `min-scopes.ts` with the scope of the file rename route.

- [ ] **Step 4: Agent handler**

`engine-central.ts`: add `force?: boolean` to `StoreFileCentralArgs`; where `storeFileCentral` calls `pushEntryCentral`/`putFileRaw`, pass `{ force: true }` when set (replace the `baseCanonicalHash`/`ifAbsent` precondition with `{ force: true }`). Export `findEntryByFileId` from `agent-tools.ts`.

`agent-router.ts`, next to the sync-run matcher:

```ts
const resolveMatch = pathname.match(/^\/nodes\/([^/]+)\/files\/([^/]+)\/resolve$/);
if (resolveMatch && method === "POST") {
  const nodeId = decodeURIComponent(resolveMatch[1]);
  const fileId = decodeURIComponent(resolveMatch[2]);
  try {
    const body = (await parseBody(req)) as { action?: string } | undefined;
    const action = body?.action;
    if (action !== "keep_local" && action !== "take_remote" && action !== "restore") {
      respondJson(res, 400, { error: "action must be keep_local | take_remote | restore" });
      return true;
    }
    const found = await findEntryByFileId(client, identity.userId, fileId);
    if (!found || !found.entry.local_path) { respondJson(res, 404, { error: "file not found on this device" }); return true; }
    if (action === "keep_local") {
      await storeFileCentral(client, { userId: identity.userId, nodeId, localPath: found.entry.local_path, force: true });
    } else {
      await pullFileCentral(client, { userId: identity.userId, nodeId, entry: found.entry, force: action === "take_remote" });
    }
    respondJson(res, 200, { file_id: fileId, action, status: "ok" });
  } catch (err) {
    if (respondCentral404(res, err)) return true;
    respondError(res, `POST /nodes/${nodeId}/files/${fileId}/resolve`, err);
  }
  return true;
}
```

- [ ] **Step 5: Run tests**

Run: `node --import tsx --test test/sync-resolve-rest.test.ts test/agent-router.test.ts test/rest-smoke.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server test
git commit -m "feat(api): resolve endpoint for conflicts and locally deleted files"
```

---

### Task 8: UI actions on the file row

**Files:**
- Modify: `apps/web/src/api.ts` (after `renameFile`), `apps/web/src/components/DetailPane.files.tsx` (`FileRow` props + buttons, the prop plumbing at `:273-363`, `:415`, `:490-560`), `apps/web/src/components/DetailPane.tsx:560-590` (handler next to `handleRename`/`handleDelete`)

**Interfaces:**
- Produces: `resolveFileSync(nodeId, fileId, action): Promise<{ file_id: string; action: string; status: "ok" }>`; `FileRow` prop `onResolve: (fileId: string, action: "keep_local" | "take_remote" | "restore") => Promise<void>`.

- [ ] **Step 1: API function**

```ts
export type ResolveAction = "keep_local" | "take_remote" | "restore";
export function resolveFileSync(nodeId: string, fileId: string, action: ResolveAction): Promise<{ file_id: string; action: ResolveAction; status: "ok" }> {
  return jsonRequest("POST", `/nodes/${encodeURIComponent(nodeId)}/files/${encodeURIComponent(fileId)}/resolve`, { action });
}
```

- [ ] **Step 2: Row buttons**

In `FileRow`, after the rename/delete controls, render when `sync?.sync_class === "conflict"`:

```tsx
<button onClick={() => act("keep_local")} disabled={busy} title="Nahrát lokální verzi na remote" className={ACTION_BTN}>Ponechat lokální</button>
<button onClick={() => act("take_remote")} disabled={busy} title="Přepsat lokální kopii verzí z remote" className={ACTION_BTN}>Vzít z remote</button>
```

and when `sync?.sync_class === "deleted_local"`:

```tsx
<button onClick={() => act("restore")} disabled={busy} title="Stáhnout znovu z remote" className={ACTION_BTN}>Obnovit</button>
```

(the existing "Smazat" button already deletes everywhere) with

```tsx
const act = (action: ResolveAction) => {
  setBusy(true);
  void onResolve(f.fileId!, action).finally(() => setBusy(false));
};
```

`ACTION_BTN` = the class string used by the existing rename/delete buttons in the same row. Thread `onResolve` through the same components that pass `onRename`/`onDelete`.

In `DetailPane.tsx`, next to `handleRename`:

```tsx
const handleResolve = async (fileId: string, action: ResolveAction) => {
  try {
    await resolveFileSync(node.id, fileId, action);
    await Promise.all([onMutate(), loadSyncStatus()]);
  } catch (e) {
    setFilesError(e instanceof Error ? e.message : String(e)); // use the pane's existing error setter
  }
};
```

Update the conflict badge title in the sync section (`DetailPane.files.tsx:788` area) to `"Konflikt: vyber verzi u souboru (Ponechat lokální / Vzít z remote)."` and the deleted-local title to `"Smazáno lokálně: Obnovit stáhne kopii znovu, Smazat odstraní soubor všude."`.

- [ ] **Step 3: Typecheck + build**

Run: `npm --prefix apps/web run typecheck && npm --prefix apps/web run build`
Expected: no errors.

- [ ] **Step 4: Verify in the browser** — start the backend (`npm run build`, tmux `portuni-mcp` restart) and Vite (`varlock run -- npm --prefix apps/web run dev`), open a node with a conflict (edit the same file on disk and on the remote), click both buttons, confirm the badge turns `synced`. Record what you saw in the commit message body.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): resolve buttons for conflicts and locally deleted files"
```

---

### Task 9: Documentation

**Files:**
- Modify: `sites/docs/src/content/docs/reference/files.md:90-100`, `:170-190`; `sites/docs/src/content/docs/reference/sync.md:90-135`; `sites/docs/src/content/docs/concepts/mirrors.md` (deletions section); `apps/server/mcp/resources/sync-model.md:48`; `docs/architecture/file-sync.md:320-336`; `docs/architecture/file-mutation-propagation.md` (table: add "Deleted / added on the remote" and "Half-finished mutation" rows); `CLAUDE.md` gotcha "File state is deterministic" (add: sync run sweeps the remote, retries pending ops)

- [ ] **Step 1: Update class lists** — replace `orphan` with `remote_missing` / `remote_error` everywhere, add the definitions from the spec's rule 3.

- [ ] **Step 2: Document the sync run order** in `reference/sync.md` and `architecture/file-sync.md`:

```
1. retry pending file ops (moves/renames/deletes that failed half-way)
2. remote sweep: records of files deleted on the remote are removed (tombstone); files new on the remote are adopted
3. status scan
4. push / pull
5. tombstone cleanup of local copies (deleted or moved elsewhere, byte-identical to last sync)
6. adopt untracked local files (including edited copies of remotely deleted files, which return to the remote)
```

- [ ] **Step 3: Document the resolve actions** in `reference/files.md` (REST) and the UI buttons in `concepts/mirrors.md`.

- [ ] **Step 4: Build the docs site**

Run: `npm --prefix sites/docs run build`
Expected: build completes.

- [ ] **Step 5: Commit**

```bash
git add sites/docs docs apps/server/mcp/resources/sync-model.md CLAUDE.md
git commit -m "docs: deterministic file reconciliation (sweep, pending ops, resolve actions)"
```

---

### Task 10: Full verification and merge

- [ ] `npm run qa` (lint + typecheck + tests + build) passes.
- [ ] `scripts/agent-gate.sh` passes (server qa, web typecheck + build, docs build).
- [ ] Deploy with `scripts/deploy-vps.sh` from the merged `main` (migration 023 creates a table only — no backup needed, but `npm run backup` first is the documented default before a migration).
- [ ] Install the desktop `.app` on a release checkpoint only (`scripts/build-signed.sh --no-notarize`), not per commit.
