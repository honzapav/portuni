# Client traffic, steps 3–5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shared data is fetched once per window, presentation changes fetch nothing, a mutation writes its answer into state instead of reloading the graph, the remaining per-item round trips become batch routes, and node and file changes reach the window over the live channel so the detail polls go.

**Architecture:** One window-level resource cache (`lib/resource.ts`: in-flight dedupe, failure not cached, explicit invalidation, `useResource`) serves identity, actors, users, runners and per-node detail data; `WorkspaceView` stays mounted once visited so chats keep their transcripts; `onMutate` is replaced by `onNodeChanged` carrying either the returned node or a node id, and `refetchAll` stays for permission and subtree changes only. A `ChangeFeed` on the server (domain-level publish with node id) is read by the device over a long-poll `GET /changes` and delivered to the window as `node_changed` / `files_changed` frames on the existing sessions WebSocket; the device watcher publishes `files_changed` itself. Polls become 60 s fallbacks.

**Tech Stack:** React 19, TypeScript, `node:test`, Node HTTP server, Rust route table (JSON), libsql + PGlite dialects.

**Spec:** `docs/superpowers/specs/2026-11-05-client-traffic-contract.md`

## Global Constraints

- Everything works in a team workspace (central server + sidecar) and a personal workspace (one local server); a half missing is an open issue named in the PR title.
- A device-local route: `device-local-routes.json` + handler (`agent-router.ts` or front door) + local `router.ts` + `min-scopes.ts`; `test/agent-router-route-parity.test.ts` holds both sides. A session verb: also `sessions-ws.ts` (not needed for a read).
- No UI text in code; selectors through `cached()`; pure helpers tested from `test/*.test.ts`; Conventional Commits; gate `scripts/agent-gate.sh` before the PR update.
- No fixed sleeps in tests; inject clocks and fetchers.

## Review Focus

1. A resource invalidated while a fetch is in flight: the stale answer must not overwrite the invalidation (Task 1 pins: invalidate during flight → next `get` fetches again).
2. `WorkspaceView` mounted but hidden: Esc must not stop a turn, the picker must not steal focus, the sync-status poll must not run (Task 3).
3. `onNodeChanged` with a node from PATCH while the graph view shows another node: the graph node row (name, status, lifecycle, health) is patched, nothing else refetched (Task 4).
4. The change long-poll when central restarts: the cursor is unknown, the server answers `reset: true`, the device refetches what it shows once and resumes (Task 7).
5. A personal workspace has no sidecar poller: the local server's `ChangeFeed` publishes straight into its own sessions WebSocket (Task 7, local branch test).

---

### Task 1: Window-level resource cache

**Files:**
- Create: `apps/web/src/lib/resource.ts`
- Test: `test/web-resource.test.ts`

**Interfaces (Produces):**
- `createResource<T>(load: () => Promise<T>): Resource<T>` with `Resource<T> = { get(): Promise<T>; peek(): T | null; set(value: T): void; invalidate(): void; subscribe(cb: () => void): () => void; resetForTesting(): void }`. `get` returns the cached value, else the in-flight promise, else starts `load`; a rejection is not cached; `invalidate` clears the value and marks any in-flight answer stale (it resolves its callers but is not stored); `set` stores and notifies; `subscribe` fires on `set`, on a stored answer and on `invalidate`.
- `createKeyedResource<K extends string, T>(load: (key: K) => Promise<T>): KeyedResource<K, T>` with `get(key)`, `peek(key)`, `set(key, value)`, `invalidate(key?)` (no key: all), `subscribe(cb)`, `resetForTesting()`.
- `useResource<T>(res: Resource<T>): T | null` and `useKeyedResource<K, T>(res: KeyedResource<K, T>, key: K | null): T | null` in `apps/web/src/lib/use-resource.ts` (React: `useSyncExternalStore` on `subscribe`/`peek`, an effect that calls `get` when `peek` is null).

- [ ] Write the failing tests: two `get` during one flight → one load; a rejection → next `get` loads again; `invalidate` → `peek` null and next `get` loads; `invalidate` during a flight → the flight's answer is not stored, `peek` stays null; `set` notifies subscribers; keyed: separate keys separate flights, `invalidate()` clears all.
- [ ] Run, expect FAIL (module missing). Implement. Run, expect PASS. Commit `feat(web): a window-level resource cache with in-flight dedupe and invalidation`.

