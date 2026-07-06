# Scope Single-Source-of-Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-session `SessionScope` node set the single authoritative read scope, with on-disk file access reconciled from it on every mutation, so the graph layer and the disk (Seatbelt) layer can never disagree.

**Architecture:** Today read access is gated by two independently-evolving layers — the MCP graph scope (grows via auto-seed, `session_init`, `get_node`/`get_context`, `expand_scope`) and a Seatbelt sandbox profile fixed at terminal spawn (home rw + depth-1 neighbors ro). They drift: a node reached mid-session via `get_context` enters graph scope but stays unreadable on disk, because disk staging only fired inside `expand_scope`. The fix routes *all* disk widening through one path: `SessionScope` gains an `onAdd` subscriber; a `ScopeReconciler` subscribes once per session and stages every node that enters scope into `<home>/.portuni-scope/<id>/`. The Seatbelt profile is reduced to home-only (the neighbor read-allow — the second source of truth — is removed), so on-disk readability of any non-home node is, by construction, exactly the staged projection of the scope set. Read tools surface the staged path as `local_path` for non-home in-scope nodes so what the agent is told to read equals what it can read.

**Tech Stack:** TypeScript (Node ESM), `@libsql/client` (libSQL/Turso), `node:test` + `tsx` test runner, macOS Seatbelt (`sandbox-exec`).

## Global Constraints

- Tests run from the repo root: `npm test` (whole suite) or `node --import tsx --test test/<file>.test.ts` (single file). In non-login shells where `node` is missing or ESM-errors, use `~/.nvm/versions/node/v24.0.2/bin/node` (and `.../npm`).
- Build is `npm run build` (tsc → `dist/`). The standalone server runs from `dist/`; after server-side changes a rebuild + tmux restart is how it reaches a live mirror session, but tests run against TS sources directly via tsx.
- No emoji in code.
- All staging copies live under a dot-segment (`.portuni-scope/`) so the sync walkers (`apps/server/domain/sync/mirror-ignore.ts`) never adopt or push them. Do not change that invariant.
- Staging must **copy**, never symlink: Seatbelt matches realpaths, so a symlink would resolve to the denied real path. (Documented in `apps/server/domain/sandbox-profile.ts`.)
- Best-effort disk side effects must never throw out of a graph operation: graph scope is authoritative; a failed copy is degraded, not fatal (matches the existing `stageAcceptedNodes` try/catch contract).
- Preserve existing public response shapes. `local_path` stays a string|null field; only its *value* changes (real → staged) for non-home in-scope nodes.

---

## File Structure

- `apps/server/mcp/scope.ts` — MODIFY. Add `onAdd` subscriber support to `SessionScope`; fire listeners inside `add()`.
- `apps/server/mcp/scope-reconciler.ts` — CREATE. `ScopeReconciler`: resolves the home mirror, stages a node into `.portuni-scope/<id>/` when it enters scope, exposes `reconcileNode(nodeId)` (awaitable, idempotent) and `schedule(nodeId)` (fire-and-forget). Plus `stagedMirrorRoot(homeMirror, nodeId)` pure helper.
- `apps/server/mcp/server.ts` — MODIFY. Construct a `ScopeReconciler` per session, subscribe it to `scope.onAdd`, and put it on `SessionCtx`.
- `apps/server/mcp/tools/scope.ts` — MODIFY. Remove the bespoke `stageAcceptedNodes` helper and its call in `expand_scope` (now handled by the reconciler via `onAdd`); keep the response `staged`/`hint` wording driven off the reconciler result.
- `apps/server/domain/sandbox-profile.ts` — MODIFY. Drop the depth-1 neighbor read-allow from `buildSeatbeltProfile`; remove the now-unused `neighborMirrors` from `SandboxScope` and the peer query in `resolveSandboxScopeForNode`.
- `apps/server/mcp/tools/get-node.ts` — MODIFY. For a non-home in-scope node, await `reconciler.reconcileNode(id)` and derive `local_path` from the staged root.
- `apps/server/mcp/tools/files.ts` — MODIFY. Same staged-root rewrite for per-file `local_path` when the node is non-home and in scope.
- `apps/server/mcp/tools/context.ts` — MODIFY. Rewrite `mirrorMap` entries for non-home in-scope nodes to their staged roots.
- `apps/server/domain/write-scope.ts` — MODIFY. `buildSoftHint` documents the `.portuni-scope/<id>/` read convention (feeds `PORTUNI_SCOPE.md` + `.cursor/rules`).
- `CLAUDE.md` — MODIFY. Update the disk-scope gotcha to describe the single-source model.
- `docs/architecture/scope-disk-projection.md` — CREATE. Short design note.
- Tests: `test/scope.test.ts` (MODIFY — onAdd), `test/scope-reconciler.test.ts` (CREATE), `test/sandbox-profile.test.ts` (MODIFY — home-only profile), `test/scope-staging.test.ts` (unchanged — `stageNodeIntoMirror` contract is reused as-is).

---

### Task 1: `SessionScope` add-subscriber

**Files:**
- Modify: `apps/server/mcp/scope.ts:41-95` (the `SessionScope` class)
- Test: `test/scope.test.ts`

