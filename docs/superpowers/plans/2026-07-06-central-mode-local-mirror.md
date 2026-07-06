# Central-mode `local_mirror` overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In central mode (`data_mode: "central"`), make a node's device-local `local_mirror` show up in the web DetailPane header and in MCP `portuni_get_node`, so an existing on-disk mirror stops rendering as "Pracovní složka zatím neexistuje".

**Architecture:** `local_mirror` is per-device state (rows in `<workspace_root>/.portuni/sync.db`, table `local_mirrors`, keyed by `SOLO_USER`). In central mode a node read is served by the central server, which has no device state, so it always returns `local_mirror: null`. The fix overlays the device-local mirror **on the device**, from the single source of truth `getLocalMirror(userId, nodeId)`, at the two seams that reach central: (1) the local sync agent's REST router serves a new read-only `GET /nodes/:id/mirror`, and the web overlays it onto the node after `fetchNode` (central mode only); (2) the MCP front door (`agent-transport.ts`) overlays `local_mirror` onto the proxied `portuni_get_node` result. No auth-credential change, no Rust change (`is_local_only_path` already matches `/nodes/:id/mirror` for any method).

**Tech Stack:** Node + TypeScript backend (`node:test` runner via `node --import tsx --test`), libSQL, React + Vite frontend (`tsc -b` typecheck, no unit-test runner).

## Global Constraints

- **Conventional Commits are load-bearing.** Use `fix(sync):`, `fix(mcp):`, `fix(web):` scopes. Never hand-bump the version (release-please owns it).
- **No emoji in code.** Czech UI copy uses diacritics.
- **`getLocalMirror` is the only source of device-local mirror truth.** Do not read the `local_mirrors` table directly anywhere new; call `getLocalMirror`/`registerMirror` from `apps/server/domain/sync/local-db.js` / `mirror-registry.js`.
- **Agent identity is `SOLO_USER`** (`apps/server/infra/schema.js`) on this device; `getLocalMirror` requires `PORTUNI_WORKSPACE_ROOT` set (it is, in the sidecar/agent).
- **Do not clobber a populated `local_mirror`.** Overlay only when the incoming value is null/absent.
- **Response shapes must stay identical between local and central engines** (agent-router.ts contract: "the webview cannot tell which engine served it").

## Out of scope (documented, not fixed here)

Per-file `local_path` in node-detail (`files[].local_path`) is *also* null in central mode for the same root cause (it derives from the node mirror path via `buildNodeRoot`/`deriveLocalPath`, and for MCP additionally from scope-disk-projection). That is a separate, larger change and is **not** the reported symptom (the header placeholder). This plan deliberately fixes only `local_mirror`. If the file-path derivation is wanted, it is a follow-up plan.

## File Structure

- `apps/server/shared/api-types.ts` — add `NodeMirrorResponse` next to `LocalMirror`.
- `apps/server/api/agent-router.ts` — add `GET /nodes/:id/mirror` (central-mode read).
- `apps/server/mcp/agent-tools.ts` — add pure-ish `enrichGetNodeResult(userId, result)` overlay helper.
- `apps/server/mcp/agent-transport.ts` — call `enrichGetNodeResult` for `portuni_get_node`.
- `apps/web/src/types.ts` — re-export `NodeMirrorResponse`.
- `apps/web/src/api.ts` — add `fetchNodeMirror(id)`.
- `apps/web/src/App.tsx` — overlay `local_mirror` after `fetchNode` (central mode only), at both load sites.
- Tests: `test/agent-router.test.ts` (endpoint), `test/agent-tools.test.ts` (overlay helper).

---

### Task 1: `GET /nodes/:id/mirror` read endpoint on the sync agent

**Files:**
- Modify: `apps/server/shared/api-types.ts` (add `NodeMirrorResponse` after the `LocalMirror` definition, ~line 221)
- Modify: `apps/server/api/agent-router.ts` (imports + new GET branch)
- Test: `test/agent-router.test.ts`

