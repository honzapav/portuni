# Scope real-paths (retire .portuni-scope staging) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give a graph-traversing agent native, hard-enforced, minimal-scope filesystem access to in-scope nodes via their REAL mirror paths (deny-default Seatbelt grants), retiring the `.portuni-scope/<id>/` copy staging. Universal (no Claude-specific hooks); works in local and central mode.

**Why:** Copy staging has three inherent defects (proven with the user): (1) edits to a related node never propagate (read-only snapshot), (2) the copy diverges from its source mid-session and there is no cleanup (stale, readable, out-of-scope leftovers), (3) it is pure overhead in central mode where all mirrors are already on disk. Real paths dissolve all three: reads are the live file, writes land on the real mirror and sync normally, nothing is copied so nothing goes stale or needs cleanup.

**Architecture (locked decision — universal, no hooks):**
- **Related tier (home + depth-1, known at spawn):** their REAL mirror roots are granted `(allow file-read* (subpath …))` in the Seatbelt profile at terminal spawn. Native tools, kernel-hard, universal, zero-copy. Read is always granted; write stays a policy toggle (default: home rw, neighbors read-only — matches today's write-scope tiers).
- **Ad-hoc tier (deeper `expand_scope`, mid-session):** the Seatbelt profile is fixed at spawn and cannot widen; with no hooks the only universal + hard channel for a dynamically-added node is **server-mediated read-only** — a scope-enforcing MCP content tool (`portuni_read_file`). Native grep/glob is intentionally NOT offered for ad-hoc nodes (the agreed tax). Promoting an ad-hoc node into the working set (a deliberate action that regenerates the grant on next spawn) is how it becomes native/writable.
- The single source of truth stays `SessionScope`; the Seatbelt profile and the read tools both derive from it.

**Tech stack:** Node + TypeScript server (`node:test`), Rust (Tauri desktop, `sandbox-exec`), macOS Seatbelt (SBPL). Seatbelt matches REAL paths (symlinks resolve to the denied root — so grants must name real mirror paths, never `.portuni-scope` links).

## Global Constraints

- Conventional Commits: `feat(scope):`, `refactor(scope):`, `fix(scope):`. Never hand-bump version.
- No emoji in code. Czech UI copy uses diacritics.
- SBPL rule order is load-bearing: later rules win. Re-allow rules for in-scope subpaths MUST come AFTER the `(deny … (subpath PORTUNI_ROOT))` line.
- Seatbelt grants name REAL mirror roots only (never symlinks/staged paths).
- Fail-closed: a terminal must never spawn with a broader profile than intended; if the in-scope mirror set can't be resolved, fall back to today's home-only grant, never to "allow all".

## Phasing

- **Phase 1 (this plan, detailed):** Seatbelt grants real read paths for the spawn set (home + depth-1); read tools return real paths for granted nodes; the reconciler stops staging granted nodes. LOCAL mode. Deeper ad-hoc keeps today's staging as an untouched fallback (no regression). Delivers ~90% of the value safely.
- **Phase 2 (sketched):** `portuni_read_file` scope-enforced content tool; ad-hoc read tools return no `local_path` and route content through it; delete `ScopeReconciler` / `stageNodeIntoMirror` / `.portuni-scope` entirely.
- **Phase 3 (sketched):** central-mode unification — compute the depth-1 grant set from central in the local sidecar's sandbox-profile handler (today `NO_DB`), and enrich proxied read tools' `local_path` for the granted set in the front door.

---

## Phase 1

### Task 1: Seatbelt profile can grant read on a set of real mirror roots

**Files:**
- Modify: `apps/server/domain/sandbox-profile.ts` (`SandboxScope`, `buildSeatbeltProfile`)
- Test: `test/sandbox-profile.test.ts` (create if absent; else extend)

**Interfaces:**
- Produces: `SandboxScope = { portuniRoot: string; homeMirror: string; readMirrors: string[] }`; `buildSeatbeltProfile(scope)` emits, after the deny line, one `(allow file-read* (subpath <real>))` per `readMirrors` entry.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSeatbeltProfile } from "../apps/server/domain/sandbox-profile.js";