### Task 2: Identity, actors, users and runners through the cache

**Files:**
- Modify: `apps/web/src/api.ts` (`MeResponse` → full `meBody`: `id, email, name, global_scope, groups, via, locale`; `patchMeLocale` sets the resource; `createActor`/`updateActor`/`archiveActor` invalidate the actors resource; invite/update of users invalidates the users resources)
- Modify: `apps/web/src/lib/use-me.ts` (`meResource = createResource(fetchMe)`; `useMe()` returns `{ me: MeResponse | null; meId; canManage; globalScope: string | null; scopeKnown: boolean }`; `invalidateMe()`)
- Create: `apps/web/src/lib/resources.ts` (`actorsResource`, `usersResource`, `accountUsersResource`, `runnersResource`, `runnerInstancesResource`, `runnerModels` keyed by `${runner}|${instanceId ?? ""}`, `runnerDefaults` keyed by `${runner}|${instanceId ?? ""}|${model ?? ""}`)
- Modify: `apps/web/src/lib/runners.ts` (mutations invalidate instances, models and defaults)
- Modify: `apps/web/src/App.tsx:198-214` (`useMe()` instead of `fetchMe`), `components/SettingsPage.tsx:70-90`, `components/AccountSection.tsx:70-78, 95-102` (read `useMe()`, no `centralFetch("/me")`; `invalidateMe()` after login/logout), `components/SessionChat.tsx:285-345` (resources; one models fetch), `components/RunnersSection.tsx:58-98` (resources; `orgs` from a new `graph: GraphPayload | null` prop threaded `App → SettingsPage → RunnersSection`), `components/DetailPane.tsx` OwnerPicker (2272-2297) and `useActorRegistry` (3346-3371), `components/ActorsPage.tsx:59-74, 470-482`, `components/DetailPane.access.tsx:921-935`
- Test: `test/web-resources.test.ts` (the keys of `runnerModels`/`runnerDefaults`; `patchMeLocale` result lands in `meResource` — through an injected fetcher), existing tests stay green.

- [ ] Tests first for the pure parts (key builders, invalidation wiring with fake loaders). Implement. `npx tsc -b apps/web`, `npm test`. Commit `fix(web): identity, actors, users and runner lists are fetched once per window`.

### Task 3: Detail data cached by node; chats survive a view switch