**Interfaces:**
- Consumes: `getLocalMirror(userId: string, nodeId: string): Promise<LocalMirrorRow | null>` from `apps/server/domain/sync/local-db.js`; `LocalMirror` type from `../shared/api-types.js`.
- Produces: HTTP `GET /nodes/:id/mirror` → `200 NodeMirrorResponse` where `NodeMirrorResponse = { node_id: string; local_mirror: LocalMirror }` and `LocalMirror = { local_path: string; registered_at: string } | null`.

- [ ] **Step 1: Add the shared response type**

In `apps/server/shared/api-types.ts`, directly below the existing `LocalMirror` type:

```ts
export interface NodeMirrorResponse {
  node_id: string;
  local_mirror: LocalMirror;
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/agent-router.test.ts` (inside the existing `describe`, reusing its `baseUrl`/`fetch` helpers, `SOLO_USER`, `NODE_ID`, `registerMirror`, and the temp `workspace` set up in `beforeEach`):

```ts
it("GET /nodes/:id/mirror returns the registered device mirror", async () => {
  const mirrorRoot = join(workspace, "workflow", "projects", "stan-gws");
  await registerMirror(SOLO_USER, NODE_ID, mirrorRoot);

  const res = await fetch(`${baseUrl}/nodes/${NODE_ID}/mirror`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.node_id, NODE_ID);
  assert.equal(body.local_mirror.local_path, mirrorRoot);
  assert.equal(typeof body.local_mirror.registered_at, "string");
});

it("GET /nodes/:id/mirror returns null local_mirror when unregistered", async () => {
  const res = await fetch(`${baseUrl}/nodes/${NODE_ID}/mirror`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.node_id, NODE_ID);
  assert.equal(body.local_mirror, null);
});
```

