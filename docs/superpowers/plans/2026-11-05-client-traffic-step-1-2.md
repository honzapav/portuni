# Client traffic, steps 1–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A UI action in the desktop window costs only the requests it needs: closing or opening a node, a live frame, a tab switch and a window focus no longer fan out, and polls run only for what is on screen and never while the server has answered `429`.

**Architecture:** Pure policy modules under `apps/web/src/lib/` decide what to fetch (tested with the server's `node:test` runner, there is no component runner); `App.tsx`, `DetailPane` and the Relace/Přehled surfaces call them. The session store becomes the source for Relace; frames refetch only incomplete records. `/mcp/info` joins the device-local route list so the footer asks the sidecar.

**Tech Stack:** React 19, TypeScript, `node:test` via `tsx`, Tauri 2 (Rust route matcher reads `device-local-routes.json`).

**Spec:** `docs/superpowers/specs/2026-11-05-client-traffic-contract.md`

## Global Constraints

- No UI text in code: every string a user reads is a catalog key (`apps/server/shared/i18n/`); the gate fails on a JSX literal and on Czech diacritics outside comments and `locales/`.
- A device-local route lives in `device-local-routes.json`, is served by the device (`agent-router.ts` or `http/server.ts`), and `test/agent-router-route-parity.test.ts` holds both sides to the list.
- Every selector in `session-selectors.ts` goes through `cached()` and gets a reference-stability test in `test/session-store.test.ts`.
- Tests: `npm test` (root) runs `test/*.test.ts`; web pure helpers are imported from `../apps/web/src/lib/*.js`. No fixed sleeps.
- Commits: Conventional Commits with scopes `web`, `desktop`, `server`, `docs`.
- Gate before the PR: `scripts/agent-gate.sh`.

## Review Focus

1. Personal workspace (`data_mode: "local"`): `/mcp/info` is answered by the one local server; the footer must still show the right URL. Pinned in Task 1 (server test runs against the plain `startHttpServer`).
2. A `429` whose body carries no `params.retryAfterSeconds` (an older server, a proxy): cooldown must still apply with a bounded default, never `NaN`. Pinned in Task 2.
3. A frame for a session the store knows only as a stub (name absent) on an open node must still trigger one refetch, or the sidebar never learns the name. Pinned in Task 4.
4. Relace for a node that is not open in Práce: its rows land in the store and must show, and closing that node later must not throw for records never listed in Práce. Pinned in Task 5.
5. Přehled while a thread is created elsewhere: the new id is not in the payload, so a refetch must happen once, not on every subsequent frame of that same thread. Pinned in Task 6.

---

### Task 1: `/mcp/info` is a device-local route

**Files:**
- Modify: `apps/server/shared/device-local-routes.json` (add `{ "method": "GET", "pattern": "/mcp/info", "example": "/mcp/info" }` to `device_local`)
- Modify: `test/agent-router-route-parity.test.ts:69-80` (`routerPatterns` also scans `apps/server/http/server.ts`, where `/mcp/info` is answered before the router)
- Modify: `apps/desktop/src/lib.rs` tests (~4225): add `mcp_info_is_device_local`
- Modify: `apps/web/src/lib/use-mcp-status.ts` header comment (the footer asks this device's server)
- Test: `test/agent-router-route-parity.test.ts`

**Interfaces:**
- Produces: nothing new; the route list entry is what `is_device_local_path` reads.

- [ ] **Step 1: Write the failing test**

```ts
it("GET /mcp/info is device-local and answered by the server front door", async () => {
  assert.ok(contract.device_local.some((e) => e.method === "GET" && e.pattern === "/mcp/info"));
  const res = await authFetch(`${base}/mcp/info`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { url: string; port: number };
  assert.match(body.url, /\/mcp$/);
  assert.equal(typeof body.port, "number");
});
```

- [ ] **Step 2: Run it, expect FAIL on the `some(...)` assertion**

Run: `npm test -- test/agent-router-route-parity.test.ts` (or `node --import tsx --test test/agent-router-route-parity.test.ts`)

- [ ] **Step 3: Add the entry to `device_local`; run again, expect the "dead" check to fail (`listed as device-local but no handler pattern in agent-router.ts matches it`)**

- [ ] **Step 4: Make `routerPatterns` take the union of `agent-router.ts` and `http/server.ts` sources**

`const served = new Set([...routerPatterns(routerSource), ...routerPatterns(serverSource)])` with `SERVER_PATH = new URL("../apps/server/http/server.ts", import.meta.url)`. Update the test's header comment: the front door answers `/health` and `/mcp/info` itself.

- [ ] **Step 5: Add the Rust test `assert!(is_device_local_path("/mcp/info"))` next to `scope_is_device_local`; run `cd apps/desktop && cargo test is_device_local` (needs `scripts/desktop-dev-placeholders.sh` once)**

- [ ] **Step 6: Run the parity test, expect PASS; commit**

```bash
git commit -m "fix(desktop,web): the footer's MCP status asks this device, not the central server"
```

### Task 2: A window-wide `429` cooldown

**Files:**
- Create: `apps/web/src/lib/rate-limit-cooldown.ts`
- Modify: `apps/web/src/lib/backend-url.ts:186-205` (`apiFetchOnce` records a `429`)
- Test: `test/web-rate-limit-cooldown.test.ts`

**Interfaces:**
- Produces:
  - `noteRateLimited(retryAfterSeconds: number | null | undefined, now?: number): void` — sets the cooldown to `now + seconds * 1000`; a missing or non-positive value uses `DEFAULT_COOLDOWN_S = 30`; never shortens an existing longer cooldown.
  - `rateLimitedUntil(): number` — ms epoch, `0` when none.
  - `isRateLimited(now?: number): boolean`
  - `retryAfterFromBody(bodyText: string): number | null` — `params.retryAfterSeconds` when it is a finite number `>= 1`, else `null`.
  - `resetRateLimitCooldownForTesting(): void`

- [ ] **Step 1: Write the failing tests**

```ts
describe("rate-limit cooldown", () => {
  beforeEach(() => resetRateLimitCooldownForTesting());
  it("is inactive until a 429 is noted", () => assert.equal(isRateLimited(1000), false));
  it("holds for Retry-After seconds", () => {
    noteRateLimited(28, 1_000);
    assert.equal(isRateLimited(28_999), true);
    assert.equal(isRateLimited(29_000), false);
    assert.equal(rateLimitedUntil(), 29_000);
  });
  it("defaults to 30 s when the body carries no value", () => {
    noteRateLimited(null, 0);
    assert.equal(rateLimitedUntil(), 30_000);
  });
  it("never shortens a longer cooldown", () => {
    noteRateLimited(60, 0);
    noteRateLimited(5, 1_000);
    assert.equal(rateLimitedUntil(), 60_000);
  });
  it("reads retryAfterSeconds from an error body", () => {
    assert.equal(retryAfterFromBody('{"code":"RATE_LIMITED","params":{"retryAfterSeconds":28}}'), 28);
    assert.equal(retryAfterFromBody('{"code":"RATE_LIMITED"}'), null);
    assert.equal(retryAfterFromBody("not json"), null);
    assert.equal(retryAfterFromBody('{"params":{"retryAfterSeconds":0}}'), null);
  });
});
```

- [ ] **Step 2: Run `node --import tsx --test test/web-rate-limit-cooldown.test.ts`, expect FAIL (module missing)**

- [ ] **Step 3: Implement `apps/web/src/lib/rate-limit-cooldown.ts` with the signatures above (module-level `let until = 0`)**

- [ ] **Step 4: In `apiFetchOnce`, when the status is `429`, call `noteRateLimited(retryAfterFromBody(bodyText))` in both branches (browser: the cloned text already read for `errorCode`; Tauri: `proxied.body`)**

- [ ] **Step 5: Run the test, expect PASS; `npm --prefix apps/web run typecheck` if present, else `npx tsc -b apps/web`; commit**

```bash
git commit -m "feat(web): a 429 from the server puts the window's background traffic on cooldown"
```

### Task 3: Polls and focus refetch only what is visible

**Files:**
- Create: `apps/web/src/lib/poll-policy.ts`
- Modify: `apps/web/src/App.tsx:842-889` (focus handler and the 5 s node poll)
- Modify: `apps/web/src/components/WorkspaceView.tsx:123-133` (report `detailVisible` upward: new prop `onDetailVisibleChange?: (visible: boolean) => void`, called from an effect on `detailVisible`)
- Modify: `apps/web/src/components/DetailPane.tsx:559-571` (sync-status interval obeys the policy)
- Test: `test/web-poll-policy.test.ts`

**Interfaces:**
- Produces:
  - `type View = "overview" | "graph" | "workspace" | "settings"` (reuse App's existing view union; import its type if exported, else widen to `string`).
  - `nodeDetailPollTarget(input: { view: string; hidden: boolean; rateLimited: boolean; selectedId: string | null; selectedWorkspaceNodeId: string | null; workspaceDetailVisible: boolean }): { kind: "graph" | "workspace"; nodeId: string } | null`
    - `null` when hidden, rate limited, or the view is neither `graph` nor `workspace`;
    - `workspace` needs `selectedWorkspaceNodeId` and `workspaceDetailVisible`;
    - `graph` needs `selectedId`.
  - `shouldPollSyncStatus(input: { tab: string; hidden: boolean; rateLimited: boolean }): boolean` — true only for `tab === "files"`, visible, not rate limited.
  - `focusRefetchTargets(input: { view: string; rateLimited: boolean; selectedId: string | null; selectedWorkspaceNodeId: string | null }): { graph: boolean; nodeId: string | null }` — `{graph:false,nodeId:null}` when rate limited; otherwise `graph: true` and the node of the shown view only (`graph` → `selectedId`, `workspace` → `selectedWorkspaceNodeId`, other views → `null`).

- [ ] **Step 1: Write the failing tests** (one `it` per bullet above; include: `view: "settings"` with both selections set → `null`; workspace with `workspaceDetailVisible: false` → `null`; focus in `workspace` with both ids set → `nodeId === selectedWorkspaceNodeId`; `rateLimited: true` → nothing)

- [ ] **Step 2: Run `node --import tsx --test test/web-poll-policy.test.ts`, expect FAIL**

- [ ] **Step 3: Implement `apps/web/src/lib/poll-policy.ts`**

- [ ] **Step 4: Wire App.tsx**

- The 5 s interval calls `nodeDetailPollTarget({... hidden: document.hidden, rateLimited: isRateLimited() ...})`; `workspace` → `refetchWorkspaceDetail()`, `graph` → the existing `fetchNode(selectedId)` branch.
- New state `const [workspaceDetailVisible, setWorkspaceDetailVisible] = useState(true)`; `WorkspaceView` gets `onDetailVisibleChange={setWorkspaceDetailVisible}`. `workspaceDetailVisible` for the policy is `workspaceDetailVisible || shownThread === null` (no thread shown: the detail is the centre and always visible).
- The focus handler calls `focusRefetchTargets(...)`: `graph` → `fetchGraph()` into `setGraph` (the part of `refetchAll` that is the graph; split `refetchAll` into `refetchGraph` + `refetchSelectedNode` if it is one function today), `nodeId` → `fetchNode` into the right setter.

- [ ] **Step 5: Wire WorkspaceView (`useEffect(() => onDetailVisibleChange?.(detailVisible), [detailVisible, onDetailVisibleChange])`) and DetailPane (the interval body checks `shouldPollSyncStatus({ tab, hidden: document.hidden, rateLimited: isRateLimited() })`; the initial `loadSyncStatus()` on mount stays)**

- [ ] **Step 6: Run the test and `npx tsc -b apps/web`, expect PASS; commit**

```bash
git commit -m "fix(web): node polls and the focus refetch cover only what is on screen"
```

### Task 4: Opening and closing a node fetch nothing for the other nodes; frames refetch only incomplete records

**Files:**
- Create: `apps/web/src/lib/session-refresh-policy.ts`
- Modify: `apps/web/src/App.tsx:596-651` (open-set effect and the frames listener)
- Modify: `docs/architecture/task-surface-web.md` "What `App.tsx` still owns" (the two rules below)
- Test: `test/web-session-refresh-policy.test.ts`

**Interfaces:**
- Consumes: `SessionStore.get(id)` returning `{ partial?: true }` for a stub.
- Produces:
  - `nodesAddedToOpenSet(prev: readonly string[], next: readonly string[]): string[]` — ids in `next` not in `prev`, in `next` order.
  - `nodesToRefetchForFrames(frames: readonly { session_id: string; node_id: string | null }[], openNodeIds: readonly string[], isComplete: (sessionId: string) => boolean): string[]` — distinct open node ids that have at least one frame whose session `isComplete` returns false.

- [ ] **Step 1: Write the failing tests**

```ts
it("closing one of twelve nodes refetches nothing", () => {
  const prev = ids(12); const next = prev.filter((id) => id !== prev[3]);
  assert.deepEqual(nodesAddedToOpenSet(prev, next), []);
});
it("opening one node refetches that node only", () =>
  assert.deepEqual(nodesAddedToOpenSet(["a", "b"], ["a", "b", "c"]), ["c"]));
it("first mount refetches every open node", () =>
  assert.deepEqual(nodesAddedToOpenSet([], ["a", "b"]), ["a", "b"]));
it("a frame for a complete record refetches nothing", () =>
  assert.deepEqual(nodesToRefetchForFrames([{ session_id: "s1", node_id: "a" }], ["a"], () => true), []));
it("a frame for a stub on an open node refetches that node once", () =>
  assert.deepEqual(nodesToRefetchForFrames(
    [{ session_id: "s1", node_id: "a" }, { session_id: "s2", node_id: "a" }], ["a", "b"], () => false), ["a"]));
it("a frame for a node that is not open refetches nothing", () =>
  assert.deepEqual(nodesToRefetchForFrames([{ session_id: "s1", node_id: "z" }], ["a"], () => false), []));
```

- [ ] **Step 2: Run `node --import tsx --test test/web-session-refresh-policy.test.ts`, expect FAIL**

- [ ] **Step 3: Implement the module**

- [ ] **Step 4: Wire App.tsx**

- `const prevOpenNodeIdsRef = useRef<string[]>([])`; the effect at 637 becomes `for (const id of nodesAddedToOpenSet(prevOpenNodeIdsRef.current, openNodeIds)) refreshNodeSessions(id); prevOpenNodeIdsRef.current = openNodeIds;`.
- The listener at 645: `for (const nodeId of nodesToRefetchForFrames(states, openNodeIdsRef.current, (id) => { const r = sessionStore.get(id); return r !== undefined && !r.partial; })) refreshNodeSessions(nodeId);`. The `applyFrames` listener is registered first (line ~551), so by the time this runs the stub exists; the predicate handles both orders.
- Replace the `[t]` dependency of `refreshNodeSessions` by reading `t` through a ref so a language change does not refetch.

- [ ] **Step 5: Update `docs/architecture/task-surface-web.md` ("What `App.tsx` still owns"): "the open-set effect refetches only the nodes added; a frame refetches a node only for a session the store holds as a stub".**

- [ ] **Step 6: Run the tests and `npx tsc -b apps/web`, expect PASS; commit**

```bash
git commit -m "fix(web): closing or opening a node and a live frame no longer refetch every open node's threads"
```

### Task 5: Relace reads the node's sessions from the store

**Files:**
- Modify: `apps/web/src/lib/session-selectors.ts` (new selector)
- Modify: `apps/web/src/components/DetailPane.sessions.tsx:93-140` (rows from the store; `load` on mount, node change and the archived toggle only)
- Modify: `apps/web/src/components/DetailPane.tsx` (prop `liveSessionStates` → `sessionStore: SessionStore`, passed to `SessionsSection`)
- Modify: `apps/web/src/App.tsx` and `apps/web/src/components/WorkspaceView.tsx` (pass `sessionStore` where `liveSessionStates` was passed to DetailPane)
- Modify: `docs/architecture/task-surface-web.md` "Relace tab" and "The session store"
- Test: `test/session-store.test.ts`

**Interfaces:**
- Produces: `selectNodeSessionRows(store: SessionStore, nodeId: string, includeArchived: boolean): CompleteSession[]` — every complete record of the node (any `session_type`, any state), `archived` only when `includeArchived`, sorted by `last_active_at` descending; cached under key `nodeSessions:${nodeId}` with variant `${includeArchived}`.

- [ ] **Step 1: Write the failing tests in `test/session-store.test.ts`** — rows of the node only; archived hidden unless the flag; a stub excluded; same reference across an unrelated `put`; a new reference after a `put` on this node.

- [ ] **Step 2: Run `node --import tsx --test test/session-store.test.ts`, expect FAIL**

- [ ] **Step 3: Implement the selector**

- [ ] **Step 4: Rewire `SessionsSection`**: `const sessions = useSessionStore(sessionStore, useCallback((s) => selectNodeSessionRows(s, nodeId, includeArchived), [nodeId, includeArchived]))`; `load` keeps `fetchNodePersistentSessions(nodeId, includeArchived)` (its `putMany` fills the store) and sets only `loading`/`error`; the effect deps are `[load]`; delete `liveStamp` and `mergeLiveSessionStates` here; `onRenamed` and the other row callbacks stop touching local `sessions` (api.ts already puts the answer).

- [ ] **Step 5: Thread `sessionStore` through `DetailPane` (prop type and both call sites) and drop `liveSessionStates` from `DetailPane`'s props**

- [ ] **Step 6: Update the two doc sections; run the tests and `npx tsc -b apps/web`; commit**

```bash
git commit -m "fix(web): the Relace tab lists threads from the session store instead of refetching on every frame"
```

### Task 6: Přehled refetches only for a thread it does not know

**Files:**
- Modify: `apps/web/src/lib/session-views.ts` (new helper)
- Modify: `apps/web/src/components/OverviewView.tsx:84-94`
- Modify: `docs/architecture/task-surface-web.md` "Přehled"
- Test: `test/web-session-views.test.ts` (create if absent; check for an existing session-views test first and extend it)

**Interfaces:**
- Produces: `overviewMissesLiveThread(data: Pick<OverviewPayload, "sessions"> | null, liveStates: Readonly<Record<string, SessionStateMessage>>): boolean` — true when a live state in `running` or `suspended` has an id in neither `data.sessions.running` nor `data.sessions.suspended`; false for `data === null`.

- [ ] **Step 1: Write the failing tests** — known running id → false; unknown running id → true; unknown `closed` id → false; `data === null` → false.

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement the helper**

- [ ] **Step 4: In OverviewView: keep `load()` on mount; replace the `liveStamp` effect by `useEffect(() => { if (overviewMissesLiveThread(data, liveStates ?? {})) void load(); }, [data, liveStates, load])` — `data` in the deps makes the effect settle after the refetch (the refetched payload knows the id)**

- [ ] **Step 5: Update the doc section; run the tests and `npx tsc -b apps/web`; commit**

```bash
git commit -m "fix(web): the overview refetches only when a thread it does not list appears"
```

### Task 7: Resume-info fetched once per suspension

**Files:**
- Create: `apps/web/src/lib/resume-info-cache.ts`
- Modify: `apps/web/src/components/DetailPane.sessions.tsx:334-349`
- Test: `test/web-resume-info-cache.test.ts`

**Interfaces:**
- Produces: `cachedResumeInfo(session: { id: string; state: string; last_active_at: string }, fetcher: (id: string) => Promise<SessionResumeInfo>): Promise<SessionResumeInfo>` — one fetch per `${id}:${last_active_at}`; a rejected fetch is not cached; `resetResumeInfoCacheForTesting(): void`.

- [ ] **Step 1: Write the failing tests** — two calls with the same id and `last_active_at` → fetcher called once; a changed `last_active_at` → called again; a rejection → the next call fetches again.

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement (a `Map<string, Promise<SessionResumeInfo>>`, delete on rejection)**

- [ ] **Step 4: `SessionRow` calls `cachedResumeInfo(session, (id) => fetchPersistentSessionResumeInfo(id, configDir))` with the existing `configDir` argument folded into the fetcher; effect deps `[session.id, session.state, session.last_active_at]`**

- [ ] **Step 5: Run the test and `npx tsc -b apps/web`; commit**

```bash
git commit -m "fix(web): resume-info is fetched once per suspension, not on every Relace mount"
```

### Task 8: Docs, gate, PR

**Files:**
- Modify: `docs/architecture/desktop-shell.md` (the device-local list now carries `/mcp/info`; the `429` cooldown under "api_request routing")
- Modify: `sites/docs/src/content/docs/getting-started/team-setup.md:82` (one sentence: the window pauses its background polls for the `Retry-After` the server sends)
- Modify: `CLAUDE.md` "Web" rules: one line — "A UI action requests only what it needs; a change to a surface's traffic comes with a policy test (`lib/poll-policy.ts`, `lib/session-refresh-policy.ts`). Contract: `docs/superpowers/specs/2026-11-05-client-traffic-contract.md`."

- [ ] **Step 1: Make the doc edits**

- [ ] **Step 2: Run `scripts/agent-gate.sh`; fix what it reports**

- [ ] **Step 3: Run `npm --prefix sites/docs run build`**

- [ ] **Step 4: Commit docs; open the PR against `main` titled `fix(web,desktop): UI actions stop fanning out requests; polls cover only what is visible (client traffic steps 1–2)`, body: the spec's rule, the per-action request counts before/after, and the open items (steps 3–5) as named follow-ups. Note what was not verified in the installed app.**
