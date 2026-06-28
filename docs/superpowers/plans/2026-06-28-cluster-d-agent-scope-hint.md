# Cluster D — Agent Scope Hint Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the materialized agent instructions tell the agent (a) which data sources the node has and (b) where to save files, so agents stop ignoring sources and stop writing to the mirror root.

**Architecture:** Three pure builder/threading changes plus two caller fetches. `buildSoftHint` (the single body of `PORTUNI_SCOPE.md`, `.cursor/rules`, and the `CLAUDE.md`/`AGENTS.md` marker block) gains a `dataSources` parameter and two new sections. `materializeScopeConfig` threads that parameter through. The two callers that drive materialization (`materializeAllRegisteredMirrors` at sidecar boot, `materializeAndRegen` on mirror create) fetch the node's data sources best-effort and pass them in. No write-scope enforcement changes.

**Tech Stack:** TypeScript (Node, NodeNext ESM with `.js` import specifiers), libSQL/Turso, `node --test` via `tsx`, Zod row types.

## Global Constraints

- **Soft-hint only.** Do NOT change write-scope enforcement: `buildClaudeSettings` allow-globs stay `<mirror>/**`. The mirror root must remain writable (`CLAUDE.md`, `.mcp.json`, `PORTUNI_SCOPE.md`, `.claude/` live there).
- **`buildSoftHint` and `materializeScopeConfig` stay pure** (no DB handle inside them). Data sources are fetched by the caller and passed in as data.
- **Data-source fetch is best-effort.** A read failure must never block config materialization — degrade to an empty list.
- **No emoji in code or generated content.** Em-dash (`—`) is fine and matches existing hint style.
- **Generated hint text is English**, matching the existing hint.
- **Hint stays concise** (server INSTRUCTIONS budget ~2 KB): list each source as `name — link (description)`, never a full object dump.
- Build: `npm run build`. Test: `npm test`. Single file: `node --import tsx --test test/<file>.test.ts`. Full gate: `npm run qa` (lint:strict + typecheck + test + build).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/domain/write-scope.ts` | Pure builders for materialized agent config | Extend `buildSoftHint` signature + body (Task 1); import `DataSourceRow` type |
| `src/domain/scope-materialize.ts` | Write per-harness config into a mirror | Add `MaterializeArgs.dataSources` + pass to `buildSoftHint` (Task 2); add `dataSourcesForNode` helper + fetch in `materializeAllRegisteredMirrors` (Task 3) |
| `src/domain/sync/mirror-create.ts` | Create mirror + regenerate all configs | Fetch data sources at both `materializeScopeConfig` call sites in `materializeAndRegen` (Task 3) |
| `test/write-scope.test.ts` | Unit tests for builders + `materializeScopeConfig` | Add `buildSoftHint` + `materializeScopeConfig` cases (Tasks 1, 2) |
| `test/mcp-rematerialize-on-boot.test.ts` | Boot integration test | Add data-source-surfacing case (Task 3) |

---

### Task 1: Extend `buildSoftHint` with save-location + data-sources sections

**Files:**
- Modify: `src/domain/write-scope.ts` (add type import near top; replace `buildSoftHint` at ~line 443-465)
- Test: `test/write-scope.test.ts` (extend the `describe("buildSoftHint", ...)` block at ~line 385-392)

**Interfaces:**
- Produces: `buildSoftHint(args: { currentMirror: string; portuniRoot: string; dataSources?: readonly DataSourceRow[] }): string`. `DataSourceRow` is `{ id, node_id, name, description: string|null, external_link: string|null, created_at, updated_at }` from `src/shared/types.ts`.

- [ ] **Step 1: Write the failing tests**

In `test/write-scope.test.ts`, replace the existing `describe("buildSoftHint", ...)` block with:

```ts
describe("buildSoftHint", () => {
  it("references both PORTUNI_ROOT and the mirror path", () => {
    const hint = buildSoftHint({ currentMirror: "/r/a", portuniRoot: "/r" });
    assert.match(hint, /\/r\/a/);
    assert.match(hint, /\/r/);
    assert.match(hint, /Portuni write scope/);
  });

  it("tells the agent to save into wip/outputs/resources, not the mirror root", () => {
    const hint = buildSoftHint({ currentMirror: "/r/a", portuniRoot: "/r" });
    assert.match(hint, /Where to save files/);
    assert.match(hint, /`wip\/`/);
    assert.match(hint, /`outputs\/`/);
    assert.match(hint, /`resources\/`/);
    assert.match(hint, /mirror root is reserved/i);
  });

  it("lists registered data sources when provided", () => {
    const hint = buildSoftHint({
      currentMirror: "/r/a",
      portuniRoot: "/r",
      dataSources: [
        {
          id: "D1",
          node_id: "N1",
          name: "Acme CRM",
          description: "deal pipeline",
          external_link: "https://crm.example.com",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    assert.match(hint, /Portuni data sources/);
    assert.match(hint, /Acme CRM/);
    assert.match(hint, /https:\/\/crm\.example\.com/);
    assert.match(hint, /deal pipeline/);
    assert.match(hint, /portuni_list_data_sources/);
  });

  it("falls back to a list-data-sources instruction when none are provided", () => {
    const hint = buildSoftHint({ currentMirror: "/r/a", portuniRoot: "/r" });
    assert.match(hint, /Portuni data sources/);
    assert.match(hint, /portuni_list_data_sources/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test --test-name-pattern "buildSoftHint" test/write-scope.test.ts`
Expected: FAIL — the two new assertions (`Where to save files`, `Portuni data sources`) do not match; the `dataSources` property is also a TypeScript error (excess property) until Step 3.

- [ ] **Step 3: Add the type import**

At the top of `src/domain/write-scope.ts`, after the existing `node:*` imports (after line 19), add:

```ts
import type { DataSourceRow } from "../shared/types.js";
```

- [ ] **Step 4: Replace `buildSoftHint`**

Replace the entire `buildSoftHint` function (currently `src/domain/write-scope.ts:443-465`) with:

```ts
// Soft-hint paragraph that gets appended to CLAUDE.md / AGENTS.md / .cursor/rules.
export function buildSoftHint(args: {
  currentMirror: string;
  portuniRoot: string;
  dataSources?: readonly DataSourceRow[];
}): string {
  const mirror = normalize(args.currentMirror);
  const sources = args.dataSources ?? [];
  const lines: string[] = [
    "## Portuni write scope",
    "",
    `This mirror (\`${mirror}\`) is your workspace.`,
    "Other mirror paths that appear in Portuni context are READ-ONLY references.",
    "Editing files in those siblings is out of scope for this session — ask the user first.",
    `Paths outside PORTUNI_ROOT (\`${normalize(args.portuniRoot)}\`) require explicit user approval for every write.`,
    "",
    "## Where to save files",
    "",
    "New files belong in one of this mirror's section folders, never the mirror root:",
    "- `wip/` — work in progress: drafts, scratch notes, intermediate research.",
    "- `outputs/` — finished, shareable deliverables.",
    "- `resources/` — reference material you were given or pulled in.",
    "The mirror root is reserved for Portuni-managed files (`PORTUNI_SCOPE.md`, `.mcp.json`, `CLAUDE.md`, `.claude/`). Do not place working files at the mirror root.",
    "",
    "## Portuni data sources",
    "",
  ];
  if (sources.length > 0) {
    lines.push("This node has registered data sources. Consult them before researching elsewhere:");
    for (const s of sources) {
      const link = s.external_link ? ` — ${s.external_link}` : "";
      const desc = s.description ? ` (${s.description})` : "";
      lines.push(`- ${s.name}${link}${desc}`);
    }
    lines.push("Call `portuni_list_data_sources` for the authoritative, current list.");
  } else {
    lines.push(
      "Call `portuni_list_data_sources` (or `portuni_get_context`) to see where this node gets its information before researching elsewhere.",
    );
  }
  lines.push(
    "",
    "## Portuni file registration",
    "",
    "When you create a new file inside this mirror's `wip/`, `outputs/`, or `resources/` via `Write`, `Edit`, `MultiEdit`, or shell `cp`/`mv`, your next action MUST be `portuni_store` with that path.",
    "`Write` alone places bytes on disk but does not create a `files` row in Portuni — the next session, the routed remote, and teammates will not see the file.",
    "Treat \"create file in mirror\" and \"call `portuni_store`\" as a single atomic step. Do not defer registration to the end-of-turn `portuni_status` drift check — that check is a safety net, not the primary path.",
    "If `portuni_status` returns `new_local` for a file you just created, you forgot this rule — register it via `portuni_store` immediately.",
    "For files that appeared from elsewhere (`new_remote` from `portuni_status`, or `new_local` left over from a prior session you didn't author), use `portuni_adopt_files` or `portuni_store` respectively.",
    "",
  );
  return lines.join("\n");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --import tsx --test --test-name-pattern "buildSoftHint" test/write-scope.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full write-scope suite (no regressions)**

Run: `node --import tsx --test test/write-scope.test.ts`
Expected: PASS. In particular `materializeScopeConfig > writes settings.local.json, codex toml, and PORTUNI_SCOPE.md` still passes (it asserts `/Portuni write scope/`, which remains).

- [ ] **Step 7: Commit**

```bash
git add src/domain/write-scope.ts test/write-scope.test.ts
git commit -m "feat(scope): buildSoftHint surfaces data sources + save-location guidance" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Thread `dataSources` through `materializeScopeConfig`

**Files:**
- Modify: `src/domain/scope-materialize.ts` (add type import; add `dataSources` to `MaterializeArgs` at ~line 49-69; pass it in the `buildSoftHint` call at ~line 271-274)
- Test: `test/write-scope.test.ts` (add one case to the `describe("materializeScopeConfig", ...)` block)

**Interfaces:**
- Consumes: `buildSoftHint({ currentMirror, portuniRoot, dataSources })` from Task 1.
- Produces: `MaterializeArgs.dataSources?: readonly DataSourceRow[]` — optional, defaults to "no sources listed".

- [ ] **Step 1: Write the failing test**

In `test/write-scope.test.ts`, inside `describe("materializeScopeConfig", ...)`, add:

```ts
it("surfaces provided data sources in PORTUNI_SCOPE.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portuni-scope-ds-"));
  const cur = join(dir, "a");
  await mkdir(cur, { recursive: true });

  await materializeScopeConfig({
    currentMirror: cur,
    otherMirrors: [],
    portuniRoot: dir,
    dataSources: [
      {
        id: "D1",
        node_id: "N1",
        name: "Acme CRM",
        description: null,
        external_link: "https://crm.example.com",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
  });

  const scope = await readFile(join(cur, "PORTUNI_SCOPE.md"), "utf8");
  assert.match(scope, /Acme CRM/);
  assert.match(scope, /https:\/\/crm\.example\.com/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test --test-name-pattern "surfaces provided data sources" test/write-scope.test.ts`
Expected: FAIL — `dataSources` is an excess property on `MaterializeArgs` (TS error) and the source name is absent from `PORTUNI_SCOPE.md`.

- [ ] **Step 3: Add the type import**

At the top of `src/domain/scope-materialize.ts`, after the existing imports (after line 44), add:

```ts
import type { DataSourceRow } from "../shared/types.js";
```

- [ ] **Step 4: Add `dataSources` to `MaterializeArgs`**

In `src/domain/scope-materialize.ts`, inside the `MaterializeArgs` interface (ends at line 69), add this field before the closing brace:

```ts
  // The node's registered data sources, surfaced in the soft hint so the
  // agent knows where the node gets its information. Caller-fetched and
  // passed in (keeps this module DB-free and pure). Omit/empty -> the hint
  // falls back to a "call portuni_list_data_sources" instruction.
  dataSources?: readonly DataSourceRow[];
```

- [ ] **Step 5: Pass `dataSources` into `buildSoftHint`**

In `materializeScopeConfig`, replace the `buildSoftHint` call (currently lines 271-274):

```ts
  const hint = buildSoftHint({
    currentMirror: cur,
    portuniRoot: args.portuniRoot,
  });
```

with:

```ts
  const hint = buildSoftHint({
    currentMirror: cur,
    portuniRoot: args.portuniRoot,
    dataSources: args.dataSources,
  });
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --import tsx --test --test-name-pattern "surfaces provided data sources" test/write-scope.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full write-scope suite**

Run: `node --import tsx --test test/write-scope.test.ts`
Expected: PASS (all existing `materializeScopeConfig` cases still green — they pass no `dataSources`, so the hint uses the fallback line).

- [ ] **Step 8: Commit**

```bash
git add src/domain/scope-materialize.ts test/write-scope.test.ts
git commit -m "feat(scope): thread dataSources through materializeScopeConfig" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fetch data sources in the materialization callers

**Files:**
- Modify: `src/domain/scope-materialize.ts` (add imports; add `dataSourcesForNode` helper; fetch in `materializeAllRegisteredMirrors` at ~line 322-341)
- Modify: `src/domain/sync/mirror-create.ts` (import helper; fetch at both `materializeScopeConfig` call sites in `materializeAndRegen` at ~line 127-150)
- Test: `test/mcp-rematerialize-on-boot.test.ts` (add imports; reset `setDbForTesting` in `afterEach`; add a data-source case)

**Interfaces:**
- Consumes: `listDataSources(db, nodeId): Promise<DataSourceRow[]>` from `src/domain/entity-attributes.ts`; `getDb(): Client` from `src/infra/db.ts`; `MaterializeArgs.dataSources` from Task 2.
- Produces: `dataSourcesForNode(nodeId: string | null | undefined): Promise<DataSourceRow[]>` — exported from `scope-materialize.ts`, best-effort (returns `[]` on any error or null id).

- [ ] **Step 1: Write the failing integration test**

In `test/mcp-rematerialize-on-boot.test.ts`:

First, add to the imports (after line 16):

```ts
import { setDbForTesting } from "../src/infra/db.js";
import { addDataSource } from "../src/domain/entity-attributes.js";
```

Then add `setDbForTesting(null);` to `afterEach`, so the override never leaks between tests. The block becomes:

```ts
afterEach(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
  if (originalUrl === undefined) delete process.env.PORTUNI_URL;
  else process.env.PORTUNI_URL = originalUrl;
  await rm(workspace, { recursive: true, force: true });
});
```

Then add this test inside `describe("materializeAllRegisteredMirrors", ...)`:

```ts
it("lists the node's registered data sources in the soft hint", async () => {
  const shared = await makeSharedDb();
  setDbForTesting(shared.db);
  await addDataSource(shared.db, "U1", {
    node_id: shared.nodeId,
    name: "Acme CRM",
    external_link: "https://crm.example.com",
  });
  const mirror = join(workspace, "mirror-ds");
  await mkdir(mirror, { recursive: true });
  await registerMirror(SOLO_USER, shared.nodeId, mirror);

  await materializeAllRegisteredMirrors();

  const scope = await readFile(join(mirror, "PORTUNI_SCOPE.md"), "utf8");
  assert.match(scope, /Acme CRM/);
  assert.match(scope, /https:\/\/crm\.example\.com/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test --test-name-pattern "lists the node's registered data sources" test/mcp-rematerialize-on-boot.test.ts`
Expected: FAIL — `materializeAllRegisteredMirrors` does not yet fetch data sources, so `PORTUNI_SCOPE.md` shows the fallback line, not "Acme CRM".

- [ ] **Step 3: Add imports + helper in `scope-materialize.ts`**

At the top of `src/domain/scope-materialize.ts`, add to the imports (after the `DataSourceRow` import from Task 2):

```ts
import { getDb } from "../infra/db.js";
import { listDataSources } from "./entity-attributes.js";
```

Then, just above `export async function materializeAllRegisteredMirrors` (line 307), add the helper:

```ts
// Best-effort fetch of a node's data sources for the soft hint. A read
// failure (DB unreachable, no such node) must never block config
// materialization, so we degrade to an empty list rather than throwing.
export async function dataSourcesForNode(
  nodeId: string | null | undefined,
): Promise<DataSourceRow[]> {
  if (!nodeId) return [];
  try {
    return await listDataSources(getDb(), nodeId);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Fetch in `materializeAllRegisteredMirrors`**

In `materializeAllRegisteredMirrors`, inside the `for (const m of mirrors)` loop, replace the `materializeScopeConfig` call (currently lines 325-332):

```ts
      const r = await materializeScopeConfig({
        currentMirror: m.local_path,
        nodeId: m.node_id,
        mcpUrl,
        otherMirrors: others,
        portuniRoot,
        guardScriptPath,
      });
```

with:

```ts
      const dataSources = await dataSourcesForNode(m.node_id);
      const r = await materializeScopeConfig({
        currentMirror: m.local_path,
        nodeId: m.node_id,
        mcpUrl,
        otherMirrors: others,
        portuniRoot,
        guardScriptPath,
        dataSources,
      });
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `node --import tsx --test --test-name-pattern "lists the node's registered data sources" test/mcp-rematerialize-on-boot.test.ts`
Expected: PASS.

- [ ] **Step 6: Fetch in `materializeAndRegen` (mirror-create.ts)**

In `src/domain/sync/mirror-create.ts`, add to the imports (next to the existing `materializeScopeConfig` import at line 36):

```ts
import { dataSourcesForNode } from "../scope-materialize.js";
```

In `materializeAndRegen`, replace the loop call site (currently lines 129-135):

```ts
    const r = await materializeScopeConfig({
      currentMirror: m.local_path,
      nodeId: m.node_id,
      otherMirrors: others,
      portuniRoot,
      guardScriptPath,
    });
```

with:

```ts
    const r = await materializeScopeConfig({
      currentMirror: m.local_path,
      nodeId: m.node_id,
      otherMirrors: others,
      portuniRoot,
      guardScriptPath,
      dataSources: await dataSourcesForNode(m.node_id),
    });
```

Then replace the new-node call site (currently lines 141-147):

```ts
    const r = await materializeScopeConfig({
      currentMirror: newMirrorPath,
      nodeId: newNodeId,
      otherMirrors: others,
      portuniRoot,
      guardScriptPath,
    });
```

with:

```ts
    const r = await materializeScopeConfig({
      currentMirror: newMirrorPath,
      nodeId: newNodeId,
      otherMirrors: others,
      portuniRoot,
      guardScriptPath,
      dataSources: await dataSourcesForNode(newNodeId),
    });
```

- [ ] **Step 7: Run the full boot suite + typecheck (no regressions)**

Run: `node --import tsx --test test/mcp-rematerialize-on-boot.test.ts`
Expected: PASS — including the existing cases. (They never call `setDbForTesting`, so `dataSourcesForNode` hits `getDb()` with no test DB, throws internally, and degrades to `[]`; the hint falls back and those assertions, which only check write-scope text + mirror path, still pass.)

Run: `npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 8: Commit**

```bash
git add src/domain/scope-materialize.ts src/domain/sync/mirror-create.ts test/mcp-rematerialize-on-boot.test.ts
git commit -m "feat(scope): fetch node data sources when materializing mirror config" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full gate + on-device verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full QA gate**

Run: `npm run qa`
Expected: PASS — `lint:strict`, `typecheck`, all tests, and `build` all green. (This is the same gate the pre-push hook runs.)

- [ ] **Step 2: Rebuild and restart the sidecar so mirrors re-materialize**

The new hint reaches existing mirrors only when `materializeAllRegisteredMirrors` runs at sidecar boot.

Run:
```bash
npm run build
tmux send-keys -t portuni-mcp C-c Up Enter
```
Expected: the server restarts; `/tmp/portuni-mcp.log` shows a clean boot with no materialization errors.

- [ ] **Step 3: Verify the new sections landed in a real mirror**

Run (uses the configured workspace root; falls back to a recursive search):
```bash
grep -rl "Where to save files" "${PORTUNI_WORKSPACE_ROOT:-$HOME}" --include=PORTUNI_SCOPE.md | head
```
Expected: at least one `PORTUNI_SCOPE.md` path. Open one and confirm it contains the `## Where to save files` and `## Portuni data sources` sections. For a node that has data sources registered (check with `portuni_list_data_sources`), confirm they are listed by name + link.

- [ ] **Step 4: Smoke the agent loop (manual)**

In Portuni.app (or `portuni.test`), open a node that has at least one data source and at least one `wip/outputs/resources` folder, launch a terminal (Claude/Codex/Vibe), and confirm in the session that the agent's context/`PORTUNI_SCOPE.md` now names the data sources and the save-location rule. (No assertion to automate here — this is the end-to-end confirmation the materialized instructions reach the agent.)

---

## Self-Review

**Spec coverage (against `2026-06-28-ux-bugfix-batch-design.md`, Cluster D):**
- Úkol 4 (agent doesn't look at sources): Task 1 (data-sources section) + Tasks 2-3 (thread + fetch). ✓
- Úkol 5 (agent saves outside folders): Task 1 (save-location section). ✓
- "Soft hint only, no enforcement change": Global Constraints + no edit to `buildClaudeSettings`. ✓
- "Thread `data_sources` into `materializeScopeConfig`, keep it pure": Tasks 2-3, caller-fetched. ✓
- "Re-materialize on restart": Task 4 Step 2. ✓
- "Hint budget / concise listing": Global Constraints + `name — link (description)` format. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every run step shows the command + expected result. ✓

**Type consistency:** `buildSoftHint(args.dataSources)` ← `MaterializeArgs.dataSources` ← `dataSourcesForNode()` ← `listDataSources(getDb(), nodeId)`, all typed `readonly DataSourceRow[]` / `DataSourceRow[]`. `dataSourcesForNode` name identical in scope-materialize.ts (definition) and mirror-create.ts (import). ✓
