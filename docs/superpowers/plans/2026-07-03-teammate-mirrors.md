# Teammate Mirrors (agent-mode sidecar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline).
> Executed same-session by the author; checkboxes track progress.

**Goal:** A central-mode teammate gets local mirror folders with watcher + sync,
without holding a Turso token or Drive SA key — the sidecar runs as a "sync
agent" whose graph-plane and byte-plane calls go through the central server.

**Architecture:** The desktop spawns the SAME sidecar in central mode with
`PORTUNI_AGENT_MODE=1` + `PORTUNI_CENTRAL_URL` + `PORTUNI_CENTRAL_TOKEN`
(device token). The sidecar serves only the local-only routes (mirror,
sync-status, sync, sync/pending, scope, sandbox-profile) backed by a new
central engine that keeps all disk/watcher/sync.db logic local but reaches
the graph plane via two new REST endpoints (`GET /nodes/:id/sync-info`,
`POST /nodes/:id/files/register`) and moves bytes via the existing
`GET/PUT /nodes/:id/file` (extended with base64 for binary). The Rust proxy
forwards local-only paths to the local agent instead of returning 501.

**Tech stack:** Node/TS (apps/server), Rust/Tauri (apps/desktop), React
(apps/web), vitest.

## Global constraints

- Local mode (owner) must be byte-for-byte unaffected: all changes are
  additive or gated on `PORTUNI_AGENT_MODE` / `data_mode === "central"`.
- Teammate device never sees TURSO_* or Drive SA credentials.
- Agent REST responses reuse the existing shapes (`SyncStatusResponse`,
  `SyncRunResponse`, `CreateMirrorResult`) so the webview needs no data
  changes.
- Server-side node visibility (`nodeVisibleTo`) guards every new endpoint.
- No emoji in code. Komentáře v angličtině (repo konvence).

## Ground-truth notes (from code inventory, 2026-07-03)

- Mirror registry lives in LOCAL per-device sync.db (`local_mirrors`) —
  mirror registration needs no Turso.
- Canonical graph-plane surface the agent needs: resolveNodeInfo (nodes +
  belongs_to org), resolveRemote (remote_routing), files rows per node
  (id, filename, status, remote_path, current_remote_hash,
  is_native_format, mime_type), file-record upsert w/ NULL hash (register),
  audit. Bytes: adapter get/put — already proxied by `/nodes/:id/file`
  (file-content-remote.ts B1–B3; PUT refreshes canonical hash + audit).
- `mirror-watcher.ts` already has injectable seams (`listMirrors`,
  `reconcile`, `backfill` via deps) — agent injects central variants.
- `localHashFor`, `local-db.ts`, `remote-path.ts`, `mirror-ignore.ts`,
  `mirror-registry.ts` are db-free or local-only → reused as-is.
- `resolvePortuniMcpUrl()` honours `PORTUNI_URL` → agent sidecar gets
  `PORTUNI_URL=<server_url>` so materialized `.mcp.json` points at central.
  **Superseded** by `docs/superpowers/plans/2026-07-05-agent-mode-mcp-front-door.md`:
  in agent mode `.mcp.json` now points at the local sidecar's own `/mcp`
  front door instead, which proxies graph/scope tools to central and runs
  the device-local tools on-device.
- Rust: spawn skip at `lib.rs:985`; `is_local_only_path` at `lib.rs:424`;
  `ensure_device_token` at `pty.rs:37` (Keychain `portuni_device_token`).
- GET/PUT `/nodes/:id/file` are text-only today (utf8 + NUL check) — sync
  needs a base64/raw variant for binary files.
- Classification matrix (scanRow): compares local_hash / remote_hash /
  last_synced_hash; fast mode uses files.current_remote_hash as remote
  truth — the agent ALWAYS uses record hashes (hash-is-identity, Turso is
  canonical). Slow-mode adapter.stat and new_remote discovery are
  owner-only features; agent v1 skips them (documented).
- Push safety: agent pushes via PUT with baseVersion = sha256 of current
  remote bytes obtained by a fresh GET; guard compares remote bytes hash
  to last_synced (algo by hash length) — mirrors storeFile/pull guards.

### Task 1: Server — sync-info + register endpoints + base64 file content ✅

**Files:**
- Create: `apps/server/domain/sync/sync-remote-api.ts`
- Modify: `apps/server/domain/sync/file-content-remote.ts` (raw read/write)
- Modify: `apps/server/api/files.ts` (+2 handlers, base64 params)
- Modify: `apps/server/api/router.ts` (routes)
- Check: `apps/server/auth/min-scopes.ts` (GET sync-info=read, POST register=write)
- Test: `test/sync-remote-api.test.ts`

**Interfaces (produced):**
- `GET /nodes/:id/sync-info` → `{ node: { id, type, sync_key, org_sync_key },
  remote_name: string | null, files: Array<{ id, filename, status,
  remote_path, current_remote_hash, is_native_format, mime_type }> }`
