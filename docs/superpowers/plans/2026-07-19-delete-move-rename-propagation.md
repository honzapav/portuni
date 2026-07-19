# Delete/Move/Rename Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** File delete/move/rename propagates completely between disk and record from every origin (MCP tool, web UI / other device, raw `mv`/`rm` on disk) — no duplicates, no resurrected deletions, no silent skips.

**Architecture:** Three complementary mechanisms mapped to the three origins: (1) the agent front door applies the local disk step synchronously after a proxied central mutation (GH #78); (2) delete tombstones from `audit_log` are exposed per node in sync-info and matched during discovery, so other devices clean up deterministically (GH #79); (3) the mirror watcher detects an on-disk `mv` via inode identity and calls the existing `moveFile`/central move instead of registering a duplicate. The dead `moveDetectionPhase` is removed.

**Tech Stack:** Node + libSQL (Turso), node:test + tsx, existing sync engine (`apps/server/domain/sync/`).

## Global Constraints

- Data is never destroyed: a local file modified after a remote delete must stay `new_local` (hash mismatch ⇒ no cleanup). `sync_delete_repair_needed` / `sync_delete_remote_repair_needed` audit rows are NOT tombstones (exact-action match only).
- All new sync-layer regression tests for move detection run **with an active watcher** (injected `watchFactory`, real `reconcilePath`) — the configuration in which the old `moveDetectionPhase` was dead code.
- Conventional Commits (`fix(sync): …`, `feat(sync): …`) — release-please parses these.
- No emoji in code. Follow surrounding comment style (English, explains constraints).
- `sites/docs/src` must be updated in the same branch for behavior changes (sync classes, deletion propagation).

## Key existing signatures (read before you start)

- `moveFile(db, {userId, fileId, newNodeId?, newSection?, newSubpath?, confirmed})` → preview | success | repair_needed. Remote step is `adapter.rename` (Drive PATCH, keeps file ID). `apps/server/domain/sync/engine-mutations.ts:90`.
- `deleteFile(db, {userId, fileId, mode, confirmed})` writes audit `sync_delete` with detail `{mode, remote_name, remote_path, local_path, filename}`. `engine-mutations.ts:638`.
- `deleteFileRemote(db, {userId, nodeId, fileId, mode, confirmed})` writes `sync_delete_remote` with detail `{remote_name, remote_path, filename}` via `auditFile(db, userId, action, fileId, detail, now)`. `file-content-remote.ts`.
- `reconcilePath(db, {userId, nodeId, absPath})` — watcher callback, local mode. Registers untracked files via `registerLocalFile`. `reconcile.ts:49`.
- `reconcilePathCentral(client, {userId, nodeId, absPath})` — central mode equivalent. `central/engine-central.ts:654`.
- `file_state` (device-local sync.db): `file_id PK, last_synced_hash, last_synced_at, cached_local_hash, cached_mtime, cached_size`. CRUD in `local-db.ts` (`upsertFileState`, `getFileState`, `deleteFileState`).
- `NodeSyncInfo {node, remote_name, files: SyncInfoFile[]}` from `getNodeSyncInfo(db, nodeId)` (`sync-remote-api.ts:49`), served by `GET /nodes/:id/sync-info` + `POST /sync/info-batch`, consumed by `CentralClient.syncInfo/syncInfoBatch`.
- `NewLocalEntry {node_id, local_path, section, subpath, filename, hash}` (`engine.ts:548`).
- Agent front door: `agent-transport.ts` CallTool handler routes `LOCAL_TOOLS` locally, everything else `upstream.callTool` verbatim (line ~124-177). `portuni_delete_file`, `portuni_move_file`, `portuni_rename_folder` are proxied.
- Watcher: `createMirrorWatcher(deps)` with injectable `watchFactory`, `reconcile`, `listMirrors` (`mirror-watcher.ts:94`) — use these seams in tests.

---

### Task 1: Tombstone exposure in sync-info (GH #79, server side)

**Files:**
- Modify: `apps/server/domain/sync/engine-mutations.ts` (sync_delete detail: add `node_id`)
- Modify: `apps/server/domain/sync/file-content-remote.ts` (sync_delete_remote detail: add `node_id`)
- Modify: `apps/server/domain/sync/sync-remote-api.ts` (`NodeSyncInfo.deleted`, query)
- Modify: `apps/server/domain/sync/central/client.ts` (type only — `NodeSyncInfo` already imported)
- Test: `test/sync-remote-api.test.ts` (extend existing)

**Interfaces:**
- Produces: `NodeSyncInfo.deleted: DeletedTombstone[]` where `interface DeletedTombstone { file_id: string; remote_path: string }` (exported from `sync-remote-api.ts`). Tasks 2 and 3 rely on this exact shape.

- [ ] **Step 1: Write the failing test** — in `test/sync-remote-api.test.ts` (follow the file's existing setup helpers for an in-memory db with `nodes`/`files`/`audit_log`):

```ts
it("exposes delete tombstones for the node, excluding repair_needed rows", async () => {
  // Arrange: two audit rows for node N1 (one sync_delete, one
  // sync_delete_remote), one repair_needed row, one row for another node.
  const now = new Date().toISOString();
  const mk = (action: string, fileId: string, nodeId: string) =>
    db.execute({
      sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
            VALUES (?, 'U1', ?, 'file', ?, ?, ?)`,
      args: [ulid(), action, fileId, JSON.stringify({ node_id: nodeId, remote_path: `p/${fileId}.md` }), now],
    });
  await mk("sync_delete", "F1", "N1");
  await mk("sync_delete_remote", "F2", "N1");
  await mk("sync_delete_repair_needed", "F3", "N1");
  await mk("sync_delete", "F4", "N-OTHER");

  const info = await getNodeSyncInfo(db, "N1");
  assert.deepEqual(
    info.deleted.map((d) => d.file_id).sort(),
    ["F1", "F2"],
  );
  assert.equal(info.deleted.find((d) => d.file_id === "F1")?.remote_path, "p/F1.md");
});
```

- [ ] **Step 2: Run** `node --import tsx --test test/sync-remote-api.test.ts` — expect FAIL (`info.deleted` undefined).

- [ ] **Step 3: Implement.**

In `engine-mutations.ts` `deleteFile`, the final `sync_delete` audit insert already has `nodeId` in scope — extend the detail JSON:

```ts
JSON.stringify({
  mode,
  node_id: nodeId,
  remote_name: remoteName,
  remote_path: remotePath,
  local_path: localPath,
  filename,
}),
```

In `file-content-remote.ts` `deleteFileRemote`, the success audit call gains `node_id: a.nodeId`:

```ts
await auditFile(db, a.userId, "sync_delete_remote", a.fileId, {
  node_id: a.nodeId,
  remote_name: remoteName,
  remote_path: remotePath,
  filename,
}, now);
```

(Leave both `*_repair_needed` writes untouched — they must never match the tombstone query.)

In `sync-remote-api.ts`:

```ts
export interface DeletedTombstone {
  file_id: string;
  remote_path: string;
}

