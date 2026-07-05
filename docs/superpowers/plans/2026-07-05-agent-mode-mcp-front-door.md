# Agent-Mode MCP Front Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP sessions on a device with mirrors connect to the local
agent sidecar, which executes device-local tools (mirror, store, status,
pull, adopt) against the local disk and transparently proxies every
other tool to the central server; the central server answers device-local
tools with a clear "device-local operation" error instead of a
confusing env-var message.

**Architecture:** The agent sidecar (`agentMain` in
`apps/server/desktop.ts`, `PORTUNI_AGENT_MODE=1`) today serves REST only
(`mountMcp: false`). We add an MCP transport that, per local session,
opens an upstream MCP client session to `${PORTUNI_CENTRAL_URL}/mcp`
(device token, forwarded `home_node_id`) and routes JSON-RPC at the
tools/resources level: `tools/call` for a fixed `LOCAL_TOOLS` set runs
local handlers backed by the existing central-aware domain layer
(`apps/server/domain/sync/central/engine-central.ts`); everything else
passes through. This mirrors the split the desktop webview already does
(`is_local_only_path` in `apps/desktop/src/lib.rs` → agent REST vs
`central_request`).

**Tech Stack:** TypeScript (Node 20, ESM, `.js` import suffixes),
`@modelcontextprotocol/sdk` (already a dependency: server + client +
`StreamableHTTPClientTransport`), `node --import tsx --test` for tests
(existing pattern in `test/*.test.ts`), zod for tool schemas.

## Global Constraints

- No secrets in materialized configs — tokens are referenced via env
  vars (`PORTUNI_MCP_TOKEN`/`PORTUNI_MCP_TOKEN_<ID>`), never literals
  (existing rule in `apps/server/domain/scope-materialize.ts`).
- The agent has **no graph DB** — nothing in agent-mode code may call
  `getDb()`; graph facts come from `CentralClient` only.
- Follow existing code style: comments explain constraints, not
  narration; no emoji; conventional commits.
- `npm run build` (tsc) must stay green after every task; full QA gate
  is `npm run qa` (runs on pre-push).
- All new HTTP surface stays loopback-only behind the existing
  env-token gate — no new auth schemes.

## Out of scope (documented follow-ups, do NOT implement)

- `portuni_move_file`, `portuni_rename_folder`, `portuni_delete_file`,
  `portuni_snapshot` in agent mode: they need central variants of
  registry mutations that do not exist yet. They stay proxied to
  central, where they fail with the Task-1 device-local error. Note them
  in the plan's final docs task.
- Scope disk projection (`.portuni-scope/` copies via ScopeReconciler)
  for agent-mode sessions — scope lives in the upstream session; the
  local projection needs a central-backed reconciler. Follow-up spec.
- Claude Desktop / claude.ai remote clients: unchanged, they keep
  connecting to central directly.

---

### Task 1: Device-local error message on the central server

**Files:**
- Modify: `apps/server/domain/sync/mirror-create.ts` (the
  `WORKSPACE_ROOT_UNSET` throw, ~line 239)
- Test: `test/mirror-create.test.ts` (extend existing file if present;
  otherwise create)

**Interfaces:**
- Produces: exported const `DEVICE_LOCAL_HINT` from
  `apps/server/domain/sync/mirror-create.ts`:
  `export const DEVICE_LOCAL_HINT = "this is a device-local operation: this server has no local file plane. Run it via the Portuni desktop app (or its local agent MCP) on the device that owns the mirror."`

- [ ] **Step 1: Write the failing test**

```typescript
// test/mirror-create.test.ts (add)
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_LOCAL_HINT } from "../apps/server/domain/sync/mirror-create.js";

test("WORKSPACE_ROOT_UNSET error carries the device-local hint", async () => {
  const prev = process.env.PORTUNI_WORKSPACE_ROOT;
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  try {
    const { createMirrorForNode, MirrorCreateError } = await import(
      "../apps/server/domain/sync/mirror-create.js"
    );
    // db/userId shape: reuse the harness used by existing mirror tests in
    // this file; the call must reach the workspace-root check, i.e. use a
    // node id that exists in the test db.
    await assert.rejects(
      () => createMirrorForNode(testDb, TEST_USER, { nodeId: existingNodeId }),
      (e: unknown) =>
        e instanceof MirrorCreateError &&
        e.code === "WORKSPACE_ROOT_UNSET" &&
        e.message.includes("device-local operation"),
    );
  } finally {
    if (prev !== undefined) process.env.PORTUNI_WORKSPACE_ROOT = prev;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/mirror-create.test.ts`