**Interfaces:**
- Produces: `SessionScope.onAdd(listener: (nodeId: string) => void): void`. Listeners fire once, synchronously, after a node is newly inserted by `add()` (NOT on a duplicate add). `add()` keeps its `boolean` return.

- [ ] **Step 1: Write the failing test**

Append to `test/scope.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionScope } from "../apps/server/mcp/scope.js";

describe("SessionScope.onAdd", () => {
  it("fires a listener once per newly-added node, with the node id", () => {
    const scope = new SessionScope("strict");
    const seen: string[] = [];
    scope.onAdd((id) => seen.push(id));
    assert.equal(scope.add("A"), true);
    assert.equal(scope.add("A"), false); // duplicate: no second fire
    assert.equal(scope.add("B"), true);
    assert.deepEqual(seen, ["A", "B"]);
  });

  it("supports multiple listeners", () => {
    const scope = new SessionScope("strict");
    let a = 0, b = 0;
    scope.onAdd(() => a++);
    scope.onAdd(() => b++);
    scope.add("X");
    assert.equal(a, 1);
    assert.equal(b, 1);
  });

  it("never throws out of add() when a listener throws", () => {
    const scope = new SessionScope("strict");
    scope.onAdd(() => { throw new Error("boom"); });
    assert.doesNotThrow(() => scope.add("X"));
    assert.equal(scope.has("X"), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/scope.test.ts`
Expected: FAIL — `scope.onAdd is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `apps/server/mcp/scope.ts`, inside `class SessionScope`, add the field near the other privates (after line 47):

```ts
  private readonly addListeners: ((nodeId: string) => void)[] = [];
```

Add the registration method (place it just above `add()`):

```ts
  // Subscribe to node additions. Listeners fire synchronously, once, only
  // when a node is newly inserted (not on a duplicate add). A throwing
  // listener is swallowed so disk-projection failures never corrupt the
  // authoritative in-memory scope. This is the single hook every disk
  // projection of the scope set hangs off.
  onAdd(listener: (nodeId: string) => void): void {
    this.addListeners.push(listener);
  }