export interface NodeSyncInfo {
  node: { … };            // unchanged
  remote_name: string | null;
  files: SyncInfoFile[];
  // Recent deliberate deletions on this node. Devices match untracked disk
  // files against these during discovery (deleted_remote classification).
  // Only exact actions sync_delete / sync_delete_remote qualify —
  // *_repair_needed rows mean the remote copy still exists.
  deleted: DeletedTombstone[];
}
```

and in `getNodeSyncInfo`, after the files query:

```ts
const tombRes = await db.execute({
  sql: `SELECT target_id, json_extract(detail, '$.remote_path') AS remote_path
        FROM audit_log
        WHERE target_type = 'file'
          AND action IN ('sync_delete', 'sync_delete_remote')
          AND json_extract(detail, '$.node_id') = ?
        ORDER BY timestamp DESC LIMIT 200`,
  args: [nodeId],
});
…
return {
  …,
  deleted: tombRes.rows
    .filter((r) => r.remote_path != null)
    .map((r) => ({ file_id: r.target_id as string, remote_path: r.remote_path as string })),
};
```

Note: tombstones written before this change carry no `node_id` in detail and simply never match — acceptable, the mechanism works going forward.

- [ ] **Step 4: Run** the test — PASS. Also `npm run build` and `node --import tsx --test test/engine-central.test.ts test/central-client.test.ts test/file-content-remote.test.ts` (NodeSyncInfo shape consumers).
- [ ] **Step 5: Commit** `feat(sync): expose per-node delete tombstones in sync-info`

---

### Task 2: Tombstone matching in discovery → `deleted_remote` class

**Files:**
- Modify: `apps/server/domain/sync/engine.ts` (`StatusResult.deleted_remote`, matching in `runDiscovery`)
- Modify: `apps/server/domain/sync/central/engine-central.ts` (same matching in `statusScanCentral` via `ctx.si.deleted`)
- Modify: `apps/web/src/types.ts` (SyncClass/status types) + `apps/web/src/components/DetailPane.files.tsx` (badge label „Smazáno jinde“)
- Test: `test/sync-status.test.ts` or the existing statusScan test file; `test/engine-central.test.ts`

**Interfaces:**
- Produces: `interface DeletedRemoteEntry { file_id: string; node_id: string; local_path: string; remote_path: string; hash: string }`; `StatusResult.deleted_remote: DeletedRemoteEntry[]` (exported from `engine.ts`). Task 3 consumes it in sync runs.
- Match rule (all three required): derived `remote_path` of the untracked file equals tombstone `remote_path`; `getFileState(tombstone.file_id)` exists on this device; its `last_synced_hash` equals the untracked entry's current disk `hash`.

- [ ] **Step 1: Failing test (local engine).** Arrange a registered+pushed file, delete its `files` row and write a `sync_delete` tombstone (as another device would observe), keep the disk copy and its `file_state` row, run `statusScan` with discovery:

```ts
it("classifies an untracked disk file matching a tombstone as deleted_remote", async () => {
  // file F1 pushed earlier: file_state has last_synced_hash === disk hash
  … setup mirror with wip/a.md, files row, file_state row with last_synced_hash = hashOf("obsah") …
  await db.execute({ sql: "DELETE FROM files WHERE id = 'F1'" });
  … insert audit_log sync_delete tombstone with node_id + remote_path of F1 …
  const r = await statusScan(db, { userId: "U1", nodeId: NODE, includeDiscovery: true });
  assert.equal(r.new_local.length, 0);
  assert.equal(r.deleted_remote.length, 1);
  assert.equal(r.deleted_remote[0].file_id, "F1");
});