Expected: FAIL (message does not include "device-local operation")

- [ ] **Step 3: Implement**

```typescript
// mirror-create.ts — replace the existing throw
export const DEVICE_LOCAL_HINT =
  "this is a device-local operation: this server has no local file plane. " +
  "Run it via the Portuni desktop app (or its local agent MCP) on the device that owns the mirror.";

  const root = process.env.PORTUNI_WORKSPACE_ROOT?.replace(/^~/, homedir());
  if (!root) {
    throw new MirrorCreateError(
      `PORTUNI_WORKSPACE_ROOT is not set — ${DEVICE_LOCAL_HINT}`,
      "WORKSPACE_ROOT_UNSET",
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/mirror-create.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/domain/sync/mirror-create.ts test/mirror-create.test.ts
git commit -m "fix(mcp): device-local hint when workspace root is missing"
```

---

### Task 2: LOCAL_TOOLS registry + agent tool handlers (domain wiring)

**Files:**
- Create: `apps/server/mcp/agent-tools.ts`
- Test: `test/agent-tools.test.ts`

**Interfaces:**
- Consumes: `CentralClient` (`apps/server/domain/sync/central/client.ts`),
  `createMirrorForNodeCentral`, `statusScanCentral`, `syncRunCentral`,
  `pullFileCentral`, `registerLocalFileCentral`,
  `listUntrackedLocalCentral` (`engine-central.ts`).
- Produces:
  - `export const LOCAL_TOOLS: ReadonlySet<string>` — exactly
    `new Set(["portuni_mirror", "portuni_status", "portuni_store", "portuni_pull", "portuni_adopt_files"])`
  - `export function callLocalTool(client: CentralClient, userId: string, name: string, args: Record<string, unknown>): Promise<{ content: Array<{type: "text"; text: string}>; isError?: boolean }>`

Handler mapping (each returns the same JSON payload shape as the
corresponding tool in `apps/server/mcp/tools/*.ts` so callers cannot
tell which plane served it):

| tool | implementation |
|---|---|
| `portuni_mirror` | `createMirrorForNodeCentral(client, userId, { nodeId: args.node_id, customPath: args.custom_path })` |
| `portuni_status` | `statusScanCentral(client, { userId, nodeId: args.node_id, includeDiscovery: true, fast: false })` |
| `portuni_store` | resolve the file's registry entry via `client.syncInfo(node_id)`, then `reconcilePathCentral(client, ...)` for the path; if the file is unregistered, `registerLocalFileCentral` first, then push (mirror the local `portuni_store` semantics in `apps/server/mcp/tools/files.ts:26`) |
| `portuni_pull` | `pullFileCentral(client, { userId, fileId: args.file_id, force: args.force })` |
| `portuni_adopt_files` | `listUntrackedLocalCentral` + `registerLocalFileCentral` per entry (mirror `portuni_adopt_files` in `files.ts:277`) |

Unknown name → throw `new Error(\`not a local tool: \${name}\`)` (caller
bug, not a user error).

- [ ] **Step 1: Write the failing test** — use a fake `CentralClient`
  (plain object implementing only the methods the handler under test
  calls; existing tests build fakes the same way — see
  `test/*central*.test.ts` for the pattern):

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCAL_TOOLS, callLocalTool } from "../apps/server/mcp/agent-tools.js";

test("LOCAL_TOOLS contains exactly the device-local set", () => {
  assert.deepEqual(
    [...LOCAL_TOOLS].sort(),
    ["portuni_adopt_files", "portuni_mirror", "portuni_pull", "portuni_status", "portuni_store"],
  );
});

test("callLocalTool rejects non-local names", async () => {
  await assert.rejects(
    () => callLocalTool({} as never, "u1", "portuni_get_node", {}),
    /not a local tool/,
  );
});