(If the existing suite names the base URL / fetch helper differently, match the existing tests in the file — they already issue `fetch(`${baseUrl}/nodes/${NODE_ID}/sync-status`)`-style calls.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="GET /nodes/:id/mirror"` (or `node --import tsx --test test/agent-router.test.ts`)
Expected: FAIL — the route returns `501 agent_mode` (the catch-all), so `res.status` is 501, not 200.

- [ ] **Step 4: Implement the endpoint**

In `apps/server/api/agent-router.ts`, add the imports (top, with the other domain imports):

```ts
import { getLocalMirror } from "../domain/sync/local-db.js";
import type { NodeMirrorResponse } from "../shared/api-types.js";
```

Then add this branch **before** the existing POST mirror branch (`const mirrorMatch = ...`), so the read is handled explicitly:

```ts
const mirrorReadMatch = pathname.match(/^\/nodes\/([^/]+)\/mirror$/);
if (mirrorReadMatch && method === "GET") {
  const nodeId = decodeURIComponent(mirrorReadMatch[1]);
  const m = await getLocalMirror(identity.userId, nodeId);
  const payload: NodeMirrorResponse = {
    node_id: nodeId,
    local_mirror: m ? { local_path: m.local_path, registered_at: m.registered_at } : null,
  };
  respondJson(res, 200, payload);
  return true;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test test/agent-router.test.ts`
Expected: PASS (both new cases, plus the pre-existing ones unchanged).

- [ ] **Step 6: Typecheck the server build**

Run: `npm run build`
Expected: `tsc` exits 0, `dist/` refreshed.

- [ ] **Step 7: Commit**

```bash
git add apps/server/shared/api-types.ts apps/server/api/agent-router.ts test/agent-router.test.ts
git commit -m "fix(sync): serve GET /nodes/:id/mirror on the central-mode agent"
```

---

### Task 2: Overlay `local_mirror` on MCP `portuni_get_node` in the front door

**Files:**
- Modify: `apps/server/mcp/agent-tools.ts` (add `enrichGetNodeResult`)
- Modify: `apps/server/mcp/agent-transport.ts` (call it for `portuni_get_node`)
- Test: `test/agent-tools.test.ts`

**Interfaces:**
- Consumes: `getLocalMirror` from `../domain/sync/local-db.js`.
- Produces: `enrichGetNodeResult(userId: string, result: ToolResult): Promise<ToolResult>` where `ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean }`. Returns the result unchanged when `isError`, when no text content, when the text is not JSON, when the parsed node has no string `id`, or when the node already carries a truthy `local_mirror`. Otherwise it sets `node.local_mirror` from `getLocalMirror(userId, node.id)` (or `null`) and re-serializes the first text block with `JSON.stringify(node, null, 2)`.

- [ ] **Step 1: Write the failing test**

Append to `test/agent-tools.test.ts` (reuses its `beforeEach` temp `workspace` + `resetLocalDbForTests`, `registerMirror`, `SOLO_USER` — import `SOLO_USER` and `enrichGetNodeResult` at the top if not already):

```ts
import { enrichGetNodeResult } from "../apps/server/mcp/agent-tools.js";
import { SOLO_USER } from "../apps/server/infra/schema.js";

const GN_ID = "N000000000000000000000GNOD";

it("enrichGetNodeResult fills local_mirror from the device registry", async () => {
  const mirrorRoot = join(workspace, "workflow", "projects", "gnode");
  await registerMirror(SOLO_USER, GN_ID, mirrorRoot);

  const result = {
    content: [{ type: "text", text: JSON.stringify({ id: GN_ID, name: "G", local_mirror: null }) }],
  };
  const out = await enrichGetNodeResult(SOLO_USER, result);
  const node = JSON.parse(out.content[0].text);
  assert.equal(node.local_mirror.local_path, mirrorRoot);
});

it("enrichGetNodeResult leaves local_mirror null when unregistered", async () => {
  const result = {
    content: [{ type: "text", text: JSON.stringify({ id: GN_ID, name: "G", local_mirror: null }) }],
  };
  const out = await enrichGetNodeResult(SOLO_USER, result);
  const node = JSON.parse(out.content[0].text);
  assert.equal(node.local_mirror, null);
});

it("enrichGetNodeResult passes through error results untouched", async () => {
  const result = { content: [{ type: "text", text: "boom" }], isError: true };
  const out = await enrichGetNodeResult(SOLO_USER, result);
  assert.equal(out, result);
});

it("enrichGetNodeResult passes through non-JSON text untouched", async () => {
  const result = { content: [{ type: "text", text: "not json" }] };
  const out = await enrichGetNodeResult(SOLO_USER, result);
  assert.equal(out.content[0].text, "not json");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/agent-tools.test.ts`
Expected: FAIL — `enrichGetNodeResult` is not exported ("does not provide an export named 'enrichGetNodeResult'").

- [ ] **Step 3: Implement `enrichGetNodeResult`**

In `apps/server/mcp/agent-tools.ts`, add the import near the top:

```ts
import { getLocalMirror } from "../domain/sync/local-db.js";
```

Add the exported helper (near the other exports):

```ts
type ToolTextResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

// Overlay device-local `local_mirror` onto a proxied portuni_get_node result.
// Central serves the node with local_mirror:null (it has no device state);
// this fills it from getLocalMirror on the device that owns the mirror.
// Defensive: any shape it does not recognise passes through unchanged.
export async function enrichGetNodeResult<T extends ToolTextResult>(
  userId: string,
  result: T,
): Promise<T> {
  if (result.isError) return result;
  const first = result.content.find((c) => c.type === "text" && typeof c.text === "string");
  if (!first || typeof first.text !== "string") return result;
  let node: Record<string, unknown>;
  try {
    node = JSON.parse(first.text) as Record<string, unknown>;
  } catch {
    return result;
  }
  const id = typeof node.id === "string" ? node.id : null;
  if (!id) return result;
  if (node.local_mirror) return result;
  const m = await getLocalMirror(userId, id);
  node.local_mirror = m ? { local_path: m.local_path, registered_at: m.registered_at } : null;
  const text = JSON.stringify(node, null, 2);
  return {
    ...result,
    content: result.content.map((c) => (c === first ? { ...c, text } : c)),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/agent-tools.test.ts`
Expected: PASS (all four new cases).

- [ ] **Step 5: Wire it into the front door**

In `apps/server/mcp/agent-transport.ts`, add to the imports from `./agent-tools.js`:

```ts
import { LOCAL_TOOLS, callLocalTool, enrichGetNodeResult } from "./agent-tools.js";
```

In `buildAgentServer`, replace the final `return upstream.callTool({ name, arguments: args });` inside the `CallToolRequestSchema` handler with:

```ts
if (name === "portuni_get_node") {
  const result = await upstream.callTool({ name, arguments: args });
  return enrichGetNodeResult(identity.userId, result as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  });
}
return upstream.callTool({ name, arguments: args });
```

- [ ] **Step 6: Typecheck the server build**

Run: `npm run build`
Expected: `tsc` exits 0. (If the `upstream.callTool` return type does not structurally match, keep the `as` cast shown above — the SDK's `CallToolResult.content` is `Array<{ type: string; text?: string; ... }>`, which is assignable.)

- [ ] **Step 7: Run the full agent test files**

Run: `node --import tsx --test test/agent-tools.test.ts test/agent-transport.test.ts`
Expected: PASS (new overlay tests + existing transport tests unaffected).

- [ ] **Step 8: Commit**

```bash
git add apps/server/mcp/agent-tools.ts apps/server/mcp/agent-transport.ts test/agent-tools.test.ts
git commit -m "fix(mcp): overlay device local_mirror on proxied portuni_get_node"
```

---

### Task 3: Web overlays `local_mirror` after `fetchNode` (central mode only)

**Files:**
- Modify: `apps/web/src/types.ts` (re-export `NodeMirrorResponse`)
- Modify: `apps/web/src/api.ts` (add `fetchNodeMirror`)
- Modify: `apps/web/src/App.tsx` (overlay at both node-detail load sites)

**Interfaces:**
- Consumes: `NodeMirrorResponse` (from Task 1), `apiFetch`, `isCentral` (already `const isCentral = dataMode?.mode === "central"` at `App.tsx:70`).
- Produces: `fetchNodeMirror(id: string): Promise<NodeMirrorResponse>`.

- [ ] **Step 1: Re-export the type for the frontend**

In `apps/web/src/types.ts`, add `NodeMirrorResponse` to the `export type { ... } from "../../server/shared/api-types"` block (alongside `NodeDetail`).

- [ ] **Step 2: Add the fetch helper**

In `apps/web/src/api.ts`, add `NodeMirrorResponse` to the type import from `./types`, and add:

```ts
export async function fetchNodeMirror(id: string): Promise<NodeMirrorResponse> {
  const res = await apiFetch(`/nodes/${encodeURIComponent(id)}/mirror`);
  if (!res.ok) throw new Error(`mirror: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 3: Add the overlay helper in App**

In `apps/web/src/App.tsx`, add `fetchNodeMirror` to the import from `./api` (the line importing `fetchGraph, fetchNode, ...`). Then, near the other `useCallback`s (after `isCentral` is defined, ~line 70+):

```tsx
// Central mode serves node-detail from the central server, which has no
// device state, so local_mirror comes back null even when this device has
// the mirror. Overlay it from the local sync agent (GET /nodes/:id/mirror).
// Local mode already carries local_mirror in node-detail, so skip the extra
// call there. Orgs never have a mirror.
const hydrateLocalMirror = useCallback(
  async (node: NodeDetail): Promise<NodeDetail> => {
    if (!isCentral || node.local_mirror || node.type === "organization") return node;
    try {
      const { local_mirror } = await fetchNodeMirror(node.id);
      return local_mirror ? { ...node, local_mirror } : node;
    } catch {
      return node;
    }
  },
  [isCentral],
);
```

- [ ] **Step 4: Apply it at the primary load site**

In the `useEffect` that loads the selected node (~`App.tsx:216`), change the `fetchNode` chain to hydrate before setting state:

```tsx
fetchNode(selectedId)
  .then((n) => hydrateLocalMirror(n))
  .then((n) => {
    if (cancelled) return;
    setNodeDetail(n);
    setDetailLoading(false);
  })
  .catch((err) => {
    if (cancelled) return;
    setDetailError(String(err));
    setDetailLoading(false);
  });
```

Add `hydrateLocalMirror` to that `useEffect`'s dependency array (alongside `selectedId`).

- [ ] **Step 5: Apply it at the refetch site**

In `refetchAll` (~`App.tsx:234`), hydrate the refetched node before setting it:

```tsx
const refetchAll = useCallback(async () => {
  const [graphRes, nodeRes] = await Promise.all([
    fetchGraph(),
    selectedId ? fetchNode(selectedId).catch(() => null) : Promise.resolve(null),
  ]);
  setGraph(graphRes);
  setGraphError(null);
  if (nodeRes) setNodeDetail(await hydrateLocalMirror(nodeRes));
}, [selectedId, hydrateLocalMirror]);
```

- [ ] **Step 6: Typecheck the web build**

Run: `npm --prefix apps/web run build`
Expected: `tsc -b` exits 0 (vite build may follow; the typecheck is what matters here).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/App.tsx
git commit -m "fix(web): overlay device local_mirror in central mode node detail"
```

---

### Task 4: End-to-end verification against the running desktop app

**Files:** none (verification only).

- [ ] **Step 1: Rebuild the backend the desktop sidecar runs**

The installed `/Applications/Portuni.app` runs its bundled sidecar; for a fast check use the running app after confirming the code paths, or rebuild the sidecar per `CLAUDE.md` (`npm run build:sidecar`) if you want the change live in the `.app`. For a pure REST check without rebuilding the app, hit the agent directly.

- [ ] **Step 2: Confirm the endpoint answers for the reported node**

With the tempo workspace sidecar running (port 47011) and its per-launch token, or via the app, verify the agent returns the mirror. The reported node and its known path:

```
node_id:   01KNP2WDXQ7C6GJ4K476KWAQ08
local_path: /Users/honzapav/Workspaces/portuni-tempo/workflow/projects/260408-naturamed-prj-asana-2601
```

Expected: `GET /nodes/01KNP2WDXQ7C6GJ4K476KWAQ08/mirror` → `{ "node_id": "...", "local_mirror": { "local_path": "/Users/honzapav/Workspaces/portuni-tempo/workflow/projects/260408-naturamed-prj-asana-2601", "registered_at": "..." } }`.

- [ ] **Step 3: Confirm the UI**

Open the desktop app on the `tempo` workspace, select node `01KNP2WDXQ7C6GJ4K476KWAQ08`. Expected: the header shows the click-to-copy path (PathCopy), not "Pracovní složka zatím neexistuje — bude vytvořena při spuštění …". Spot-check 2-3 other project/process nodes.

- [ ] **Step 4: Confirm nothing regressed in local mode**

Switch to the `honzavav` workspace (local mode). Expected: node headers still show their mirror paths (served by node-detail as before; `hydrateLocalMirror` is a no-op because `local_mirror` is already present and `isCentral` is false).

---

## Self-Review

**Spec coverage:**
- Web header placeholder in central mode → Tasks 1 + 3 (endpoint + overlay). ✓
- MCP `portuni_get_node` local_mirror null in central mode → Task 2. ✓
- "Works the same regardless of mode" (user's core expectation) → the webview renders `node.local_mirror` unchanged; the mode difference is absorbed by `hydrateLocalMirror` (web) and `enrichGetNodeResult` (MCP), both reading the one source of truth `getLocalMirror`. ✓
- File `local_path` in central mode → explicitly out of scope, documented above. ✓

**Placeholder scan:** No TBD/TODO; every code step carries full code. Verification steps name exact node id + path.

**Type consistency:** `NodeMirrorResponse = { node_id: string; local_mirror: LocalMirror }` defined once (Task 1), re-exported (Task 3), consumed by `fetchNodeMirror`. `enrichGetNodeResult(userId, result)` signature identical in Task 2 definition, test, and transport call site. `getLocalMirror` used verbatim from `local-db.js` in Tasks 1 and 2. `LocalMirror` is the existing nullable union — not redefined.