it("keeps a file modified after the remote delete as new_local", async () => {
  … same setup, but overwrite wip/a.md with different content before the scan …
  assert.equal(r.deleted_remote.length, 0);
  assert.equal(r.new_local.length, 1);
});
```

- [ ] **Step 2: Run — FAIL** (no `deleted_remote` bucket).

- [ ] **Step 3: Implement.** In `engine.ts`: add the bucket to `StatusResult` (initialize `deleted_remote: []` in `statusScan`). At the end of `runDiscovery`, after `out.new_local` is filled, match per node:

```ts
// Tombstone reconciliation (GH #79): an untracked disk file whose record
// was deliberately deleted elsewhere must not resurrect via adopt/store.
// Triple match — derived remote path, a file_state row for the tombstoned
// id on THIS device, and last_synced_hash equal to the current disk hash —
// makes the cleanup lossless: any post-delete edit fails the hash check.
async function tombstonePhase(db: Client, a: StatusArgs, out: StatusResult): Promise<void> {
  if (out.new_local.length === 0) return;
  const nodeIds = [...new Set(out.new_local.map((e) => e.node_id))];
  const tombs = new Map<string, { file_id: string; remote_path: string }[]>();
  for (const nodeId of nodeIds) {
    const res = await db.execute({
      sql: `SELECT target_id, json_extract(detail, '$.remote_path') AS remote_path
            FROM audit_log
            WHERE target_type = 'file'
              AND action IN ('sync_delete', 'sync_delete_remote')
              AND json_extract(detail, '$.node_id') = ?
            ORDER BY timestamp DESC LIMIT 200`,
      args: [nodeId],
    });
    tombs.set(nodeId, res.rows
      .filter((r) => r.remote_path != null)
      .map((r) => ({ file_id: r.target_id as string, remote_path: r.remote_path as string })));
  }
  const remaining: NewLocalEntry[] = [];
  for (const e of out.new_local) {
    let info: NodeInfo | null = null;
    try { info = await resolveNodeInfo(db, e.node_id); } catch { /* keep as new_local */ }
    const remotePath = info
      ? buildRemotePath({ ...info, section: e.section, subpath: e.subpath, filename: e.filename })
      : null;
    const t = remotePath
      ? tombs.get(e.node_id)?.find((x) => x.remote_path === remotePath)
      : undefined;
    const st = t ? await getFileState(t.file_id) : null;
    if (t && st && st.last_synced_hash !== null && st.last_synced_hash === e.hash) {
      out.deleted_remote.push({
        file_id: t.file_id, node_id: e.node_id,
        local_path: e.local_path, remote_path: t.remote_path, hash: e.hash,
      });
    } else {
      remaining.push(e);
    }
  }
  out.new_local = remaining;
}
```

Call it from `statusScan` right after `runDiscovery` (replacing the `moveDetectionPhase` call site — the phase itself is removed in Task 5; until then leave the call order `runDiscovery → tombstonePhase → moveDetectionPhase`).

In `engine-central.ts` `statusScanCentral`: same algorithm, but the tombstone list comes from `ctx.si.deleted` (no audit query — Task 1 put it in sync-info) and the derived remote path via the existing `buildRemotePathOrThrow`/context helpers used by `untrackedForContext`. Add the bucket to the result it assembles.

Web: extend the status types union with `deleted_remote`, badge text „Smazáno jinde“ (mapped where `new_local`/`deleted_local` badges are defined in `DetailPane.files.tsx`), no interaction yet (cleanup is Task 3).

- [ ] **Step 4: Run** engine + engine-central + web build — PASS.
- [ ] **Step 5: Commit** `feat(sync): classify tombstoned untracked files as deleted_remote`

---

### Task 3: Sync run applies the deleted_remote cleanup

**Files:**
- Modify: `apps/server/domain/sync/engine.ts` (`syncRun`), `central/engine-central.ts` (`syncRunCentral`)
- Modify: `apps/web/src/types.ts` (`SyncRunResponse`)
- Test: extend the same test files as Task 2

**Interfaces:**
- Consumes: `StatusResult.deleted_remote` (Task 2).
- Produces: `SyncRunResponse.deleted_remote: Array<{ file_id: string; local_path: string }>` — list of local copies removed because their record was deleted elsewhere.

- [ ] **Step 1: Failing test:** after the Task 2 arrangement, run the sync run and assert the disk copy and the `file_state` row are gone:

```ts
it("sync run removes the local copy and file_state for deleted_remote", async () => {
  … tombstone arrangement from Task 2 …
  const r = await syncRun(db, { userId: "U1", nodeId: NODE });
  assert.equal(r.deleted_remote.length, 1);
  await assert.rejects(() => fsStat(localPath));            // file gone
  assert.equal(await getFileState("F1"), null);              // state gone
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** in both sync runs (scan already includes discovery):

```ts
for (const e of scan.deleted_remote) {
  try {
    await rm(e.local_path, { force: true });
    await deleteFileState(e.file_id);
    result.deleted_remote.push({ file_id: e.file_id, local_path: e.local_path });
  } catch (err) {
    result.errors.push({ file_id: e.file_id, filename: e.local_path, error: (err as Error).message });
  }
}
```

Initialize `deleted_remote: []` in both `SyncRunResponse` literals and add the field to the shared response type (find it via `interface SyncRunResponse`). Mirror the field in `apps/web/src/types.ts`.

- [ ] **Step 4: Run tests + `npm run build` + web build — PASS.**
- [ ] **Step 5: Commit** `feat(sync): sync run cleans up local copies of remotely deleted files`

---

### Task 4: Agent front door — local disk step after proxied mutations (GH #78)

**Files:**
- Modify: `apps/server/mcp/agent-tools.ts` (new export `applyLocalAfterProxiedMutation`)
- Modify: `apps/server/mcp/agent-transport.ts` (intercept the three tools)
- Test: `test/agent-transport.test.ts` (has fake-upstream harness), `test/agent-tools.test.ts`

**Interfaces:**
- Consumes: `CentralClient.syncInfo(nodeId)` / `invalidateSyncInfo`, `getMirrorPath`, `deriveLocalPath`, `buildNodeRoot`, `deleteFileState`, `listUserMirrors`, existing `findEntryByFileId` (agent-tools.ts, currently private — export it).
- Produces: `applyLocalAfterProxiedMutation(client, userId, toolName, args, resultJson): Promise<void>` — no return; best-effort, logs failures with `[portuni:agent]` prefix, never throws.

- [ ] **Step 1: Failing test.** In the agent-transport harness (fake upstream that returns a canned success for `portuni_delete_file`), place a real file in a temp mirror registered in the local sync.db, then call the tool through the front door with `confirmed: true`:

```ts
it("applies the local rm after a proxied confirmed delete", async () => {
  … register temp mirror for N1, create wip/a.md, upsert file_state for F1,
    fake central sync-info listing F1 with remote_path of wip/a.md …
  const res = await callToolThroughFrontDoor("portuni_delete_file", { file_id: "F1", confirmed: true });
  assert.equal(res.isError, undefined);
  await assert.rejects(() => fsStat(join(mirror, "wip/a.md")));
  assert.equal(await getFileState("F1"), null);
});

it("does nothing when the proxied call was a preview (confirmed missing) or an error", …);
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**

In `agent-tools.ts`:

```ts
const PROXIED_DISK_MUTATIONS = new Set([
  "portuni_delete_file",
  "portuni_move_file",
  "portuni_rename_folder",
]);
export function isProxiedDiskMutation(name: string): boolean {
  return PROXIED_DISK_MUTATIONS.has(name);
}

// GH #78: these tools proxy to central, whose deleteFile/moveFile local
// disk step no-ops (no mirror on the server). Snapshot the affected
// record(s) BEFORE the proxy, and after a successful confirmed result
// apply the same disk step here, on the device that owns the mirror.
// Best-effort by design: the record mutation already succeeded on
// central; a failed local step degrades to the tombstone path (GH #79).
export async function snapshotForDiskMutation(
  client: CentralClient, userId: string, name: string, args: Record<string, unknown>,
): Promise<DiskMutationSnapshot | null> { … }

export async function applyLocalAfterProxiedMutation(
  client: CentralClient, userId: string,
  snapshot: DiskMutationSnapshot, resultText: string,
): Promise<void> { … }
```

Behavior per tool (all gated on `args.confirmed === true` and a non-error, non-preview result — parse `resultText` JSON and require `status: "ok"`/`deleted_at`/`moved_at`):

- `portuni_delete_file`: snapshot = `findEntryByFileId(client, userId, fileId)` → derive local path (`deriveLocalPath({mirrorRoot, nodeRoot: buildNodeRoot(info), remotePath})` with info from `syncInfo.node`); after success `rm(localPath, {force:true})` + `deleteFileState(fileId)`.
- `portuni_move_file`: snapshot old entry the same way; after success parse `new_remote_path`/`new_local_path` from the result, `mkdir(dirname(newLocal))` + `fsRename(oldLocal, newLocal)` (ENOENT → skip silently: no local copy), then `localHashFor(newLocal, fileId, null)`; `client.invalidateSyncInfo` for both nodes.
- `portuni_rename_folder`: result carries the renamed files list (`old_remote_path`/`new_remote_path` pairs — see `renameFolder` in engine-mutations); apply `fsRename` per pair, same ENOENT rule.

In `agent-transport.ts` CallTool handler, before the final verbatim proxy:

```ts
if (isProxiedDiskMutation(name)) {
  const snapshot = await snapshotForDiskMutation(opts.client, identity.userId, name, args)
    .catch(() => null);
  const result = await upstream.callTool({ name, arguments: args });
  const text = firstTextContent(result);       // helper already used in file
  if (snapshot && !result.isError && text) {
    await applyLocalAfterProxiedMutation(opts.client, identity.userId, snapshot, text)
      .catch((e) => console.error("[portuni:agent] local mutation step failed:", e));
  }
  return result;
}
```

- [ ] **Step 4: Run agent tests — PASS.**
- [ ] **Step 5: Commit** `fix(sync): apply the local disk step after proxied delete/move/rename in agent mode`

---

### Task 5: file_state inode columns + watcher move detection (local mode)

**Files:**
- Modify: `apps/server/domain/sync/local-db.ts` (columns + additive migration + `findFileStateByInode`)
- Modify: `apps/server/domain/sync/types.ts` or wherever `FileStateRow` lives (extend)
- Modify: `apps/server/domain/sync/engine.ts` (`localHashFor` stamps ino/dev)
- Modify: `apps/server/domain/sync/reconcile.ts` (move detection before register)
- Delete: `moveDetectionPhase` in `engine.ts` (keep the `moved` field in `StatusResult` — API/UI compatibility — but it stays empty; drop its tests or rewrite them as watcher-active tests, see Step 1)
- Test: `test/sync-move-watcher.test.ts` (new), update `test/sync-rename.test.ts` etc. that asserted `moved` from the dead phase

**Interfaces:**
- Produces: `file_state.cached_ino INTEGER`, `cached_dev INTEGER`; `findFileStateByInode(ino: number, dev: number): Promise<FileStateRow[]>`; `FileStateRow` gains `cached_ino: number | null; cached_dev: number | null`. Task 6 (central) reuses all of it.
- Detection rule (local): in `reconcilePath`, when the path has no `files` row and the disk file exists — `stat` it; if a `file_state` row matches `(ino, dev)`, its `files` row still exists, its derived local path differs from `absPath` and no longer exists on disk, AND the disk hash equals that row's `cached_local_hash` (inode-reuse guard) → call `moveFile(db, {userId, fileId, newNodeId: a.nodeId, newSection, newSubpath, confirmed: true})` instead of `registerLocalFile`. `newSection`/`newSubpath` come from `subpathFromMirror(mirrorRoot, absPath)` (already computed). Cross-volume `mv` changes the inode → falls through to today's register path by construction.

- [ ] **Step 1: Failing test — WITH ACTIVE WATCHER.** Build the harness with `createMirrorWatcher({userId, db, watchFactory: manual, backfill: false, debounceMs: 0})` where `manual` records the `onPath` callbacks so the test fires events itself (deterministic, no OS timing). Register a mirror + a pushed file `wip/a.md`, then simulate `mv wip/a.md wip/sub/b.md` (fs rename + fire events for BOTH paths, old then new):

```ts
it("watcher-observed mv keeps ONE files row and calls the real move", async () => {
  … setup, push file (fake adapter records rename calls) …
  await rename(oldAbs, newAbs);
  fireWatch(oldAbs); fireWatch(newAbs);
  await settle();                        // drain debounce/reconciles
  const rows = await db.execute("SELECT id, remote_path FROM files WHERE node_id = ?", [NODE]);
  assert.equal(rows.rows.length, 1);     // no duplicate row
  assert.match(rows.rows[0].remote_path as string, /sub\/b\.md$/);
  assert.deepEqual(adapter.renames, [[oldRemotePath, newRemotePath]]);  // real remote rename, same file id
});

it("an identical-content copy (different inode) registers as a new file, not a move", …);
it("cross-volume-style mv (inode changed) falls back to register + deleted_local", …);
```

- [ ] **Step 2: Run — FAIL** (two rows, no rename).
- [ ] **Step 3: Implement.**

`local-db.ts` — schema + additive migration (mirrors the existing `migrateFileStateNullableBaseline` pattern):

```ts
async function migrateFileStateInode(db: Client): Promise<void> {
  const info = await db.execute("PRAGMA table_info(file_state)");
  if (info.rows.some((r) => r.name === "cached_ino")) return;
  await db.execute("ALTER TABLE file_state ADD COLUMN cached_ino INTEGER");
  await db.execute("ALTER TABLE file_state ADD COLUMN cached_dev INTEGER");
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_file_state_inode ON file_state(cached_ino, cached_dev)",
  );
}
```

`upsertFileState` passes the two new optional fields through; `localHashFor` (engine.ts) already stats the file for mtime/size — extend that stat to also store `st.ino`/`st.dev`. `findFileStateByInode` is a straight indexed SELECT returning all matches (hash check disambiguates).

`reconcile.ts` — in the `if (!fileId)` branch, before `registerLocalFile`:

```ts
// mv detection (GH umbrella): rename(2) keeps the inode on the same
// volume, and the watcher registers the new path before the move phase
// could ever see it — so the pairing happens HERE, at registration time.
// Hash equality guards against inode reuse after a delete.
const st = await fsStat(a.absPath);
const candidates = await findFileStateByInode(st.ino, st.dev);
for (const c of candidates) {
  const moved = await tryApplyDiskMove(db, a, c, sub);   // returns false when any condition fails
  if (moved) return { action: "moved", file_id: c.file_id };
}
```

(Add `"moved"` to `ReconcileAction`.) `tryApplyDiskMove` performs the checks from the Interfaces block, then calls `moveFile(…, confirmed: true)`; because the disk file is already at the new path, `moveFile`'s local `fsRename` gets ENOENT on the old path and reports `localDone=false` — that is correct, the record + remote move is what we need; afterwards refresh the cache with `localHashFor(a.absPath, c.file_id, null)`.

Remove `moveDetectionPhase` and its call; keep `moved: []` initialization in `statusScan`.

- [ ] **Step 4: Run** the new watcher tests + the full sync-layer suite; fix any test that asserted the dead phase populated `moved` — those move under the watcher-active harness now.
- [ ] **Step 5: Commit** `fix(sync): detect on-disk moves by inode in the watcher instead of the dead move phase`

---

### Task 6: Central mode — move endpoint + watcher move detection

**Files:**
- Modify: `apps/server/api/files.ts` (new `POST /nodes/:nodeId/files/:fileId/move`)
- Modify: `apps/server/domain/sync/central/client.ts` (`moveFileRecord` method)
- Modify: `apps/server/domain/sync/central/engine-central.ts` (`reconcilePathCentral` move detection)
- Test: `test/file-content-rest.test.ts` (endpoint), `test/engine-central.test.ts` (reconcile move)

**Interfaces:**
- Consumes: Task 5's `findFileStateByInode` + inode columns (device-local, mode-independent).
- Produces: REST `POST /nodes/:nodeId/files/:fileId/move` body `{new_section?: string, new_subpath?: string | null, confirmed: boolean}` → `moveFile` result passthrough (on central `getMirrorPath` is null, so its local step no-ops by design); `CentralClient.moveFileRecord(nodeId, fileId, body)` wrapping it.

- [ ] **Step 1: Failing tests** — endpoint test mirroring the existing rename endpoint test (visibility check, preview vs confirmed); reconcile test mirroring Task 5's watcher test but against the central engine harness (`engine-central.test.ts` already fakes a central client — extend the fake with `moveFileRecord` and assert it was called once and no `registerFile` happened).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Endpoint: copy the shape of the rename handler (`api/files.ts:380-412`), calling `moveFile(db, {userId, fileId, newSection, newSubpath, confirmed})`. Client method: `POST` via `request`, `invalidate(nodeId)`. `reconcilePathCentral` — in the `if (!rec)` branch, same detection as Task 5: `fsStat` → `findFileStateByInode` → candidate must appear in `ctx.si.files` (record still exists centrally) with a derived local path that differs and is gone from disk, disk hash equals `cached_local_hash` → `client.moveFileRecord(...)` + `localHashFor` refresh, return `{action: "moved"}`.
- [ ] **Step 4: Run — PASS.** `npm run build`.
- [ ] **Step 5: Commit** `feat(sync): propagate on-disk moves in central mode via a move endpoint`

---

### Task 7: Unify the never-pushed local deletion (orphan vs deleted_local)

**Files:**
- Modify: `apps/server/domain/sync/reconcile.ts` (deletion branch), `central/engine-central.ts` (`reconcilePathCentral` deleted branch)
- Modify: `apps/server/domain/sync/central/client.ts` (`deleteFileRecord` — DELETE passthrough, needed for the central branch)
- Test: extend `test/reconcile.test.ts` (or the file holding reconcilePath tests) + `test/engine-central.test.ts`

**Interfaces:**
- Rule: when the watcher observes a deletion of a file that was **never pushed** (`files.current_remote_hash` IS NULL and `file_state.last_synced_hash` IS NULL), the record is metadata-only — remove the `files` row and the `file_state` row (one user action → one outcome: the file is gone from Portuni). A **pushed** file keeps today's behavior (`deleted_local`, remote copy intentionally preserved — see `DetailPane.files.tsx:734-736`).
- Produces: `CentralClient.deleteFileRecord(nodeId, fileId)` → `DELETE /nodes/:nodeId/files/:fileId?confirmed=true` (existing endpoint; on central the mirror-less branch runs `deleteFileRemote`, which for a never-pushed record only drops the DB row).

- [ ] **Step 1: Failing tests:**

```ts
it("deleting a never-pushed file on disk unregisters it entirely", async () => {
  … register wip/a.md (no push), rm it, reconcilePath …
  assert.equal(r.action, "unregistered");
  assert.equal((await db.execute("SELECT id FROM files WHERE id = ?", [fid])).rows.length, 0);
  assert.equal(await getFileState(fid), null);
});
it("deleting a pushed file on disk keeps the record (deleted_local)", … existing behavior assert …);
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** in `reconcilePath`'s deletion branch: read `current_remote_hash` (already selected) + `file_state`; never-pushed → `DELETE FROM files WHERE id = ?` + `deleteFileState(fileId)` + return `{action: "unregistered", file_id}` (extend `ReconcileAction`); else today's cache-clear. Central: same predicate from `rec.current_remote_hash` + local state, action via `client.deleteFileRecord(nodeId, rec.id)` then `deleteFileState`. Write an `audit_log` row only via the existing deleteFile paths — the REST call on central already audits (`sync_delete_remote`), local mode adds a `sync_unregister` audit insert with `{node_id, remote_path, filename}` for traceability.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `fix(sync): deleting a never-pushed file unregisters it instead of leaving an orphan`

---

### Task 8: Docs + release notes

**Files:**
- Modify: `sites/docs/src/content/docs/reference/files.md` (sync classes: `deleted_remote`, unregister-on-delete rule, move detection)
- Modify: `sites/docs/src/content/docs/concepts/` sync page if it describes deletion/move behavior (grep `deleted_local`, `new_local`, `moved`)
- Create: `docs/architecture/file-mutation-propagation.md` — one page stating the three origins → three mechanisms model (content: condensed version of this plan's Architecture + the match rules; link GH #78/#79)
- Test: `npm --prefix sites/docs run build`

- [ ] **Step 1:** Grep `sites/docs/src` for `new_local`, `deleted_local`, `moved`, `smazán` and update every statement invalidated by Tasks 1–7. Document: tombstone triple-match rule, `deleted_remote` class + sync-run cleanup, inode move detection (and its cross-volume fallback), never-pushed unregister rule, agent front door disk step.
- [ ] **Step 2:** `npm --prefix sites/docs run build` — PASS.
- [ ] **Step 3: Commit** `docs(site): document delete/move/rename propagation semantics`

---

## Self-review notes

- Spec coverage vs Asana 1216567233659408: front door (Task 4), tombstones — two audit actions, repair_needed excluded, exact match (Tasks 1–3), inode detection with hash guard + cross-volume fallback + moveDetectionPhase removal (Task 5, central Task 6), deleted_local/orphan unification (Task 7), watcher-active regression tests (Tasks 5–6 harness), docs (Task 8). Remote copy intentionally NOT deleted on local rm — unchanged, asserted in Task 7 test 2.
- GH #80 (client timeout) is already fixed on main and is a prerequisite for the front-door snapshot calls being reliable.
- Types consistency: `DeletedTombstone` (T1) → consumed T2; `DeletedRemoteEntry`/`StatusResult.deleted_remote` (T2) → consumed T3; `findFileStateByInode` + inode columns (T5) → consumed T6; `deleteFileRecord`/`moveFileRecord` client methods introduced where first used (T7/T6).