test("portuni_mirror returns the REST-shaped payload", async () => {
  const fake = {
    /* only what createMirrorForNodeCentral touches — copy the fake from
       the existing engine-central tests */
  };
  const r = await callLocalTool(fake as never, "u1", "portuni_mirror", {
    node_id: "01TESTNODE0000000000000000",
    targets: ["local"],
  });
  const payload = JSON.parse(r.content[0].text);
  assert.ok("local_path" in payload && "subdirs" in payload);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/agent-tools.test.ts`
Expected: FAIL with "Cannot find module .../agent-tools.js"

- [ ] **Step 3: Implement `apps/server/mcp/agent-tools.ts`** — a
  dispatch table `Record<string, (client, userId, args) => Promise<unknown>>`,
  each entry calling the engine-central function per the mapping table,
  JSON-stringifying the result into MCP `content`. Wrap
  `MirrorCreateError` and `CentralHttpError` into
  `{ content: [{type:"text", text: "Error: ..."}], isError: true }` the
  same way `tools/mirrors.ts` does.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/agent-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/mcp/agent-tools.ts test/agent-tools.test.ts
git commit -m "feat(agent): device-local MCP tool handlers over engine-central"
```

---

### Task 3: MCP proxy transport for agent mode

**Files:**
- Create: `apps/server/mcp/agent-transport.ts`
- Test: `test/agent-transport.test.ts`

**Interfaces:**
- Consumes: `LOCAL_TOOLS`, `callLocalTool` (Task 2); `CentralClient`
  for local handlers; `@modelcontextprotocol/sdk/client/index.js`
  (`Client`) + `@modelcontextprotocol/sdk/client/streamableHttp.js`
  (`StreamableHTTPClientTransport`).
- Produces: `export function createAgentMcpTransport(opts: { client: CentralClient; centralUrl: string; centralToken: string }): McpTransport`
  — same `McpTransport` interface as `apps/server/mcp/transport.ts`
  (`handle(req, res, identity)`, `shutdown()`), so `startHttpServer` can
  mount it interchangeably.

Design (keep in a header comment):
- Per local MCP session, lazily open ONE upstream `Client` connected to
  `${centralUrl}/mcp` with header `Authorization: Bearer ${centralToken}`.
  Forward the local connection's `?home_node_id=...` query param onto
  the upstream URL so central auto-seeds scope exactly as today.
- Serve the local side with the low-level SDK `Server` (not `McpServer`)
  and explicit request handlers:
  - `initialize`: local server info (`{name: "portuni-agent", version}`),
    reuse the `INSTRUCTIONS` string exported from `mcp/server.ts`
    (export it there — one-line change).
  - `tools/list`: `upstream.listTools()` passed through verbatim (the
    central registry is the source of truth for names/schemas; the
    LOCAL_TOOLS names exist there with identical schemas since it is the
    same codebase).
  - `tools/call`: `LOCAL_TOOLS.has(name)` →
    `callLocalTool(client, identity.userId, name, args)`; else
    `upstream.callTool({ name, arguments: args })` passed through.
  - `resources/list` + `resources/read`: proxy upstream (they are static
    markdown on central; no local divergence to manage).
- Session bookkeeping: same Map + TTL GC pattern as
  `createMcpTransport()` in `transport.ts`; on local session close/GC,
  close the upstream client too.
- Upstream connect failure → respond 503 with the underlying reason
  (mirrors the auto-seed 503 contract in `transport.ts`).

- [ ] **Step 1: Write the failing test** — in-process: start a stub
  upstream MCP server (use `McpServer` + `StreamableHTTPServerTransport`
  on an ephemeral port, register one fake tool `portuni_get_node`
  returning a marker string, plus a fake `portuni_mirror` returning
  `"CENTRAL SHOULD NOT SERVE THIS"`), then mount
  `createAgentMcpTransport` on a second ephemeral HTTP server, connect
  with an SDK `Client`, and assert:

```typescript
test("graph tool passes through to central", async () => {
  const r = await localClient.callTool({ name: "portuni_get_node", arguments: { node_id: "x" } });
  assert.match(JSON.stringify(r.content), /central-marker/);
});

test("portuni_mirror is intercepted locally, never reaches central", async () => {
  const r = await localClient.callTool({
    name: "portuni_mirror",
    arguments: { node_id: "01TESTNODE0000000000000000", targets: ["local"] },
  });
  assert.doesNotMatch(JSON.stringify(r.content), /CENTRAL SHOULD NOT SERVE THIS/);
});

test("tools/list mirrors the central tool list", async () => {
  const tools = await localClient.listTools();
  assert.ok(tools.tools.some((t) => t.name === "portuni_get_node"));
});
```

  (For the intercept test, `callLocalTool` will fail on the fake
  CentralClient — asserting it does NOT return the central marker is
  the contract; wrap in try/catch and accept `isError: true` results.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/agent-transport.test.ts`
Expected: FAIL with "Cannot find module .../agent-transport.js"

- [ ] **Step 3: Implement `agent-transport.ts`** per the design comment
  above.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/agent-transport.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/mcp/agent-transport.ts test/agent-transport.test.ts apps/server/mcp/server.ts
git commit -m "feat(agent): MCP front door — local tools intercepted, rest proxied to central"
```

---

### Task 4: Mount the MCP front door in agentMain

**Files:**
- Modify: `apps/server/desktop.ts` (`agentMain`, ~line 98: replace
  `mountMcp: false`)
- Modify: `apps/server/http/server.ts` only if `startHttpServer` cannot
  yet accept an externally-created transport (check its signature; if
  `mountMcp: true` always builds the Turso-backed transport internally,
  add an optional `mcpTransport?: McpTransport` option that wins over
  the internal one)
- Test: `test/agent-mcp-e2e.test.ts`

**Interfaces:**
- Consumes: `createAgentMcpTransport` (Task 3);
  `createCentralClientFromEnv` (already used in `desktop.ts`) — reuse
  its parsed `PORTUNI_CENTRAL_URL` + `PORTUNI_CENTRAL_TOKEN`.
- Produces: agent sidecar answering MCP on `POST /mcp` behind the same
  loopback env-token gate as the REST routes.

- [ ] **Step 1: Write the failing test** — boot the agent HTTP server
  in-process (env: `PORTUNI_AGENT_MODE=1`, `PORTUNI_CENTRAL_URL`
  pointing at the Task-3 stub central, `PORTUNI_AUTH_TOKEN=test-token`,
  `PORTUNI_WORKSPACE_ROOT=<mkdtemp>`), then with an SDK client +
  `Authorization: Bearer test-token`:

```typescript
test("agent serves MCP and the graph plane answers via central", async () => {
  const tools = await client.listTools();
  assert.ok(tools.tools.length > 0);
});

test("unauthenticated /mcp is rejected", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/agent-mcp-e2e.test.ts`
Expected: FAIL (POST /mcp answers 501 agent_mode)

- [ ] **Step 3: Implement** — in `agentMain`:

```typescript
const mcpTransport = createAgentMcpTransport({
  client,
  centralUrl: requiredEnv("PORTUNI_CENTRAL_URL"),
  centralToken: requiredEnv("PORTUNI_CENTRAL_TOKEN"),
});
const handle = startHttpServer({
  port, host: "127.0.0.1", registerSigint: false,
  router: createAgentRouter(client),
  mcpTransport,          // replaces mountMcp: false
});
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test test/agent-mcp-e2e.test.ts && npm run build`
Expected: PASS, tsc clean

- [ ] **Step 5: Commit**

```bash
git add apps/server/desktop.ts apps/server/http/server.ts test/agent-mcp-e2e.test.ts
git commit -m "feat(agent): mount MCP front door on the agent sidecar"
```

---

### Task 5: Materialized configs point at the local front door in agent mode

**Files:**
- Modify: `apps/server/domain/scope-materialize.ts`
  (`resolvePortuniMcpUrl()` — currently honours `PORTUNI_URL`, which the
  desktop sets to the central URL for the agent sidecar; see plan
  `2026-07-03-teammate-mirrors.md` line 48)
- Test: extend the existing scope-materialize test file (find it via
  `grep -l resolvePortuniMcpUrl test/`)

**Interfaces:**
- Produces: in agent mode (`PORTUNI_AGENT_MODE=1`),
  `resolvePortuniMcpUrl()` returns
  `http://127.0.0.1:${PORTUNI_PORT}/mcp` (plus the existing
  `?home_node_id=` suffix logic untouched). Outside agent mode: existing
  behavior byte-for-byte.

- [ ] **Step 1: Write the failing test**

```typescript
test("agent mode: materialized MCP URL is the local front door", () => {
  process.env.PORTUNI_AGENT_MODE = "1";
  process.env.PORTUNI_PORT = "47011";
  process.env.PORTUNI_URL = "https://api.portuni.com";
  assert.equal(resolvePortuniMcpUrl(), "http://127.0.0.1:47011/mcp");
  delete process.env.PORTUNI_AGENT_MODE;
});
```

- [ ] **Step 2: Run to verify it fails** (returns the central URL)

- [ ] **Step 3: Implement** — one early-return branch in
  `resolvePortuniMcpUrl()`.

- [ ] **Step 4: Run the scope-materialize tests**

Run: `node --import tsx --test test/<the file>.test.ts`
Expected: PASS including all pre-existing cases

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(agent): per-mirror MCP configs target the local front door in agent mode"
```

---

### Task 6: Desktop injects the local token for agent-mode terminals

**Files:**
- Inspect first: `apps/desktop/src/pty.rs` + `apps/desktop/src/workspace.rs`
  — find where `PORTUNI_MCP_TOKEN`/`PORTUNI_MCP_TOKEN_<ID>` values are
  chosen for spawned terminals.
- Modify: the site that, for a central-mode workspace, injects the
  central device token — in agent mode the materialized `.mcp.json`
  (Task 5) authenticates against the LOCAL sidecar, so the injected
  value must be the sidecar's per-launch env token (the same value the
  webview proxy uses, `PORTUNI_AUTH_TOKEN`).
- Test: cargo unit test alongside the existing token-env tests in
  `workspace.rs` (there is a `token_env_var` helper with tests — follow
  that pattern).

**Interfaces:**
- Consumes: Task 5 (URL now local). Without this task, sessions in
  central-mode mirrors would send the central `ptk_` token to the local
  gate and get 401.

- [ ] **Step 1: Locate the injection site** (`grep -n "PORTUNI_MCP_TOKEN" apps/desktop/src/*.rs`)
  and write a failing cargo test asserting: central-mode workspace →
  injected token equals the sidecar launch token, not the device token.
- [ ] **Step 2: `cd apps/desktop && cargo test` — verify it fails**
- [ ] **Step 3: Implement the branch**
- [ ] **Step 4: `cargo test` — verify green**
- [ ] **Step 5: Commit**

```bash
git commit -am "fix(desktop): agent-mode terminals carry the local MCP token"
```

---

### Task 7: E2E against the real stack + docs

**Files:**
- Modify: `scripts/e2e/teammate-mirrors.sh` (add an MCP leg)
- Modify: `docs/architecture/data-modes.md` (the 501/local_only section:
  MCP now routes device-local tools to the agent; update the 2×2 table
  note), `CLAUDE.md` (central-mode bullet: MCP sessions connect to the
  local front door), `docs/superpowers/plans/2026-07-03-teammate-mirrors.md`
  (line ~48: mark the "points at central" decision as superseded by this
  plan)

- [ ] **Step 1: Extend the e2e script** — after the existing agent boot,
  drive one MCP session via `curl` JSON-RPC against
  `http://127.0.0.1:$AGENT_PORT/mcp`: `initialize` →
  `tools/call portuni_mirror` for the fixture node → assert
  `local_path` exists on disk → `tools/call portuni_get_context` →
  assert it returns graph data (proving passthrough).
- [ ] **Step 2: Run `scripts/e2e/teammate-mirrors.sh`** — green.
- [ ] **Step 3: Update the three docs** — each edit is a few lines;
  include the follow-ups list from "Out of scope" above in
  `data-modes.md` so the gap inventory lives in one place.
- [ ] **Step 4: `npm run qa`** — full gate green.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(agent): e2e MCP leg + data-modes docs for the local front door"
```

---

## Self-review notes

- Task 2's `portuni_store` mapping is the least mechanical piece —
  `reconcilePathCentral` handles the watcher path; deliberate push may
  need a small `storeFileCentral` helper in `engine-central.ts`. The
  implementer should diff against local `storeFile` semantics
  (`apps/server/mcp/tools/files.ts:26`) and keep the response shape.
- Task 3 chooses upstream `tools/list` verbatim — acceptable because
  central and agent ship from the same repo; if versions skew, the
  worst case is a tool name central knows and the agent proxies anyway,
  which is today's behavior.
- Task 6 depends on how the Rust side currently picks the token — if it
  already injects the launch token (not the device token), the task
  collapses to its test.