```

Replace the existing `add()` (lines 79-83) with:

```ts
  // Add a node to the scope set. Returns true if it was actually added.
  add(nodeId: string): boolean {
    if (this.nodes.has(nodeId)) return false;
    this.nodes.add(nodeId);
    for (const listener of this.addListeners) {
      try {
        listener(nodeId);
      } catch {
        /* listeners are best-effort disk projections; never fail a graph add */
      }
    }
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/scope.test.ts`
Expected: PASS (existing scope tests still green).

- [ ] **Step 5: Commit**

```bash
git add apps/server/mcp/scope.ts test/scope.test.ts
git commit -m "feat(scope): add onAdd subscriber to SessionScope"
```

---

### Task 2: `ScopeReconciler` — stage on scope entry

**Files:**
- Create: `apps/server/mcp/scope-reconciler.ts`
- Test: `test/scope-reconciler.test.ts`

**Interfaces:**
- Consumes: `stageNodeIntoMirror` from `apps/server/domain/scope-staging.js` (`{ homeMirror, nodeId, nodeMirror } -> Promise<{ staged_path, files }>`); `getMirrorPath(userId, nodeId) -> Promise<string | null>` from `apps/server/domain/sync/mirror-registry.js`; `SessionScope` from `./scope.js`.
- Produces:
  - `stagedMirrorRoot(homeMirror: string, nodeId: string): string` — pure: `join(homeMirror, ".portuni-scope", nodeId)`.
  - `createScopeReconciler(args: { userId: string; scope: SessionScope }): ScopeReconciler`.
  - `interface ScopeReconciler { reconcileNode(nodeId: string): Promise<{ staged_path: string; files: number } | null>; schedule(nodeId: string): void; }`
  - `reconcileNode` returns null (no copy) when: nodeId is the home node, there is no home node, the node has no local mirror, or the copy throws. Otherwise it stages and returns the result. `schedule` is fire-and-forget (`void reconcileNode(...)`, errors swallowed).

- [ ] **Step 1: Write the failing test**

Create `test/scope-reconciler.test.ts`:

```ts
// Tests for the scope reconciler: the single path that projects the
// authoritative SessionScope set onto disk. When a node enters scope it
// is staged read-only into <home>/.portuni-scope/<id>/. The home node is
// never staged (it is already rw). Missing mirrors degrade to null.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionScope } from "../apps/server/mcp/scope.js";
import {
  stagedMirrorRoot,
  createScopeReconciler,
} from "../apps/server/mcp/scope-reconciler.js";

let dir: string;
let home: string;
let neighbor: string;

// The reconciler resolves mirrors via getMirrorPath(userId, nodeId). We
// inject a fake by overriding the module's resolver through the documented
// `resolveMirror` option (see createScopeReconciler args below).
function fakeResolver(map: Record<string, string>) {
  return async (_userId: string, nodeId: string) => map[nodeId] ?? null;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-reconciler-"));
  home = join(dir, "home");
  neighbor = join(dir, "neighbor");
  await mkdir(join(home, "wip"), { recursive: true });
  await mkdir(join(neighbor, "wip"), { recursive: true });
  await writeFile(join(neighbor, "wip", "method.md"), "# method\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("stagedMirrorRoot", () => {
  it("is home/.portuni-scope/<id>", () => {
    assert.equal(stagedMirrorRoot("/h", "01N"), join("/h", ".portuni-scope", "01N"));
  });
});

describe("ScopeReconciler.reconcileNode", () => {
  it("stages a non-home node's mirror into the home .portuni-scope dir", async () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    const r = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ HOME: home, NEIGHBOR: neighbor }),
    });
    const res = await r.reconcileNode("NEIGHBOR");
    assert.ok(res);
    assert.equal(res.staged_path, join(home, ".portuni-scope", "NEIGHBOR"));
    const staged = await readFile(
      join(home, ".portuni-scope", "NEIGHBOR", "wip", "method.md"),
      "utf8",
    );
    assert.equal(staged, "# method\n");
  });

  it("returns null for the home node (never stages itself)", async () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    const r = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ HOME: home }),
    });
    assert.equal(await r.reconcileNode("HOME"), null);
  });

  it("returns null when the node has no local mirror", async () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    const r = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ HOME: home }),
    });
    assert.equal(await r.reconcileNode("GHOST"), null);
  });

  it("returns null when there is no home node", async () => {
    const scope = new SessionScope("strict"); // homeNodeId stays null
    const r = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: fakeResolver({ NEIGHBOR: neighbor }),
    });
    assert.equal(await r.reconcileNode("NEIGHBOR"), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/scope-reconciler.test.ts`
Expected: FAIL — cannot find module `scope-reconciler.js`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/mcp/scope-reconciler.ts`:

```ts
// The single path that projects the authoritative SessionScope set onto
// disk. The Seatbelt sandbox a terminal runs under grants rw on the home
// mirror only; every other in-scope node is made readable by copying its
// mirror into <home>/.portuni-scope/<id>/ (inside the visible zone,
// read-only). Subscribed once per session to scope.onAdd, so ANY code path
// that adds a node to scope — auto-seed, session_init, get_node/get_context
// auto-allow, expand_scope — projects to disk identically. Graph scope is
// authoritative; a failed copy degrades to null, it never throws.

import { join } from "node:path";
import { stageNodeIntoMirror } from "../domain/scope-staging.js";
import { getMirrorPath } from "../domain/sync/mirror-registry.js";
import type { SessionScope } from "./scope.js";

// Deterministic staged location for a node's files inside the home mirror.
export function stagedMirrorRoot(homeMirror: string, nodeId: string): string {
  return join(homeMirror, ".portuni-scope", nodeId);
}

export interface ScopeReconciler {
  // Stage a node now and resolve when the copy is complete. Idempotent:
  // re-staging replaces the previous copy so callers can use it to refresh.
  // Returns null when nothing was staged (home node, no home, no mirror,
  // or a copy failure).
  reconcileNode(nodeId: string): Promise<{ staged_path: string; files: number } | null>;
  // Fire-and-forget staging for the onAdd hook. Errors are swallowed.
  schedule(nodeId: string): void;
}

type MirrorResolver = (userId: string, nodeId: string) => Promise<string | null>;

export function createScopeReconciler(args: {
  userId: string;
  scope: SessionScope;
  // Injectable for tests; defaults to the per-device mirror registry.
  resolveMirror?: MirrorResolver;
}): ScopeReconciler {
  const resolveMirror: MirrorResolver = args.resolveMirror ?? getMirrorPath;

  async function reconcileNode(
    nodeId: string,
  ): Promise<{ staged_path: string; files: number } | null> {
    const homeNodeId = args.scope.homeNodeId;
    if (!homeNodeId || nodeId === homeNodeId) return null;
    const homeMirror = await resolveMirror(args.userId, homeNodeId);
    if (!homeMirror) return null;
    const nodeMirror = await resolveMirror(args.userId, nodeId);
    if (!nodeMirror) return null;
    try {
      return await stageNodeIntoMirror({ homeMirror, nodeId, nodeMirror });
    } catch {
      return null;
    }
  }

  return {
    reconcileNode,
    schedule(nodeId: string): void {
      void reconcileNode(nodeId);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/scope-reconciler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/mcp/scope-reconciler.ts test/scope-reconciler.test.ts
git commit -m "feat(scope): add ScopeReconciler that stages nodes on scope entry"
```

---

### Task 3: Wire the reconciler into the session and `expand_scope`

**Files:**
- Modify: `apps/server/mcp/server.ts:37-43` (SessionCtx), `:94-120` (createMcpServer)
- Modify: `apps/server/mcp/tools/scope.ts:1-41` (remove `stageAcceptedNodes`), `:243-268` (expand_scope response)
- Test: `test/scope-fixes.test.ts` (add an integration assertion)

**Interfaces:**
- Consumes: `createScopeReconciler` (Task 2), `SessionScope.onAdd` (Task 1).
- Produces: `SessionCtx.reconciler: ScopeReconciler` available to every tool handler. `expand_scope` no longer stages directly; staging happens through the `onAdd` subscription. The expand_scope response still reports staged nodes by collecting `reconciler.reconcileNode` results for the newly-accepted ids (awaited, so the response's `staged` list is accurate and the copies are complete before the agent reads).

- [ ] **Step 1: Write the failing test**

Add to `test/scope-fixes.test.ts` a focused unit asserting the wiring stages on `add`. If the file's harness is heavy, instead create `test/scope-session-wiring.test.ts`:

```ts
// The session wires ScopeReconciler to scope.onAdd, so adding any node to
// the authoritative scope set projects it to disk through the one path.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { createScopeReconciler } from "../apps/server/mcp/scope-reconciler.js";

let dir: string, home: string, neighbor: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-wiring-"));
  home = join(dir, "home");
  neighbor = join(dir, "neighbor");
  await mkdir(home, { recursive: true });
  await mkdir(neighbor, { recursive: true });
  await writeFile(join(neighbor, "n.md"), "n\n");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("scope.onAdd -> reconciler wiring", () => {
  it("stages a node when it is added to scope (not via expand_scope)", async () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    const reconciler = createScopeReconciler({
      userId: "u",
      scope,
      resolveMirror: async (_u, id) =>
        id === "HOME" ? home : id === "NEIGHBOR" ? neighbor : null,
    });
    // This is the exact wiring createMcpServer performs:
    scope.onAdd((id) => reconciler.schedule(id));

    scope.add("NEIGHBOR");
    // schedule() is fire-and-forget; await the deterministic reconcile to
    // observe the completed copy.
    await reconciler.reconcileNode("NEIGHBOR");
    const staged = await readFile(
      join(home, ".portuni-scope", "NEIGHBOR", "n.md"),
      "utf8",
    );
    assert.equal(staged, "n\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/scope-session-wiring.test.ts`
Expected: PASS for the helper-level wiring (this test uses only Task 1+2 exports, so it should pass) — its purpose is to lock the wiring contract. If it fails, Task 1/2 regressed. Now make the *server* perform this wiring (steps below) and confirm nothing breaks.

- [ ] **Step 3: Wire `createMcpServer`**

In `apps/server/mcp/server.ts`, extend `SessionCtx` (around line 37):

```ts
export interface SessionCtx {
  scope: SessionScope;
  identity: RequestIdentity;
  reconciler: ScopeReconciler;
}
```

Add the import near the other mcp imports:

```ts
import { createScopeReconciler, type ScopeReconciler } from "./scope-reconciler.js";
```

Replace the construction block (lines 97-99) with:

```ts
  const scope = new SessionScope(parseScopeMode(process.env.PORTUNI_SCOPE_MODE));
  const reconciler = createScopeReconciler({ userId: identity.userId, scope });
  scope.onAdd((nodeId) => reconciler.schedule(nodeId));
  const ctx: SessionCtx = { scope, identity, reconciler };
```

- [ ] **Step 4: Simplify `expand_scope`**

In `apps/server/mcp/tools/scope.ts`:

Delete the `stageAcceptedNodes` helper (lines 20-41) and the now-unused imports `stageNodeIntoMirror` (line 6) and `getMirrorPath` (line 5) IF they are unused elsewhere in the file (they are — confirm with a grep). Keep `loadNodeScopeMeta`, `seedScopeFromHome`, `violatesHardFloor`, `nodeVisibleTo`.

Replace the staging call (line 247) with a reconciler-driven version. Change the handler signature to capture `ctx` (already in scope via `registerScopeTools(server, ctx)` — `ctx.reconciler` is available). Replace:

```ts
      // Sandboxed terminals cannot see newly approved mirrors — stage
      // read-only copies inside the home mirror so the disk view matches
      // the just-expanded graph scope.
      const staged = await stageAcceptedNodes(ctx.identity.userId, scope.homeNodeId, accepted);
```

with:

```ts
      // Disk projection runs through the reconciler (also fired via
      // scope.onAdd). Await it here so the response's `staged` list is
      // accurate and the read-only copies are complete before the agent
      // reads them.
      const stagedResults = await Promise.all(
        accepted.map(async (id) => {
          const r = await ctx.reconciler.reconcileNode(id);
          return r ? { node_id: id, staged_path: r.staged_path, files: r.files } : null;
        }),
      );
      const staged = stagedResults.filter((s): s is NonNullable<typeof s> => s !== null);
```

The existing response block referencing `staged.length` and `staged` stays unchanged.

`registerScopeTools` already receives `ctx`; if the handler closure currently destructures only `{ scope }`, keep that and also reference `ctx.reconciler` and `ctx.identity` directly (both already used in the file).

- [ ] **Step 5: Run tests + build**

Run:
```bash
node --import tsx --test test/scope-session-wiring.test.ts test/scope.test.ts test/scope-staging.test.ts test/scope-fixes.test.ts
npm run build
```
Expected: all PASS; `tsc` clean (this proves `SessionCtx.reconciler` is threaded and no dangling imports remain).

- [ ] **Step 6: Commit**

```bash
git add apps/server/mcp/server.ts apps/server/mcp/tools/scope.ts test/scope-session-wiring.test.ts
git commit -m "feat(scope): wire ScopeReconciler to session scope; expand_scope stages via reconciler"
```

---

### Task 4: Reduce the Seatbelt profile to home-only

**Files:**
- Modify: `apps/server/domain/sandbox-profile.ts:26-58` (`SandboxScope`, `buildSeatbeltProfile`), `:74-110` (`resolveSandboxScopeForNode`)
- Test: `test/sandbox-profile.test.ts`

**Interfaces:**
- Produces: `buildSeatbeltProfile(scope)` emits NO neighbor read rules — only `(allow default)`, root deny, root read-metadata, and home rw. `SandboxScope` loses the `neighborMirrors` field. `resolveSandboxScopeForNode` no longer queries `edges`.
- Consumes: callers `apps/server/api/nodes.ts` and `apps/server/api/write-scope.ts` build `SandboxScope` — they must stop passing `neighborMirrors`.

- [ ] **Step 1: Update the failing test**

In `test/sandbox-profile.test.ts`, replace any assertion that the profile contains a neighbor `(allow file-read* (subpath ...neighbor...))` with the inverse, and assert home rw is present. Add:

```ts
import { buildSeatbeltProfile } from "../apps/server/domain/sandbox-profile.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("buildSeatbeltProfile (home-only, single-source model)", () => {
  it("grants rw on the home mirror and denies the rest of the root", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/org/proj",
    });
    assert.match(p, /\(deny file-read\* file-write\* \(subpath "\/root"\)\)/);
    assert.match(p, /\(allow file-read-metadata \(subpath "\/root"\)\)/);
    assert.match(p, /\(allow file-read\* file-write\* \(subpath "\/root\/org\/proj"\)\)/);
  });

  it("emits NO standalone neighbor read-allow rules", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/org/proj",
    });
    // The only file-read* allows are the home rw line and read-metadata.
    const reads = p.split("\n").filter((l) => l.includes("file-read*"));
    assert.equal(reads.length, 1); // just the home rw line
  });
});
```

Update any other test in this file that constructs `SandboxScope` with `neighborMirrors` to drop that property.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/sandbox-profile.test.ts`
Expected: FAIL — current `buildSeatbeltProfile` still emits neighbor lines / `SandboxScope` still requires `neighborMirrors`.

- [ ] **Step 3: Implement the home-only profile**

In `apps/server/domain/sandbox-profile.ts`:

Replace `SandboxScope` (lines 26-30):

```ts
export interface SandboxScope {
  portuniRoot: string;
  homeMirror: string;
}
```

Replace `buildSeatbeltProfile` (lines 39-58) with:

```ts
// Render the Seatbelt profile. Paths must already be realpath-resolved.
//
// Single-source model: the home mirror is the only place the kernel grants
// read/write. Every OTHER in-scope node is made readable not here but by
// the ScopeReconciler, which copies it into <home>/.portuni-scope/<id>/
// (inside the home subpath, so already covered by the home rw rule). This
// removes the old depth-1 neighbor read-allow, which was a second,
// spawn-frozen source of truth that drifted from the live session scope.
//
// Rule order is load-bearing: Seatbelt gives later rules precedence, so
// the root deny comes first and the home allow overrides it.
export function buildSeatbeltProfile(scope: SandboxScope): string {
  const home = normalize(scope.homeMirror);
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath ${sbQuote(normalize(scope.portuniRoot))}))`,
    // stat/traverse stays allowed so git repo discovery and path
    // resolution work; directory listings and file contents stay denied.
    `(allow file-read-metadata (subpath ${sbQuote(normalize(scope.portuniRoot))}))`,
    `(allow file-read* file-write* (subpath ${sbQuote(home)}))`,
  ];
  return lines.join("\n") + "\n";
}
```

Replace `resolveSandboxScopeForNode` (lines 74-110) — drop the peer query and `neighborMirrors`:

```ts
export async function resolveSandboxScopeForNode(
  db: Client,
  userId: string,
  nodeId: string,
): Promise<SandboxScope | null> {
  const home = await getMirrorPath(userId, nodeId);
  if (!home) return null;

  const allMirrors = await listUserMirrors(userId);
  const portuniRoot = resolvePortuniRoot({
    envValue: process.env.PORTUNI_ROOT ?? null,
    knownMirrors: allMirrors.map((m) => m.local_path),
  });
  if (!portuniRoot) return null;

  return {
    portuniRoot: await resolveReal(portuniRoot),
    homeMirror: await resolveReal(home),
  };
}
```

Remove the now-unused `db` param ONLY if no longer referenced — it is still used by `listUserMirrors`? No: `listUserMirrors(userId)` does not take `db`. Check: if `db` becomes unused, keep the signature (callers pass it) but prefix `_db` to silence lint, OR keep `db` if `listUserMirrors` needs it. Confirm `listUserMirrors` signature; if it ignores `db`, rename the param to `_db` and update both call sites only if TS complains about unused. Simplest: keep `db` named, add `void db;` is NOT allowed (no-op). Prefer renaming to `_db` and leaving call sites unchanged (callers still pass their `db`).

Update the module header comment (lines 1-9) to describe the home-only model and point to `scope-reconciler.ts`.

- [ ] **Step 4: Fix callers**

In `apps/server/api/nodes.ts` (around line 706-715) and `apps/server/api/write-scope.ts` (around line 70-90): these call `resolveSandboxScopeForNode` / `resolveSandboxScopeForCwd` and pass the result straight to `buildSeatbeltProfile`. No shape change needed at the call site (they pass the whole scope object). Confirm neither constructs a `SandboxScope` literal with `neighborMirrors`; if any test helper does, drop it. `resolveSandboxScopeForCwd` returns `{ nodeId, scope }` and still compiles.

- [ ] **Step 5: Run tests + build**

Run:
```bash
node --import tsx --test test/sandbox-profile.test.ts test/rest-sandbox-profile.test.ts
npm run build
```
Expected: PASS; `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/domain/sandbox-profile.ts test/sandbox-profile.test.ts
git commit -m "refactor(sandbox): home-only Seatbelt profile; disk reads of neighbors go through staging"
```

---

### Task 5: Surface the staged path as `local_path` for non-home in-scope nodes

**Files:**
- Modify: `apps/server/mcp/tools/get-node.ts:115-175`
- Modify: `apps/server/mcp/tools/files.ts:160-210`
- Modify: `apps/server/mcp/tools/context.ts:290-350,420-430`
- Test: `test/scope-fixes.test.ts` (add cases) or a new `test/staged-local-path.test.ts`

**Interfaces:**
- Consumes: `stagedMirrorRoot` + `ScopeReconciler.reconcileNode` (Task 2), `ctx.reconciler` (Task 3), `scope.homeNodeId`, `scope.has`.
- Produces: For any node whose `id !== scope.homeNodeId` and `scope.has(id)`, the `local_path` returned for its files is rooted at `<home>/.portuni-scope/<id>/` instead of the node's real mirror. `get_node` and `list_files` additionally `await ctx.reconciler.reconcileNode(id)` before deriving paths, guaranteeing the copy exists and is fresh.

- [ ] **Step 1: Write the failing test**

Create `test/staged-local-path.test.ts`. This is an integration-flavored test of the pure rewrite helper. First extract a shared helper to keep the three tools DRY — add to `apps/server/mcp/scope-reconciler.ts`:

```ts
// The mirror root to surface to the agent for a node's files: the staged
// copy for an in-scope non-home node (what the sandbox actually lets it
// read), the real mirror for the home node or anything else.
export function readableMirrorRoot(args: {
  scope: SessionScope;
  nodeId: string;
  homeMirror: string | null;
  realMirror: string | null;
}): string | null {
  const { scope, nodeId, homeMirror, realMirror } = args;
  if (nodeId !== scope.homeNodeId && scope.has(nodeId) && homeMirror) {
    return stagedMirrorRoot(homeMirror, nodeId);
  }
  return realMirror;
}
```

Test:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { readableMirrorRoot } from "../apps/server/mcp/scope-reconciler.js";

describe("readableMirrorRoot", () => {
  const home = "/root/org/home";
  it("returns the real mirror for the home node", () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    scope.add("HOME");
    assert.equal(
      readableMirrorRoot({ scope, nodeId: "HOME", homeMirror: home, realMirror: home }),
      home,
    );
  });
  it("returns the staged root for an in-scope non-home node", () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    scope.add("HOME");
    scope.add("NB");
    assert.equal(
      readableMirrorRoot({
        scope, nodeId: "NB", homeMirror: home, realMirror: "/root/org/nb",
      }),
      join(home, ".portuni-scope", "NB"),
    );
  });
  it("returns the real mirror for an out-of-scope node (unchanged)", () => {
    const scope = new SessionScope("strict");
    scope.homeNodeId = "HOME";
    assert.equal(
      readableMirrorRoot({
        scope, nodeId: "OUT", homeMirror: home, realMirror: "/root/org/out",
      }),
      "/root/org/out",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/staged-local-path.test.ts`
Expected: FAIL — `readableMirrorRoot` not exported.

- [ ] **Step 3: Implement the helper, then apply it in the three tools**

Add `readableMirrorRoot` to `scope-reconciler.ts` (code above). Then:

**get-node.ts** — before building `files` (around line 119), resolve the home mirror and stage if needed:

```ts
      // Single-source disk projection: for a non-home in-scope node, the
      // agent can only read the staged copy, so derive paths from there and
      // ensure the copy is fresh first.
      const homeMirror = scope.homeNodeId
        ? (await getLocalMirror(ctx.identity.userId, scope.homeNodeId))?.local_path ?? null
        : null;
      if (row.id !== scope.homeNodeId && scope.has(row.id)) {
        await ctx.reconciler.reconcileNode(row.id);
      }
      const effectiveMirrorRoot = readableMirrorRoot({
        scope,
        nodeId: row.id,
        homeMirror,
        realMirror: mirrorPath,
      });
```

Then in the `files.map(...)` derivation, replace `mirrorPath` with `effectiveMirrorRoot` in the `if (mirrorPath && remotePath)` guard and the `deriveLocalPath({ mirrorRoot: ... })` call:

```ts
        if (effectiveMirrorRoot && remotePath) {
          ...
          derivedLocal = deriveLocalPath({ mirrorRoot: effectiveMirrorRoot, nodeRoot, remotePath });
```

Add the import: `import { readableMirrorRoot } from "../scope-reconciler.js";`. Note `local_mirror` (the `localMirror` pair, lines 121-123) keeps reporting the REAL registered mirror + `registered_at` — that's metadata about registration, not a read path; leave it.

**files.ts** — in the loop that fills `mirrorByNode` (line 165) and derives `local_path` (line 205): resolve the home mirror once before the loop; for each node, await reconcile when in-scope+non-home, and feed `readableMirrorRoot(...)` as the mirror root into the existing derivation. Concretely, where it does `mirrorByNode.set(nodeId, await getMirrorPath(...))`, additionally compute the readable root:

```ts
        if (!mirrorByNode.has(nodeId)) {
          const real = await getMirrorPath(ctx.identity.userId, nodeId);
          if (nodeId !== scope.homeNodeId && scope.has(nodeId)) {
            await ctx.reconciler.reconcileNode(nodeId);
          }
          const homeMirror = scope.homeNodeId
            ? await getMirrorPath(ctx.identity.userId, scope.homeNodeId)
            : null;
          mirrorByNode.set(
            nodeId,
            readableMirrorRoot({ scope, nodeId, homeMirror, realMirror: real }),
          );
        }
```

(Adjust to the file's actual variable names; the net effect: the map holds the readable root, not the raw mirror.) Add the `readableMirrorRoot` import.

**context.ts** — after `mirrorMap` is populated (line 300 area), rewrite entries for in-scope non-home nodes. context surfaces many nodes; do NOT await-stage each here (the `onAdd` hook already scheduled them) — just point `local_path` at the staged root so it is correct:

```ts
    const homeMirror = scope.homeNodeId ? mirrorMap.get(scope.homeNodeId) ?? null : null;
    for (const [nodeId, real] of [...mirrorMap.entries()]) {
      mirrorMap.set(
        nodeId,
        readableMirrorRoot({ scope, nodeId, homeMirror, realMirror: real }),
      );
    }
```

Ensure `scope` is in scope of this function (context tools receive `ctx`); add the `readableMirrorRoot` import. If `buildContextPayload` is a free function without `scope`, thread `scope` in from the caller (it already passes `ctx.identity`); add a `scope: SessionScope` parameter and pass `ctx.scope` at the call sites in `get-node.ts:115` and `context.ts` tool handler. Keep the depth-0 `get_node` call passing its `scope` too.

- [ ] **Step 4: Run tests + build**

Run:
```bash
node --import tsx --test test/staged-local-path.test.ts test/scope-fixes.test.ts
npm run build
```
Expected: PASS; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/mcp/scope-reconciler.ts apps/server/mcp/tools/get-node.ts apps/server/mcp/tools/files.ts apps/server/mcp/tools/context.ts test/staged-local-path.test.ts
git commit -m "feat(scope): surface staged .portuni-scope path as local_path for in-scope neighbors"
```

---

### Task 6: Update soft hints + docs

**Files:**
- Modify: `apps/server/domain/write-scope.ts` (`buildSoftHint`)
- Create: `docs/architecture/scope-disk-projection.md`
- Modify: `CLAUDE.md` (the disk-scope gotcha)
- Test: `test/write-scope.test.ts` (assert the hint mentions `.portuni-scope`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `PORTUNI_SCOPE.md` / `.cursor/rules` text instructs the agent that files of related (non-home) in-scope nodes are read from `<mirror>/.portuni-scope/<node_id>/`, and that `portuni_get_node` / `portuni_get_context` return that path in `local_path`.

- [ ] **Step 1: Write the failing test**

In `test/write-scope.test.ts`, add:

```ts
import { buildSoftHint } from "../apps/server/domain/write-scope.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("buildSoftHint disk projection note", () => {
  it("documents the .portuni-scope read convention", () => {
    const hint = buildSoftHint({
      currentMirror: "/root/org/proj",
      portuniRoot: "/root",
    });
    assert.match(hint, /\.portuni-scope/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/write-scope.test.ts`
Expected: FAIL — current hint has no `.portuni-scope` mention.

- [ ] **Step 3: Update `buildSoftHint`**

In `apps/server/domain/write-scope.ts`, in `buildSoftHint`, add a paragraph to the generated markdown (keep the existing write-scope and file-registration sections intact):

```
## Reading related nodes

Files belonging to the home node live at their real paths in this mirror.
Files of OTHER in-scope nodes (related/neighbour nodes) are read from
`<this-mirror>/.portuni-scope/<node_id>/` — the only place the sandbox lets
you read them. `portuni_get_node` and `portuni_get_context` already return
that staged path in each file's `local_path`; use the path they give you
rather than the node's original mirror path. If a related node is not yet
in scope, the read tools return `scope_expansion_required` — confirm with
the user, then `portuni_expand_scope`.
```

- [ ] **Step 4: Create the design doc**

Create `docs/architecture/scope-disk-projection.md`:

```markdown
# Scope disk projection (single source of truth)

The per-session `SessionScope` node set (`apps/server/mcp/scope.ts`) is the
ONE authoritative read scope. Disk access is a pure projection of it.

## Why

Previously two layers gated reads and drifted:
- graph scope: grows via auto-seed, session_init, get_node/get_context,
  expand_scope;
- a Seatbelt profile fixed at terminal spawn (home rw + depth-1 neighbors
  ro), widened mid-session only by expand_scope staging.

A node reached via get_context (e.g. a related node created after spawn)
entered graph scope but stayed unreadable on disk — the reported bug
(session e3c79c7c). The agent could see the node in the graph yet got
EPERM on its files, even with the sandbox "disabled" (the desktop wraps the
shell in `sandbox-exec`, an outer boundary the inner toggle cannot lift).

## How

- `SessionScope.add()` fires `onAdd` listeners (Task 1).
- `ScopeReconciler` (`apps/server/mcp/scope-reconciler.ts`) subscribes once
  per session in `createMcpServer`. When a node enters scope it copies the
  node's mirror into `<home>/.portuni-scope/<id>/` (read-only, inside the
  home rw zone). Dot-segment => excluded from sync walkers.
- The Seatbelt profile is home-only. There is no neighbor read-allow; the
  staged copies ARE the neighbor read access. One mechanism, no drift.
- get_node / get_context / list_files surface the staged path as
  `local_path` for non-home in-scope nodes (`readableMirrorRoot`).

## Trade-offs

Staged copies are point-in-time. get_node / list_files await a re-stage
before handing back a path, so a single-node read is fresh; get_context
relies on the eager onAdd staging and may serve a slightly stale snapshot
of a neighbour edited within the same session. Acceptable: neighbours are
read-only references. Future optimisation: incremental (mtime-diff) staging
instead of wholesale re-copy.
```

- [ ] **Step 5: Update CLAUDE.md**

In `CLAUDE.md`, find the disk-scope / mirror gotcha bullet(s) and add/adjust a bullet under **Gotchas** (preserve surrounding bullets verbatim):

```
- **Disk read scope = the session scope, projected.** The MCP `SessionScope`
  is the single source of truth; the Seatbelt sandbox grants rw on the home
  mirror only. Every other in-scope node is made readable by copying it into
  `<home>/.portuni-scope/<node_id>/` (the `ScopeReconciler`, fired on every
  `scope.add`). Read related-node files from the `local_path` the read tools
  return (it points into `.portuni-scope/`), not the node's original mirror.
  Model: `docs/architecture/scope-disk-projection.md`.
```

- [ ] **Step 6: Run tests + commit**

Run: `node --import tsx --test test/write-scope.test.ts`
Expected: PASS.

```bash
git add apps/server/domain/write-scope.ts docs/architecture/scope-disk-projection.md CLAUDE.md test/write-scope.test.ts
git commit -m "docs(scope): document single-source disk projection and .portuni-scope reads"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all PASS. Pay attention to `test/scope*.test.ts`, `test/sandbox-profile.test.ts`, `test/rest-sandbox-profile.test.ts`, `test/scope-staging.test.ts`, `test/auto-seed-scope.test.ts`, `test/mcp-rematerialize-on-boot.test.ts`.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `tsc` clean.

- [ ] **Step 3: Manual end-to-end check against the reported bug (optional, requires the live sidecar)**

Per `CLAUDE.md` backend loop: `npm run build` then restart the `portuni-mcp` tmux. In a mirror whose node has an `applies`/related edge to another mirrored node, connect a session, call `portuni_get_context` to pull the related node into scope, then confirm a `Read` of that node's file via the `local_path` returned (a `.portuni-scope/<id>/...` path) succeeds. This reproduces session e3c79c7c's flow and should now read instead of EPERM.

- [ ] **Step 4: Commit any final fixups**

```bash
git add -A
git commit -m "test(scope): full-suite green for single-source scope projection"
```

---

## Self-Review

**Spec coverage:**
- Single source of truth = scope set → Tasks 1-3 (onAdd hook + reconciler + session wiring). ✓
- Disk = pure projection, no second source → Task 4 (home-only Seatbelt). ✓
- Fix the reported bug (get_context-reached node unreadable) → Tasks 3+4+5 (node enters scope → staged → staged path surfaced). ✓
- Path coherence (told-path == readable-path) → Task 5. ✓
- Discoverability / agent guidance → Task 6 (soft hint, CLAUDE.md, design doc). ✓

**Placeholder scan:** No TBD/TODO; every code step shows code; commands have expected output. Two spots say "adjust to the file's actual variable names" (files.ts, context.ts) — these are localized to existing loops whose exact identifiers the implementer reads in-context; the behavior (feed `readableMirrorRoot` output as the mirror root) is fully specified.

**Type consistency:** `ScopeReconciler.reconcileNode` returns `Promise<{ staged_path; files } | null>` everywhere; `readableMirrorRoot` returns `string | null`; `stagedMirrorRoot` returns `string`; `SessionCtx.reconciler: ScopeReconciler` consistent across Tasks 2/3/5. `buildSeatbeltProfile`/`SandboxScope` lose `neighborMirrors` consistently across Task 4 and its callers.

**Open risk to watch during execution:** `buildContextPayload` may need a new `scope` parameter (Task 5) — its current signature is `(db, nodeId, depth, userId, identity)`; threading `scope` touches both call sites (`get-node.ts`, `context.ts`). If that proves invasive, the fallback is to rewrite `mirrorMap`/`local_path` in the tool handlers *after* `buildContextPayload` returns (the payload exposes `local_path` per node), avoiding a signature change.