- `POST /nodes/:id/files/register` body `{ relPath }` →
  `{ id, filename, remote_name, remote_path }` (files row upserted with
  NULL current_remote_hash — same semantics as registerLocalFile's upsert)
- `GET /nodes/:id/file?path=..&encoding=base64` → content_base64 + version
  (skips text-editability checks; native formats still NOT_EDITABLE)
- `PUT /nodes/:id/file` body `{ content_base64, baseVersion?, force? }`

Steps: write failing tests (in-memory db seeded with org+node+edge+fs
remote+routing) → implement → pass → commit.

### Task 2: Agent central client ✅

**Files:**
- Create: `apps/server/domain/sync/central/client.ts`
- Test: `test/central-client.test.ts`

**Interface (produced):**
```ts
export interface CentralClient {
  syncInfo(nodeId): Promise<SyncInfo>;            // GET /nodes/:id/sync-info
  registerFile(nodeId, relPath): Promise<RegisteredFile>;
  getFileRaw(nodeId, relPath): Promise<{ bytes: Buffer; version: string }>;
  putFileRaw(nodeId, relPath, bytes, opts?): Promise<{ version: string }>;
  dataSources(nodeId): Promise<DataSourceRow[]>;  // GET /data-sources?node_id
  nodeExists(nodeId): Promise<boolean>;           // GET /nodes/:id -> 200/404
}
export function createHttpCentralClient(args: { baseUrl; token; fetchImpl? }): CentralClient;
```
Errors: map 404→NotFoundError, 409 CONFLICT→carry currentVersion, else throw.

### Task 3: Agent engine ✅

**Files:**
- Create: `apps/server/domain/sync/central/engine-central.ts`
- Test: `test/engine-central.test.ts` (fake CentralClient + tmp dirs)

**Interface (produced; mirrors local shapes):**
```ts
statusScanCentral(client, { userId, nodeId }): Promise<StatusResult>   // fast-mode semantics
listUntrackedLocalCentral(client, { userId, nodeId }): Promise<UntrackedLocalEntry[]>
registerLocalFileCentral(client, { userId, nodeId, localPath }): Promise<RegisterLocalFileResult>
pushFileCentral(client, { userId, nodeId, entry }): Promise<void>      // GET-guard + PUT raw
pullFileCentral(client, { userId, nodeId, entry, force? }): Promise<void> // dirty-local guard
syncRunCentral(client, { userId, nodeId }): Promise<SyncRunResponse>
computeSyncPendingCentral(client, userId): Promise<SyncPendingResponse-shape>
reconcilePathCentral(client, { userId, nodeId, absPath }): Promise<ReconcileResult>
createMirrorForNodeCentral(client, userId, { nodeId, customPath? }): Promise<CreateMirrorResult>
```
Reuses: localHashFor, upsert/getFileState, mirror-registry, remote-path
helpers, mirror-ignore, discover walk (central variant feeds `known` set
from sync-info records). Classification = same documented matrix
(fast-mode: remote truth = current_remote_hash). v1 skips: new_remote
discovery, move detection, remote scaffold (folders created by adapter.put
path on server).

### Task 4: Agent boot + router ✅

**Files:**
- Create: `apps/server/api/agent-router.ts`
- Modify: `apps/server/http/server.ts` (optional `router` override)
- Modify: `apps/server/index.ts` (agent branch: no ensureSchema, agent router, watcher wiring)
- Modify: `apps/server/domain/scope-materialize.ts` (dataSources resolver param for boot regen) — if needed
- Test: `test/agent-router.test.ts` (spin server with agent router + fake client)

Routes served by agent: `/health`, `GET /nodes/:id/sync-status`,
`POST /nodes/:id/sync`, `POST /nodes/:id/mirror`, `GET /sync/pending`,
`GET /scope`, `GET /sandbox-profile`, `GET /nodes/:id/sandbox-profile`.
Same response shapes as api/nodes.ts + write-scope.ts. Identity: local
env-token gate (SOLO_USER locally; central enforces real identity).
Everything else → 501 `{error:"agent_mode"}`.
Watcher: `createMirrorWatcher` with injected central reconcile + backfill.

### Task 5: Rust desktop ✅

**Files:**
- Modify: `apps/desktop/src/lib.rs` (spawn in central mode + env; api_request local-only → local agent; unit tests)
- Modify: `apps/desktop/src/pty.rs` (share ensure_device_token)
- Modify: `apps/desktop/src/auth.rs` (spawn agent after google_login)

Behavior: central mode + logged in → spawn agent sidecar with
`PORTUNI_AGENT_MODE=1`, `PORTUNI_CENTRAL_URL`, `PORTUNI_CENTRAL_TOKEN`
(ensure_device_token), `PORTUNI_URL=<server_url>`, workspace/data-dir/port/
auth-token as local, NO TURSO_*. Not logged in → skip; google_login success
→ spawn. `api_request` central branch: local-only path + running agent →
forward to `127.0.0.1:{port}` with local token; agent not running → 501.

### Task 6: Webview ✅

**Files:**
- Modify: components gating mirror/sync UI on central mode (grep
  `useDataMode`/`local_only`); enable mirror creation, sync panel, footer
  pending indicator in central mode.

### Task 7: QA + build + local E2E ✅

- `npm run qa` (typecheck, lint, tests)
- Integration script (scratchpad): run real server (main dist) on a scratch
  port with file: DB seeded (org+node+fs remote+routing) as fake central;
  run agent sidecar against it with tmp workspace; verify: mirror create →
  watcher registers dropped file → sync pushes to fs remote → remote edit
  → status pull → sync pulls. Proves the loop without prod deploy.
- `npm run build:sidecar`, `cargo tauri build`; install .app only if the
  running instance is closed.

### Task 8: Docs + handoff ✅

- Update runbook (teammate mirrors section), this plan's checkboxes,
  data-modes.md phase-B note. Commit per task.
- NOT deploying to VPS (explicitly out of scope per user 2026-07-03) — the
  feature needs the new server endpoints deployed before it works against
  api.portuni.com; deploy is a one-command step for the user.