**Files:**
- Modify: `apps/web/src/lib/resources.ts` (`folderUrlByNode` keyed resource; `nodeAccessByNode`, `nodeAccessRequestsByNode` keyed; `syncStatusByNode` keeps `SYNC_STATUS_CACHE`'s role with a `fetchedAt` so a mount within 5 s of the last answer does not fetch)
- Modify: `components/DetailPane.tsx` (RemoteFolderActions reads `folderUrlByNode`; `createMirrorAndRefresh` invalidates it; the mount load of sync-status skips when fresh), `components/DetailPane.access.tsx` (AccessSection reads the keyed resources; `putNodeAccess` and approve `set`/invalidate them)
- Modify: `apps/web/src/App.tsx:526-535` (`refetchWorkspaceDetail`: a failure when a detail already exists is silent, like the graph view's poll; the error state unmounting the body on every failed poll is what made a remount storm) and `App.tsx:1177-1207` (`WorkspaceView` mounts on the first visit and stays mounted; hidden with `visibility: hidden`, `inert`, `aria-hidden` when `view !== "workspace"`; prop `active={view === "workspace"}`)
- Modify: `components/WorkspaceView.tsx` (prop `active: boolean`; passes `surfaceActive` to `SessionChat` and `visible` to `DetailPane`; `WorkspaceEmpty` gets `autoFocus={active}`), `components/SessionChat.tsx:609-613` (`escapeStopsTurn(e, turnActive, shown && surfaceActive)`), `components/DetailPane.tsx` (prop `visible?: boolean`, default true; `shouldPollSyncStatus` gets `visible`), `apps/web/src/lib/poll-policy.ts` (`shouldPollSyncStatus({ tab, hidden, rateLimited, visible })`), `components/WorkspaceEmpty.tsx`
- Test: `test/web-poll-policy.test.ts` (`visible: false` → false), `test/session-chat-helpers.test.ts` (escape with surface inactive → false, via the existing `escapeStopsTurn` signature extended with a fourth `surfaceActive = true` parameter), `test/web-resources.test.ts` (sync-status freshness window)
- Docs: `docs/architecture/task-surface-web.md` (Práce stays mounted; detail data by node), `docs/architecture/desktop-shell.md` unchanged.

- [ ] Tests first; implement; typecheck; `npm test`; commit `fix(web): detail data is cached by node and Práce keeps its chats across a view switch`.

### Task 4: Mutations write their answer into state

**Files:**
- Modify: `apps/web/src/lib/graph-patch.ts` (create): `patchGraphNode(graph: GraphPayload, node: NodeDetail): GraphPayload` (same reference when nothing of `name, description, status, lifecycle_state, health, visibility` changed), `graphAffectedBy(kind: NodeChangeKind): boolean` with `NodeChangeKind = "node" | "edges" | "move" | "archive" | "access" | "files" | "events" | "responsibilities" | "attributes" | "sync"`: `true` for `edges | move | archive | access`.
- Modify: `components/DetailPane.tsx`, `DetailPane.events.tsx`, `DetailPane.access.tsx`, `DetailPane.files.tsx` call sites: `onMutate` → `onNodeChanged(change: NodeChange)` with `NodeChange = { kind: NodeChangeKind; nodeId: string; node?: NodeDetail }`; `updateNode`/`moveNode` answers pass `node`.
- Modify: `apps/web/src/App.tsx`: `handleNodeChanged(change)`: with `node` → set the detail (graph or workspace, whichever shows that id) and `patchGraphNode`; without → `fetchNode(nodeId)` into the detail that shows it; `graphAffectedBy(kind)` → `fetchGraph` too; `archive` → `fetchGraph` and clear the selection. `refetchAll` remains for `access`/`move`/`archive` paths only. `components/WorkspaceView.tsx`, graph `DetailPane` props renamed accordingly. `components/SyncOverview.tsx:118-124` `onMutated` → refetch pending + the node detail only (`onNodeChanged({kind:"sync", nodeId})`); `App.tsx:1318-1321` likewise.
- Test: `test/web-graph-patch.test.ts` (patch keeps the reference when equal; changes name; `graphAffectedBy` table).
- Docs: `task-surface-web.md` "What App.tsx still owns" + spec table rows 6 and 12 marked done.

- [ ] Tests first; implement; typecheck; `npm test`; commit `fix(web): a mutation writes its answer into state; the graph reloads only for edges, moves, archives and sharing`.

### Task 5: Batch routes

**Files:**
- Server: `apps/server/api/sessions.ts` (`handlePostSessionsResumeInfo`: body `{ids: string[1..200], config_dir?}` → `{infos: SessionResumeInfo[]}`, unknown or foreign ids omitted), `api/router.ts` (literal `POST /sessions/resume-info` before the `/sessions/:id` regex), `api/agent-router.ts` (same, through `sessionRuntime.getSession` per id — one central GET per id stays until a `GET /sessions?ids=` exists: add `client.listSessionRecordsByIds(ids)` backed by a new central `GET /sessions?ids=a,b,c` (max 200) in `router.ts` + `min-scopes.ts` read), `auth/min-scopes.ts`, `shared/device-local-routes.json`, `apps/desktop/src/lib.rs` test `sessions_resume_info_is_device_local`.
- Server: `POST /nodes/config-batch` `{node_ids}` → `{configs:[{node_id, orientation, data_sources}]}` (read scope; `api/nodes.ts`), `central/client.ts` `nodeConfigs(nodeIds)`, `domain/scope-materialize.ts:397-451` uses it (one request per 100 mirrors).
- Server: `POST /responsibilities/reorder` `{updates:[{id, sort_order}]}` → `{updated}` (write scope; one transaction; `writeAudit` once), web `moveBy` uses it.
- Server: `GET /nodes/:id/file?version_only=1` → `{version}` in `api/files.ts` and `agent-router.ts` (hash of the local file; central fallback keeps the full read), web `lib/use-file-editor.ts` polls the version only.
- Web: `components/DetailPane.sessions.tsx` fetches resume-info for all suspended rows in one call on mount (through `resume-info-cache` `primeResumeInfo(infos)`), rows read the cache.
- Tests: `test/api-sessions.test.ts` (batch: own ids only, cap), `test/agent-router-sessions.test.ts` (batch through the agent router with the fake central), `test/agent-router-route-parity.test.ts` (route listed), `test/api-nodes*.test.ts` (config-batch), responsibilities reorder test, file version-only test, `test/web-resume-info-cache.test.ts` (`primeResumeInfo`).
- Docs: `sites/docs` API pages for the new routes; `docs/architecture/sessions-and-runner.md` (batch resume-info), `file-state-and-sync-runs.md` (config-batch on boot).

- [ ] One commit per route, tests first.

### Task 6: Change feed on the server

**Files:**
- Create: `apps/server/domain/change-feed.ts`: `publishNodeChange(nodeId: string, kind: "node" | "files")`, `changesSince(cursor: number | null, max = 500): { cursor: number; reset: boolean; changes: {node_id, kind, seq}[] }` (in-memory ring of 2000; a cursor older than the ring or from another process instance → `reset: true`, empty changes, current cursor), `waitForChange(cursor, timeoutMs, signal): Promise<void>`, `subscribeChanges(cb)` for the local sessions WebSocket, `resetChangeFeedForTesting()`.
- Modify: publish sites — `domain/nodes.ts` (create/update/move/archive/access), `domain/edges.ts` (both ends), `domain/events.ts`, `domain/responsibilities.ts`, `domain/entity-attributes.ts`, `domain/sync/engine-mutations.ts`, `engine.ts`, `reconcile.ts`, `remote-watcher.ts`, `remote-sweep.ts`, `sync-remote-api.ts`, `file-content-remote.ts`, `pending-ops.ts` (every audit insert site gets `publishNodeChange(nodeId, "files")`).
- Route: `GET /changes?since=<n>&wait=<s≤25>` in `router.ts` (read scope; long-poll via `waitForChange`), `min-scopes.ts`.
- Test: `test/change-feed.test.ts` (ring, reset, wait resolves on publish, wait times out), `test/api-changes.test.ts` (route; `since` unknown → reset).

- [ ] Tests first; commit `feat(server): a change feed of node and file changes, read by GET /changes`.

### Task 7: Delivery to the window

**Files:**
- Modify: `apps/server/api/sessions-ws.ts`: new server→client frames `node_changed {node_id, kind}`; local deps subscribe to `subscribeChanges`; agent deps take a `ChangePoller`.
- Create: `apps/server/boot/change-poller.ts`: `createChangePoller(client: CentralClient, onChange)` long-polling `GET /changes` (`wait=20`), backing off on failure and 429 (reuses the central-backfill back-off shape), `reset` → `onReset()`; started in `desktop.ts` for the sync agent; `central/client.ts` gets `changes(since, waitS)` with a 30 s timeout.
- Modify: `domain/sync/mirror-watcher.ts` deps get `onReconciled(nodeId)`; `boot/mirror-watch.ts` and `desktop.ts` wire it to `publishNodeChange(nodeId, "files")` on the device's own feed (which the local sessions WS subscribes to in both workspaces).
- Web: `lib/sessions-client.ts` (`onNodeChanged(cb)`), `App.tsx` (a `node_changed` for the shown node → `fetchNode` into its detail (coalesced 500 ms); a `reset` → refetch the shown detail once), `components/DetailPane.tsx` (`files_changed`/`node_changed` for its node → `loadSyncStatus`), `lib/use-sync-pending.ts` (`files_changed` → refresh, throttled 2 s), `lib/use-file-editor.ts` (`files_changed` for its node → version check).
- Polls: node-detail poll and sync-status poll go to 60 s (`poll-policy.ts` constants), editor poll 60 s; `use-sync-pending` 30 s stays.
- Tests: `test/sessions-ws*.test.ts` (frame delivered on publish, local deps), `test/change-poller.test.ts` (fake client: delivers, backs off, reset), `test/sessions-client.test.ts` (frame → listener), `test/web-poll-policy.test.ts` (intervals).
- Docs: `docs/architecture/sessions-and-runner.md` (frames), `data-modes.md` (feed: local publishes directly, the sync agent polls central), `task-surface-web.md`, `sites/docs` live channel page; spec rows 4 and 11 marked done.

- [ ] Tests first per layer; commit `feat(server,web,sync): node and file changes reach the window over the live channel; detail polls become 60 s fallbacks`.

### Task 8: Gate, PR update

- [ ] `scripts/agent-gate.sh` green; update PR #649 title to `fix(web,server,desktop): the client traffic contract — UI actions, shared data, mutations, batch routes and a change feed` and body (per-action table extended, both workspaces, what is not verified).