describe("buildSeatbeltProfile readMirrors", () => {
  it("re-allows read on each granted mirror AFTER the deny line", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/a",
      readMirrors: ["/root/b", "/root/c"],
    });
    const denyIdx = p.indexOf("(deny file-read*");
    const bIdx = p.indexOf('(allow file-read* (subpath "/root/b"))');
    const cIdx = p.indexOf('(allow file-read* (subpath "/root/c"))');
    assert.ok(denyIdx >= 0 && bIdx > denyIdx && cIdx > denyIdx, "read-allows must come after deny");
  });

  it("still grants home rw and works with an empty readMirrors", () => {
    const p = buildSeatbeltProfile({ portuniRoot: "/root", homeMirror: "/root/a", readMirrors: [] });
    assert.match(p, /\(allow file-read\* file-write\* \(subpath "\/root\/a"\)\)/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`readMirrors` not on the type / not emitted).
  Run: `node --import tsx --test test/sandbox-profile.test.ts`

- [ ] **Step 3: Implement**

Extend the type and the emitter in `apps/server/domain/sandbox-profile.ts`:

```ts
export interface SandboxScope {
  portuniRoot: string;
  homeMirror: string;
  // Real mirror roots (home's in-scope neighbours) granted read-only. Named
  // as REAL paths because Seatbelt matches realpaths; must be emitted AFTER
  // the PORTUNI_ROOT deny so the re-allow wins (SBPL: later rule wins).
  readMirrors: string[];
}

export function buildSeatbeltProfile(scope: SandboxScope): string {
  const home = normalize(scope.homeMirror);
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* file-write* (subpath ${sbQuote(normalize(scope.portuniRoot))}))`,
    `(allow file-read-metadata (subpath ${sbQuote(normalize(scope.portuniRoot))}))`,
  ];
  for (const m of scope.readMirrors) {
    lines.push(`(allow file-read* (subpath ${sbQuote(normalize(m))}))`);
  }
  lines.push(`(allow file-read* file-write* (subpath ${sbQuote(home)}))`);
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** `feat(scope): seatbelt can grant read on in-scope real mirror roots`.

### Task 2: `resolveSandboxScopeForNode` computes the depth-1 read grant set

**Files:**
- Modify: `apps/server/domain/sandbox-profile.ts` (`resolveSandboxScopeForNode` — now uses `db`)
- Modify: `apps/server/domain/sandbox-profile.ts` (`resolveSandboxScopeForCwd` — pass `readMirrors: []` or the same computation)
- Test: `test/sandbox-profile-neighbors.test.ts`

**Interfaces:**
- Consumes: the depth-1 neighbour query shape from `seedScopeFromHome` (`apps/server/mcp/scope.ts`); `getMirrorPath(userId, nodeId)`.
- Produces: `resolveSandboxScopeForNode` returns `SandboxScope` with `readMirrors` = the real mirror roots of the home node's depth-1 neighbours that (a) are visible and (b) have a local mirror. Nodes without a local mirror are simply omitted (no grant, no error).

- [ ] **Step 1: Write the failing test** — seed two nodes with an edge, register mirrors for both, assert `resolveSandboxScopeForNode(db, user, home)` returns `readMirrors` containing the neighbour's real mirror path and NOT the home's.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — replace `_db` with `db`; run the same neighbour SELECT as `seedScopeFromHome` (extract a shared `neighbourIds(db, homeNodeId)` helper in `scope.ts` and import it, to keep the depth-1 definition in ONE place — DRY), map visible neighbours through `getMirrorPath`, drop nulls, set `readMirrors`. `resolveSandboxScopeForCwd` resolves the home node id from the cwd first, then reuses the same path.

- [ ] **Step 4: Run — expect PASS.** Also run the existing `sandbox-profile`-touching tests.
- [ ] **Step 5: Commit** `feat(scope): grant depth-1 neighbour mirrors in the sandbox profile`.

### Task 3: read tools return the REAL mirror for granted (spawn-set) nodes; reconciler skips them

**Files:**
- Modify: `apps/server/mcp/scope.ts` (mark seed-added vs expand-added nodes)
- Modify: `apps/server/mcp/scope-reconciler.ts` (`readableMirrorRoot` returns real for seed-set; `reconcileNode`/`schedule` no-op for seed-set)
- Test: `test/scope-reconciler.test.ts` (extend)

**Interfaces:**
- Produces: `SessionScope` distinguishes `seedSet` (home + depth-1, granted real paths) from expand-added ids. `readableMirrorRoot({scope,nodeId,homeMirror,realMirror})` returns `realMirror` when `nodeId ∈ seedSet` (or is home), else the staged path (Phase-1 fallback for ad-hoc). The reconciler does not stage seed-set nodes.

- [ ] **Step 1: Write the failing test** — a node in the seed set resolves via `readableMirrorRoot` to its REAL mirror (not `<home>/.portuni-scope/<id>`), and `reconcileNode` returns null (nothing staged) for it; an expand-added node still resolves to the staged path.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — add `seedSet: Set<string>` to `SessionScope`, populated by `seedScopeFromHome` (home + depth-1); `readableMirrorRoot` returns `realMirror` for `nodeId ∈ seedSet || nodeId === homeNodeId`; `createScopeReconciler.doReconcile` returns null early when `scope.seedSet.has(nodeId)`. Keep staging for non-seed (ad-hoc) nodes untouched.

- [ ] **Step 4: Run — expect PASS.** Run `get-node` / `context` / `files` tool tests — their `local_path` for depth-1 neighbours flips from a `.portuni-scope` path to the real mirror; update those assertions.
- [ ] **Step 5: Commit** `feat(scope): serve real mirror paths for the spawn-set, skip staging them`.

### Task 4: end-to-end verification (local mode)

- [ ] **Step 1:** Build server (`npm run build`) + full suite (`npm test`) green.
- [ ] **Step 2:** In a real mirror, spawn a terminal (or reproduce via the sandbox-profile endpoint): confirm the emitted `.sb` profile contains `(allow file-read* (subpath <neighbour real mirror>))` for a depth-1 neighbour, and that `get_node`/`list_files` for that neighbour return its REAL path.
- [ ] **Step 3:** Confirm a depth-1 neighbour's file, edited on its real mirror, is seen live by a session homed elsewhere (no stale copy); confirm no `.portuni-scope/<neighbour>` dir is created for seed-set nodes.
- [ ] **Step 4:** Confirm a deeper `expand_scope` node still works via staging (no regression).

---

## Phase 2 (sketch — separate plan when Phase 1 lands)

- Add `portuni_read_file(node_id, path)` + optionally `portuni_grep(node_id, pattern)` — scope-enforced, read-only, universal (any MCP client). Returns content only for in-scope nodes.
- For ad-hoc (non-seed) nodes, read tools return `local_path: null` and a hint to use `portuni_read_file`; the model reads ad-hoc content through the tool, native FS only for the seed set.
- Delete `scope-reconciler.ts` staging, `scope-staging.ts`, `.portuni-scope` handling, the `readableMirrorRoot` staged branch, and the reconciler wiring in `mcp/server.ts`. `expand_scope` stops awaiting staging.

## Phase 3 (sketch)

- Central mode: the sidecar's sandbox-profile handler (`agent-router.ts`, today `NO_DB`) computes the depth-1 grant set from central (CentralClient neighbour lookup or a central endpoint), so central-mode terminals get the same real-path grants.
- Front door (`agent-transport.ts`): extend the existing enrichment so proxied `get_node`/`get_context`/`list_files` return real `local_path` for the granted set in central mode (supersedes the interim home-only enrichment already shipped).

## Self-Review

- Covers the locked decision: related=native real paths (Tasks 1-3), ad-hoc=untouched staging in Phase 1 then server-mediated in Phase 2. ✓
- No hooks anywhere; enforcement is Seatbelt (kernel) + MCP scope (server). Universal. ✓
- Fail-closed preserved: empty `readMirrors` ⇒ today's home-only profile (Task 1 test). ✓
- DRY: depth-1 definition shared between `seedScopeFromHome` and `resolveSandboxScopeForNode` (Task 2). ✓
- Type consistency: `SandboxScope.readMirrors` defined Task 1, produced Task 2, consumed by `buildSeatbeltProfile`; `seedSet` defined/consumed Task 3.
