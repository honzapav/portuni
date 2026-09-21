# Task surface v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The thread column is centred and bounded, the conversation is the only full-weight content, something is always on screen while a run is live, runner and instance are chosen in the composer before the first message, the header carries a context ring, the left column marks one row, and the ⌘K palette is shadcn's default.

**Architecture:** Pure derivations (transcript rows, activity summary, working label, delta coalescing, active-row rule, runner picker options, ring state) live in `apps/web/src/lib/*.ts` and are tested from the server's `node:test` runner; `SessionChat.tsx` becomes a renderer of those rows. Server side, the draft row carries `runner`/`instance_id` from creation (resolved on the device, recorded by whichever store the runtime is bound to), `PATCH /sessions/:id` refuses them outside `draft`, and the Claude adapter emits a new `context_usage` canonical event whose latest values the runtime folds into two new `sessions` columns.

**Tech Stack:** React 19 + Vite, Tailwind v4, shadcn (cmdk, radix-ui umbrella), AI Elements copies (Conversation, Message, Reasoning, Tool, Confirmation, Checkpoint, PromptInput, Shimmer + new Loader, ChainOfThought, Context), Streamdown, Node + libSQL/PGlite, zod, `@anthropic-ai/claude-agent-sdk` 0.3.270 (pinned), `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-21-task-surface-v2-design.md` (supersedes parts of `docs/superpowers/specs/2026-09-15-task-surface-design.md`).

## Global Constraints

- Every server change works in a **team workspace** and a **personal workspace** before its task closes (draft creation and patch have a central half in `apps/server/api/agent-router.ts` / `apps/server/domain/runner/store-central.ts` / `apps/server/domain/sync/central/client.ts`; the `context_usage` event travels through the existing log path).
- A new `sessions` column goes into `DDL_SESSIONS` (`apps/server/infra/schema-triggers.ts`), migration 036's rebuild shape (`apps/server/infra/schema-migrations.ts`), `PG_BASELINE_DDL` (`apps/server/infra/schema.pg.ts`) and a new `ALTER TABLE ... ADD COLUMN` migration 039. Read `docs/lessons-learned.md` §7 first. No index on an added column in the DDL replay.
- `@anthropic-ai/claude-agent-sdk` stays pinned exact; no `npm update`.
- UI strings are Czech with diacritics. No emoji in code. Colours come from Portuni's `--color-*` tokens (`apps/web/src/index.css`); the "warning colour" is `--color-node-process`, the danger colour `--color-danger`, dim text `--color-text-dim`.
- Copied AI Elements / shadcn files carry the repo's header: Apache-2.0 notice (AI Elements) or shadcn MIT note, the `npx ai-elements@latest add <name>` / `npx shadcn@latest add <name>` line with the version, and a "Changed:" line listing every edit.
- Pure helpers in `apps/web/src/lib/*.ts` are dependency-free (no React) and tested from `test/*.test.ts` via `../apps/web/src/lib/<file>.js` imports.
- Conventional Commits with scopes from `git log` (`web`, `runner`, `server`, `docs`). Never hand-bump versions.
- The gate is `scripts/agent-gate.sh` (server qa = lint + typecheck + tests + build; web typecheck + build; cargo test/clippy; docs site build). Run `npm test -- --test-name-pattern` or the single test file while iterating (`node --import tsx --test test/<file>.test.ts`), the full gate before a phase closes.
- Work happens on branch `feat/task-surface-v2` created from the current HEAD of `chore/gate-without-pglite` (which already contains `main` and the spec file).
- `sites/docs/` is updated in the same branch as any behaviour change (Task 17).

---

## Phase 1 — Column, header, left column, palette (no data change)

### Task 1: Draft chip reads "Nový"

**Files:**
- Modify: `apps/web/src/lib/session-views.ts:19-27` (`STATE_LABEL`)
- Modify: `apps/web/src/components/WorkspaceNodeList.tsx:296-309` (`taskTitle`)
- Test: `test/session-views-helpers.test.ts`

**Interfaces:**
- Produces: `sessionRowChip("draft", null, "row").label === "Nový"` and `sessionRowChip("draft", null, "header").label === "Nový"`. The server's draft *name* stays "Nový úkol" (`createDraftSession`), only the chip changes.

- [ ] **Step 1: Write the failing test**

Append to `test/session-views-helpers.test.ts` inside the existing `describe("sessionRowChip", ...)` block (create the block if it is not there):

```ts
  it("a draft's chip reads 'Nový' in both variants, so the header never repeats the draft's name", () => {
    assert.equal(sessionRowChip("draft", null, "row").label, "Nový");
    assert.equal(sessionRowChip("draft", null, "header").label, "Nový");
    assert.equal(sessionRowChip("draft", null).pulsing, false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/session-views-helpers.test.ts`
Expected: FAIL, `'Nový úkol' !== 'Nový'`.

- [ ] **Step 3: Change the label table and the sub-row tooltip**

In `apps/web/src/lib/session-views.ts` replace both `draft: "Nový úkol"` entries with `draft: "Nový"`. In `WorkspaceNodeList.tsx`'s `taskTitle`, change `case "draft": return "Nový úkol";` to `return "Nový";`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/session-views-helpers.test.ts`
Expected: PASS. Also `grep -rn "Nový úkol" apps/web/src test` must list only the server-side name (`domain/sessions.ts`, its test) and the "+" button tooltip "Nový úkol pro tento uzel" / "Nový úkol" aria-label (those name the action, not the state).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/session-views.ts apps/web/src/components/WorkspaceNodeList.tsx test/session-views-helpers.test.ts
git commit -m "fix(web): a draft's status chip reads Nový, not the draft's own name again"
```

### Task 2: The node link in "Nesynchronizováno" navigates

**Files:**
- Modify: `apps/web/src/App.tsx:1292-1295`

**Interfaces:**
- Consumes: `overviewSelectNode(id)` (`App.tsx:394`) which does `setSelectedId(id); setView("graph")`.

- [ ] **Step 1: Replace the handler**

In `App.tsx`, the `SyncOverview` element's prop:

```tsx
          onSelectNode={(id) => {
            setSyncOverviewOpen(false);
            overviewSelectNode(id);
          }}
```

- [ ] **Step 2: Verify by hand**

Run the web dev server (`varlock run -- npm --prefix apps/web run dev`, tmux window `portuni-web`), open Nesynchronizováno, click a node name: the dialog closes, the view switches to Graf with the node's detail open. `npm --prefix apps/web run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "fix(web): the node link in Nesynchronizováno opens the node in Graf"
```

### Task 3: The thread column is centred and bounded

**Files:**
- Modify: `apps/web/src/components/SessionChat.tsx` (the notice bar, `ConversationContent`, `QuestionConfirmation`, the composer wrapper)

**Interfaces:**
- Produces: one Tailwind class string used four times: `THREAD_COLUMN = "mx-auto w-[min(80%,768px)]"`.

- [ ] **Step 1: Add the constant and apply it**

Near the top of `SessionChat.tsx` (after the imports):

```ts
// Spec rule 3: transcript, notice bar, question panel and composer share
// one centred column -- 10 % gutters each side, never wider than 768 px.
// The scroll container stays full-width so the scrollbar keeps its edge.
const THREAD_COLUMN = "mx-auto w-[min(80%,768px)]";
```

Apply it:

- notice bar: `className={\`${THREAD_COLUMN} mt-2 flex items-start gap-2 rounded-md border ...\`}` (drop `mx-4`).
- `<ConversationContent className={\`${THREAD_COLUMN} gap-5\`}>` — check `conversation.tsx`'s `ConversationContent` merges `className` via `cn` (it does: `"flex flex-col gap-8 p-4"`); keep `p-4`.
- `QuestionConfirmation`'s outer `<div className="border-t ...">` becomes `<div className="border-t border-[var(--color-border)]"><div className={\`${THREAD_COLUMN} px-0 py-2.5\`}>…</div></div>`.
- the composer wrapper `<div className="border-t border-[var(--color-border)] p-3">` becomes `<div className="border-t border-[var(--color-border)] py-3"><div className={THREAD_COLUMN}><PromptInput …>…</PromptInput></div></div>`.

- [ ] **Step 2: Verify**

`npm --prefix apps/web run typecheck`; in the browser at 1400 px and 900 px pane widths the transcript, notice and composer share left/right edges, the scrollbar stays at the pane edge.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/SessionChat.tsx
git commit -m "feat(web): the thread column is centred with 10 % gutters and a 768 px cap"
```

### Task 4: The header carries name, chip and the two actions only

**Files:**
- Modify: `apps/web/src/components/SessionChat.tsx:337-367` (the header)

**Interfaces:**
- Produces: the header's right side is `<div data-slot="thread-header-actions">` holding, in order, the ring slot (empty until Task 16) and the two `HeaderButton`s. `hostDisplayName` stays imported (Task 9 moves it to composer row 2).

- [ ] **Step 1: Remove the sub-header span**

Delete the `<span>{session.runner ?? "runner neznámý"} … </span>` block and its comments. Keep the `host` const (Task 9 uses it) — until then, prefix with `void host;` is not acceptable; instead move `const host = hostDisplayName(session);` down to Task 9 and delete it here, along with the now-unused import if `typecheck` flags it.

- [ ] **Step 2: Verify**

`npm --prefix apps/web run typecheck && npm --prefix apps/web run lint` (if a lint script exists; otherwise the gate's web build). The header of a draft reads "Nový úkol" (name) then "Nový" (chip), no third text.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/SessionChat.tsx
git commit -m "refactor(web): the thread header shows name, status and actions only"
```

### Task 5: One active row, spacing, thread rule, status dot rule in the left column

**Files:**
- Modify: `apps/web/src/lib/session-views.ts` (new helpers `isThreadSession`, `nodeRowActive`; `applyNodeSessionsRefetch` filters threads)
- Modify: `apps/web/src/components/WorkspaceNodeList.tsx` (metrics, `summarizeNodeActivity`, `ACTIVITY_DOT`, node row active rule)
- Test: `test/session-views-helpers.test.ts`, `test/workspace-node-list.test.ts` (new; `summarizeNodeActivity` is exported from the component file — import it as the existing tests import `taskGroupOf`; check `grep -rn "summarizeNodeActivity" test/` first and extend that file if one exists)

**Interfaces:**
- Produces in `session-views.ts`:

```ts
export function isThreadSession(s: { session_type: string; cli: string | null }): boolean;
// The one row the fill and accent bar mark: the open thread when there is
// one, otherwise the selected node.
export function nodeRowActive(nodeId: string, selectedNodeId: string | null, activeSessionId: string | null): boolean;
```

`applyNodeSessionsRefetch<T extends NodeSession & { session_type: string; cli: string | null }>` keeps only `isThreadSession(s)` rows in `running`/`suspended`.

- Produces in `WorkspaceNodeList.tsx`: `summarizeNodeActivity` returns `"waiting" | "running" | null` (no `"suspended"`); `NodeActivity` type narrows accordingly.

- [ ] **Step 1: Write the failing tests**

In `test/session-views-helpers.test.ts`:

```ts
import { isThreadSession, nodeRowActive, applyNodeSessionsRefetch } from "../apps/web/src/lib/session-views.js";

describe("isThreadSession (spec rule 7)", () => {
  it("an interactive_task with no cli is a thread", () => {
    assert.equal(isThreadSession({ session_type: "interactive_task", cli: null }), true);
  });
  it("a hand-opened CLI session is not", () => {
    assert.equal(isThreadSession({ session_type: "interactive_task", cli: "claude" }), false);
    assert.equal(isThreadSession({ session_type: "interactive_chat", cli: null }), false);
  });
});

describe("nodeRowActive (spec rule 6)", () => {
  it("the selected node is active only while no thread is shown", () => {
    assert.equal(nodeRowActive("N1", "N1", null), true);
    assert.equal(nodeRowActive("N1", "N1", "S1"), false);
    assert.equal(nodeRowActive("N2", "N1", null), false);
    assert.equal(nodeRowActive("N1", null, null), false);
  });
});

describe("applyNodeSessionsRefetch excludes CLI sessions", () => {
  it("keeps running/suspended threads, drops cli-bound rows", () => {
    const next = applyNodeSessionsRefetch({}, "N1", [
      { id: "a", node_id: "N1", state: "running", session_type: "interactive_task", cli: null },
      { id: "b", node_id: "N1", state: "running", session_type: "interactive_task", cli: "claude" },
      { id: "c", node_id: "N1", state: "closed", session_type: "interactive_task", cli: null },
    ]);
    assert.deepEqual(next.N1.map((s) => s.id), ["a"]);
  });
});
```

In the node-list test file:

```ts
import { summarizeNodeActivity } from "../apps/web/src/components/WorkspaceNodeList.js";

describe("summarizeNodeActivity", () => {
  it("waiting beats running; suspended and draft show no dot", () => {
    assert.equal(summarizeNodeActivity([{ state: "running", waiting_since: "x" }, { state: "running", waiting_since: null }]), "waiting");
    assert.equal(summarizeNodeActivity([{ state: "running", waiting_since: null }]), "running");
    assert.equal(summarizeNodeActivity([{ state: "suspended", waiting_since: null }, { state: "draft", waiting_since: null }]), null);
  });
});
```

If importing a `.tsx` component from `node:test` fails (JSX under tsx is fine, but `@/components/ui/*` path aliases may not resolve), move `summarizeNodeActivity`, `NodeActivity`, `taskGroupOf`, `TASK_GROUPS`, `TaskGroupKey` into a new `apps/web/src/lib/workspace-list.ts` and re-export them from the component for existing importers (`grep -rn "summarizeNodeActivity\|taskGroupOf\|TASK_GROUPS" apps/web/src`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/session-views-helpers.test.ts test/workspace-node-list.test.ts`
Expected: FAIL (`isThreadSession is not a function`, and `"suspended"` returned).

- [ ] **Step 3: Implement the helpers**

`session-views.ts`, after `pruneNodeSessions`:

```ts
// ---------------------------------------------------------------- v2

// Spec rule 7: a thread is a persistent task session the app opened; a
// hand-opened CLI session (cli set, Relace lists it) has no sub-row.
export function isThreadSession(s: { session_type: string; cli: string | null }): boolean {
  return s.session_type === "interactive_task" && s.cli === null;
}

// Spec rule 6: the accent bar and the surface-2 fill mark exactly one
// row -- the open thread when there is one, else the selected node.
export function nodeRowActive(nodeId: string, selectedNodeId: string | null, activeSessionId: string | null): boolean {
  return activeSessionId === null && selectedNodeId === nodeId;
}
```

Change `applyNodeSessionsRefetch`'s generic to `T extends NodeSession & { session_type: string; cli: string | null }` and its filter to `sessions.filter((s) => isThreadSession(s) && (s.state === "running" || s.state === "suspended"))`. Check every caller compiles (`App.tsx` passes `SessionSummary[]`, which has both fields).

`WorkspaceNodeList.tsx`:

```ts
export type NodeActivity = "waiting" | "running" | null;

export function summarizeNodeActivity(
  tasks: readonly Pick<SessionSummary, "state" | "waiting_since">[],
): NodeActivity {
  if (tasks.some((t) => t.state === "running" && t.waiting_since !== null)) return "waiting";
  if (tasks.some((t) => t.state === "running")) return "running";
  return null;
}

const ACTIVITY_DOT: Record<Exclude<NodeActivity, null>, { color: string; title: string; pulse: boolean }> = {
  waiting: { color: "var(--color-node-process)", title: "Úkol čeká na odpověď", pulse: true },
  running: { color: "var(--color-status-active)", title: "Úkol běží", pulse: true },
};
```

- [ ] **Step 4: Apply the metrics and the active rule in `NodeTree`**

- `const selected = nodeRowActive(r.id, selectedNodeId, activeSessionId);` replaces `r.id === selectedNodeId` (import `nodeRowActive`).
- Outer list: `<ul className="flex flex-col gap-2 px-3 pb-4">` (8 px between nodes, 12 px column padding). Section header: `px-4 pt-6 pb-1.5` → `px-3 pt-4 pb-2` (16 px above the heading).
- Node row: `h-8` → `h-9`, `px-2.5` → `px-2.5` stays (10 px inside), `gap-2.5` stays; accent bar `-left-2.5` → `-left-3`.
- Sub-row list: `<ul className="mt-1 flex flex-col gap-1">` (4 px between sub-rows). `TaskRow` button `h-8` → `h-8` (32 px) stays; `pl-7` stays; the editing `Input` `h-8` stays.
- `TaskList` (Stav): outer `<ul className="flex flex-col px-3 pb-4">`, group lists `gap-1`, `GroupHeader` `px-2.5 pt-4 pb-1.5` (16 px above).

- [ ] **Step 5: Run tests, typecheck, look**

Run: `node --import tsx --test test/session-views-helpers.test.ts test/workspace-node-list.test.ts && npm --prefix apps/web run typecheck`
Expected: PASS. In the browser: open a node, open a thread — only the thread row is filled and barred; the node name is normal weight. Close the thread (× or select the node itself) — the node row is filled. A suspended thread's node shows no dot.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/session-views.ts apps/web/src/components/WorkspaceNodeList.tsx test/session-views-helpers.test.ts test/workspace-node-list.test.ts
git commit -m "feat(web): one active row, wider spacing and no CLI sessions in the Práce column"
```

### Task 6: The ⌘K palette on shadcn defaults

**Files:**
- Create: `apps/web/src/components/ui/kbd.tsx` (shadcn `kbd`, from `https://ui.shadcn.com/r/styles/new-york-v4/kbd.json`; header note; `import { cn } from "cn"` like the other ui files)
- Modify: `apps/web/src/components/ui/command.tsx:66-96` (`CommandInput` back to shadcn's bare row), `:98-112` (`CommandList` padding), `:156-174` (`CommandItem` inset rounding)
- Modify: `apps/web/src/components/NodeCommandPalette.tsx`

**Interfaces:**
- Consumes: `NODE_TYPE_LABELS`, `nodeTypeLabel` from `apps/web/src/lib/node-search.ts`.
- Produces: `CommandInput` no longer takes `wrapperClassName`; `CommandFooter` (new, exported from `command.tsx`) renders the key-hint row.

- [ ] **Step 1: Add `ui/kbd.tsx`**

Write the shadcn source verbatim with the repo header:

```tsx
// shadcn/ui `kbd` (MIT), pulled via `npx shadcn@latest add kbd` (new-york-v4,
// 2026-09-21). Changed: `cn` import path only.
```

- [ ] **Step 2: Restore shadcn's `CommandInput` and add `CommandFooter`**

Replace `CommandInput` in `command.tsx` with shadcn's default shape (bare field, 20 px icon slot, 1 px divider), no `InputGroup`:

```tsx
function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-12 items-center gap-2 border-b border-border px-3"
    >
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
}
```

Remove the `InputGroup`/`InputGroupAddon` imports if nothing else in the file uses them. `Command`'s own class: drop `p-1` (the list owns its inset). `CommandList`: `"max-h-72 scroll-py-2 overflow-x-hidden overflow-y-auto py-2 outline-none"` (8 px vertical padding). `CommandGroup`: `"overflow-hidden px-2 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pt-3 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground"`. `CommandItem`: `"relative mx-2 flex h-10 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:bg-muted data-selected:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"` (40 px rows, inset 8 px, active fill inset with the row); drop the trailing `CheckIcon` (nothing here is checkable) and the `in-data-[slot=dialog-content]:rounded-lg!` override. `CommandEmpty`: `"py-6 text-center text-sm text-muted-foreground"`.

Add and export:

```tsx
function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        "flex h-11 items-center gap-4 border-t border-border bg-[var(--color-surface)] px-3 text-xs text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}
```

- [ ] **Step 3: Rewrite the palette's rows and add the footer**

`NodeCommandPalette.tsx`:

```tsx
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { groupNodesByType, nodeTypeLabel } from "../lib/node-search";
…
  // `grouped` says a heading already names the type, so the right slot is
  // empty; a flat list carries the type name in the muted colour instead.
  const row = (n: GraphNode, grouped: boolean) => (
    <CommandItem key={n.id} value={n.id} onSelect={() => { onPick(n.id); onOpenChange(false); }}>
      <span className="inline-flex size-5 shrink-0 items-center justify-center" aria-hidden>
        <span className="inline-block size-2 rounded-full" style={{ background: nodeTypeVar(n.type) }} />
      </span>
      <span className="min-w-0 flex-1 truncate">{n.name}</span>
      {!grouped && <span className="ml-auto shrink-0 text-muted-foreground">{nodeTypeLabel(n.type)}</span>}
    </CommandItem>
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Hledat uzel" description="Napiš název uzlu a potvrď Enterem." className="sm:max-w-[640px]">
      <Command shouldFilter={false}>
        <CommandInput placeholder="Hledat uzel…" value={text} onValueChange={(v) => { setText(v); onQueryChange?.(v); }} />
        <CommandList>
          <CommandEmpty>Žádný uzel</CommandEmpty>
          {groups
            ? groups.map((g) => (
                <CommandGroup key={g.type} heading={g.label}>{g.nodes.map((n) => row(n, true))}</CommandGroup>
              ))
            : matches.map((n) => row(n, false))}
        </CommandList>
        <CommandFooter>
          <KbdGroup><Kbd>↑</Kbd><Kbd>↓</Kbd><span>Navigace</span></KbdGroup>
          <KbdGroup><Kbd>Enter</Kbd><span>Otevřít</span></KbdGroup>
          <KbdGroup><Kbd>Esc</Kbd><span>Zavřít</span></KbdGroup>
        </CommandFooter>
      </Command>
    </CommandDialog>
  );
```

`KbdGroup` gets `className="gap-1.5"` so the label sits 6 px from its chips.

- [ ] **Step 4: Verify**

`grep -rn "wrapperClassName\|CommandInput" apps/web/src` — no other caller passes `wrapperClassName`. `npm --prefix apps/web run typecheck`. In the browser: ⌘K — bare search row with a divider, rows inset with a rounded active fill that never touches the dialog edge, type names muted on a flat list and absent under headings, the footer with three chips.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/kbd.tsx apps/web/src/components/ui/command.tsx apps/web/src/components/NodeCommandPalette.tsx
git commit -m "feat(web): the node palette on shadcn's command defaults with a key-hint footer"
```

### Phase 1 gate

- [ ] `npm run typecheck && npm test` (server runner covers the web helpers) and `npm --prefix apps/web run build`. Fix anything red before Phase 2.

---

## Phase 2 — Composer rows; runner and instance on the draft

### Task 7: A draft records runner and instance at creation

**Files:**
- Modify: `apps/server/domain/runner/store.ts:120-125` (`CreateDraftSessionInput`)
- Modify: `apps/server/domain/sessions.ts:177-195` (`createDraftSession` gains `runner`/`instance_id`)
- Modify: `apps/server/domain/runner/store.ts:202-207` (`DbSessionStore.createDraft` forwards them)
- Modify: `apps/server/domain/runner/session-runtime.ts:87-118` (`resolveTaskDefaults` exported, returns nulls-tolerant variant), `:542-549` (`createDraft` resolves), `:622-676` (`promoteDraftAndStart` prefers the draft's values)
- Modify: `apps/server/api/sessions.ts:527-539` (local `POST /sessions` draft path goes through the runtime), `:773-778` (`RecordSessionBody` draft shape accepts `runner`, `instance_id`), `:811-818` (`store.createDraft` forwards)
- Modify: `apps/server/domain/sync/central/client.ts:447-457` (`createDraftSessionRecord` sends them)
- Test: `test/session-draft-state.test.ts`, `test/api-sessions-runtime.test.ts`

**Interfaces:**
- Produces:

```ts
// session-runtime.ts
export async function resolveTaskDefaults(nodeId, resolveNodeOrgId): Promise<{ runner: string; instanceId: string | null }>; // unchanged, now exported
// A draft's defaults: the same resolution, but "no runner" is a legal
// answer (both null) -- the composer says so instead of a picker.
export async function resolveDraftDefaults(nodeId, resolveNodeOrgId): Promise<{ runner: string | null; instanceId: string | null }>;
// store.ts
export interface CreateDraftSessionInput { node_id; user_id; model?; effort?; runner?: string | null; instance_id?: string | null; }
```

- [ ] **Step 1: Write the failing tests**

`test/session-draft-state.test.ts`, in `describe("DbSessionStore.createDraft")`:

```ts
  it("records the runner and instance the device resolved, or nulls", async () => {
    const { db, nodeId } = await makeSharedDb();
    const store = new DbSessionStore(db);
    const withRunner = await store.createDraft({ node_id: nodeId, user_id: "U1", runner: "claude", instance_id: "01INST" });
    assert.equal(withRunner.state, "draft");
    assert.equal(withRunner.runner, "claude");
    assert.equal(withRunner.instance_id, "01INST");
    const bare = await store.createDraft({ node_id: nodeId, user_id: "U1" });
    assert.equal(bare.runner, null);
    assert.equal(bare.instance_id, null);
  });
```

`test/api-sessions-runtime.test.ts`, next to the existing draft tests:

```ts
  test("POST /sessions without a brief records the device's default runner on the draft", async () => {
    installRuntime([{ wait: "message" }]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", { node_id: dbFixture.nodeId });
    assert.equal(res.statusCode, 201);
    const { session } = JSON.parse(res.body) as { session: SessionSummary };
    assert.equal(session.state, "draft");
    assert.equal(session.runner, "fake");
    assert.equal(session.instance_id, null);
  });

  test("promotion keeps the draft's own runner/instance instead of re-resolving", async () => {
    const { adapter } = installRuntime([{ wait: "message" }]);
    const draftRes = await call(makeIdentity("U1"), "POST", "/sessions", { node_id: dbFixture.nodeId });
    const { session: draft } = JSON.parse(draftRes.body) as { session: SessionSummary };
    // A second runner registered after the draft was created must not win.
    registerAdapter(new FakeRunnerAdapter({ script: [{ wait: "message" }] }) as unknown as typeof adapter & { id: "fake" });
    const msgRes = await call(makeIdentity("U1"), "POST", `/sessions/${draft.id}/messages`, { text: "go" });
    assert.equal(msgRes.statusCode, 202);
    const getRes = await call(makeIdentity("U1"), "GET", `/sessions/${draft.id}`);
    const updated = JSON.parse(getRes.body) as { runner: string; instance_id: string | null };
    assert.equal(updated.runner, "fake");
  });
```

(If `FakeRunnerAdapter.id` is a readonly literal `"fake"`, make the second-registration test assert via a spy instead: wrap `resolveTaskDefaults` is not injectable, so assert the draft's `runner` column is what promotion used by patching the draft to `instance_id: "01INST"` through `store.patchSession` before the message and asserting `updated.instance_id === "01INST"` after promotion — that is the observable difference.)

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/session-draft-state.test.ts test/api-sessions-runtime.test.ts`
Expected: FAIL (`runner` is `null`; TS error on the unknown input field).

- [ ] **Step 3: Implement**

`store.ts`:

```ts
export interface CreateDraftSessionInput {
  node_id: string;
  user_id: string;
  model?: string | null;
  effort?: string | null;
  // v2 rule 5: chosen before the first message. The device resolves the
  // organisation's defaults (session-runtime.ts's resolveDraftDefaults)
  // and the store only records; null means "no runner is logged in here".
  runner?: string | null;
  instance_id?: string | null;
}
```

`DbSessionStore.createDraft` passes `runner: input.runner ?? null, instance_id: input.instance_id ?? null` into `createDraftSessionRow`'s options; `createDraftSession(db, userId, nodeId, opts)` adds `runner, instance_id` to its INSERT column list and args (`opts?.runner ?? null`, `opts?.instance_id ?? null`).

`session-runtime.ts`:

```ts
export async function resolveDraftDefaults(
  nodeId: string,
  resolveNodeOrgId: ResolveNodeOrgId,
): Promise<{ runner: string | null; instanceId: string | null }> {
  try {
    return await resolveTaskDefaults(nodeId, resolveNodeOrgId);
  } catch (err) {
    if (err instanceof NoRunnerAvailableError) return { runner: null, instanceId: null };
    throw err;
  }
}
```

`createDraft`:

```ts
  async function createDraft(input: CreateDraftInput): Promise<SessionRow> {
    const defaults = await resolveDraftDefaults(input.nodeId, resolveNodeOrgId);
    return store.createDraft({
      node_id: input.nodeId,
      user_id: input.userId,
      model: input.model ?? null,
      effort: input.effort ?? null,
      runner: defaults.runner,
      instance_id: defaults.instanceId,
    });
  }
```

`promoteDraftAndStart`: replace the `resolveTaskDefaults` line with

```ts
    const { runner, instanceId } = session.runner
      ? { runner: session.runner, instanceId: session.instance_id }
      : await resolveTaskDefaults(session.node_id, resolveNodeOrgId);
```

`api/sessions.ts` `handleStartSession` draft branch: replace `createDraftSession(db, …)` with `const session = await getSessionRuntime().createDraft({ userId: identity.userId, nodeId: body.node_id, model: body.model, effort: body.effort });` (the runtime's store is `DbSessionStore` here, so the row still lands locally; the runtime resolves the defaults). `RecordSessionBody` draft shape gains `runner: z.string().nullable().optional(), instance_id: z.string().nullable().optional()`; `store.createDraft({... runner: body.runner ?? null, instance_id: body.instance_id ?? null })`. `client.ts` `createDraftSessionRecord` sends `runner: input.runner ?? null, instance_id: input.instance_id ?? null`.

- [ ] **Step 4: Run tests, then the parity/router tests too**

Run: `node --import tsx --test test/session-draft-state.test.ts test/api-sessions-runtime.test.ts test/agent-router-sessions.test.ts test/central-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(runner,server): a draft records the organisation's default runner and instance at creation"
```

### Task 8: PATCH refuses runner/instance outside draft

**Files:**
- Modify: `apps/server/api/sessions.ts:294-336` (`handlePatchSession`)
- Test: `test/api-sessions.test.ts`

**Interfaces:**
- Produces: `409 { error: "runner and instance can only change on a draft", code: "SESSION_NOT_DRAFT" }` when the body carries `runner` or `instance_id`, the row is not `draft`, and the body carries no `state` (the promotion patch sets `state: "running"` together with them and passes).

- [ ] **Step 1: Write the failing test**

In `test/api-sessions.test.ts` (find the existing PATCH tests with `grep -n "PATCH" test/api-sessions.test.ts` and add beside them; use that file's own `call`/`createSession` helpers):

```ts
  test("PATCH runner/instance_id is 409 SESSION_NOT_DRAFT on a running session, 200 on a draft", async () => {
    const running = await createSession(db, { node_id: nodeId, session_type: "interactive_task", runner: "claude" }, "U1");
    const refused = await call(makeIdentity("U1"), "PATCH", `/sessions/${running.id}`, { instance_id: "01INST" });
    assert.equal(refused.statusCode, 409);
    assert.equal((JSON.parse(refused.body) as { code: string }).code, "SESSION_NOT_DRAFT");

    const draft = await createDraftSession(db, "U1", nodeId);
    const ok = await call(makeIdentity("U1"), "PATCH", `/sessions/${draft.id}`, { runner: "claude", instance_id: "01INST" });
    assert.equal(ok.statusCode, 200);
    const row = JSON.parse(ok.body) as { runner: string; instance_id: string };
    assert.equal(row.runner, "claude");
    assert.equal(row.instance_id, "01INST");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/api-sessions.test.ts`
Expected: FAIL (200 where 409 is expected).

- [ ] **Step 3: Implement the guard**

In `handlePatchSession`, after the plain-rename branch:

```ts
    // v2 rule 5: runner and instance are the thread's, chosen while it is
    // a draft. The promotion patch sets them together with state:
    // "running" and passes; a bare change on any other state is refused.
    const touchesRunner = body.runner !== undefined || body.instance_id !== undefined;
    if (touchesRunner && existing.state !== "draft" && body.state === undefined) {
      respondJson(res, 409, { error: "runner and instance can only change on a draft", code: "SESSION_NOT_DRAFT" });
      return;
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --test test/api-sessions.test.ts test/api-sessions-runtime.test.ts`
Expected: PASS (the promotion test from Task 7 still passes because it carries `state`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/sessions.ts test/api-sessions.test.ts
git commit -m "feat(server): runner and instance patch only on a draft, 409 SESSION_NOT_DRAFT otherwise"
```

### Task 9: Composer row 2 — runner · instance ▾ · host

**Files:**
- Create: `apps/web/src/lib/runner-picker.ts`
- Modify: `apps/web/src/api.ts` (add `patchSessionRunnerInstance`)
- Modify: `apps/web/src/components/SessionChat.tsx` (composer footer becomes two rows; host label moves here)
- Test: `test/runner-picker.test.ts`

**Interfaces:**
- Produces in `runner-picker.ts`:

```ts
export type RunnerPickerOption = { value: string; runner: string; instanceId: string | null; label: string; isDefault: boolean };
export type RunnerPickerGroup = { runner: string; label: string; options: RunnerPickerOption[] };
export function encodeRunnerChoice(runner: string, instanceId: string | null): string; // `${runner}\u0000${instanceId ?? ""}`
export function decodeRunnerChoice(value: string): { runner: string; instanceId: string | null };
// One group per runner (from GET /runners), one option per instance of it
// (from GET /runners/instances) plus the runner's own default ("výchozí
// instance") first; `defaultChoice` is the draft's own initial value, the
// one the organisation's default resolved to, marked "(výchozí)".
export function runnerPickerGroups(runners: readonly { id: string; label?: string }[], instances: readonly { id: string; name: string; runner: string }[], defaultChoice: { runner: string | null; instanceId: string | null }): RunnerPickerGroup[];
export function runnerChoiceLabel(session: { runner: string | null; instance_id: string | null }, instances: readonly { id: string; name: string }[]): string; // "claude · Work" | "claude" | "Žádný runner není přihlášený"
```

- Produces in `api.ts`: `patchSessionRunnerInstance(id, { runner, instance_id }): Promise<{ runner: string | null; instance_id: string | null }>` → `PATCH /sessions/:id`.

- Consumes: `listRunners()` (`RunnerInfo` — check its shape in `apps/server/shared/api-types.ts`, it has `id` and a display field), `listRunnerInstances()` (`RunnerInstanceSummary`), `hostDisplayName`.

- [ ] **Step 1: Write the failing tests**

`test/runner-picker.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeRunnerChoice, decodeRunnerChoice, runnerPickerGroups, runnerChoiceLabel } from "../apps/web/src/lib/runner-picker.js";

describe("runner picker", () => {
  it("encodes and decodes a runner + optional instance", () => {
    assert.deepEqual(decodeRunnerChoice(encodeRunnerChoice("claude", "01A")), { runner: "claude", instanceId: "01A" });
    assert.deepEqual(decodeRunnerChoice(encodeRunnerChoice("claude", null)), { runner: "claude", instanceId: null });
  });

  it("groups instances under their runner, default first, the draft's own choice marked", () => {
    const groups = runnerPickerGroups(
      [{ id: "claude" }, { id: "codex" }],
      [{ id: "01A", name: "Work", runner: "claude" }, { id: "01B", name: "Home", runner: "claude" }],
      { runner: "claude", instanceId: "01B" },
    );
    assert.deepEqual(groups.map((g) => g.runner), ["claude", "codex"]);
    assert.deepEqual(groups[0].options.map((o) => [o.label, o.isDefault]), [["výchozí instance", false], ["Work", false], ["Home", true]]);
    assert.deepEqual(groups[1].options.map((o) => o.label), ["výchozí instance"]);
  });

  it("labels the fixed choice, or says no runner is logged in", () => {
    const instances = [{ id: "01A", name: "Work" }];
    assert.equal(runnerChoiceLabel({ runner: "claude", instance_id: "01A" }, instances), "claude · Work");
    assert.equal(runnerChoiceLabel({ runner: "claude", instance_id: null }, instances), "claude");
    assert.equal(runnerChoiceLabel({ runner: null, instance_id: null }, instances), "Žádný runner není přihlášený");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/runner-picker.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `runner-picker.ts`**

```ts
// Composer row 2 (v2 spec, "The composer"): the runner/instance choice a
// draft makes before its first message. Pure so test/runner-picker.test.ts
// covers the grouping and the labels without React.

const SEP = "\u0000";

export type RunnerPickerOption = { value: string; runner: string; instanceId: string | null; label: string; isDefault: boolean };
export type RunnerPickerGroup = { runner: string; label: string; options: RunnerPickerOption[] };

export function encodeRunnerChoice(runner: string, instanceId: string | null): string {
  return `${runner}${SEP}${instanceId ?? ""}`;
}

export function decodeRunnerChoice(value: string): { runner: string; instanceId: string | null } {
  const idx = value.indexOf(SEP);
  if (idx < 0) return { runner: value, instanceId: null };
  const instanceId = value.slice(idx + 1);
  return { runner: value.slice(0, idx), instanceId: instanceId === "" ? null : instanceId };
}

export function runnerPickerGroups(
  runners: readonly { id: string; label?: string }[],
  instances: readonly { id: string; name: string; runner: string }[],
  defaultChoice: { runner: string | null; instanceId: string | null },
): RunnerPickerGroup[] {
  return runners.map((r) => {
    const isDefault = (instanceId: string | null) => defaultChoice.runner === r.id && defaultChoice.instanceId === instanceId;
    const own: RunnerPickerOption = { value: encodeRunnerChoice(r.id, null), runner: r.id, instanceId: null, label: "výchozí instance", isDefault: isDefault(null) };
    const rest = instances
      .filter((i) => i.runner === r.id)
      .map((i) => ({ value: encodeRunnerChoice(r.id, i.id), runner: r.id, instanceId: i.id, label: i.name, isDefault: isDefault(i.id) }));
    return { runner: r.id, label: r.label ?? r.id, options: [own, ...rest] };
  });
}

export function runnerChoiceLabel(
  session: { runner: string | null; instance_id: string | null },
  instances: readonly { id: string; name: string }[],
): string {
  if (!session.runner) return "Žádný runner není přihlášený";
  const name = session.instance_id ? instances.find((i) => i.id === session.instance_id)?.name ?? session.instance_id : null;
  return name ? `${session.runner} · ${name}` : session.runner;
}
```

- [ ] **Step 4: Add the API call and the composer rows**

`api.ts`:

```ts
// v2 rule 5: the draft's runner/instance choice, PATCH /sessions/:id --
// central in a team workspace (the record is there), refused with 409
// SESSION_NOT_DRAFT once the thread is promoted.
export function patchSessionRunnerInstance(
  id: string,
  patch: { runner: string; instance_id: string | null },
): Promise<{ runner: string | null; instance_id: string | null }> {
  return jsonRequest("PATCH", `/sessions/${encodeURIComponent(id)}`, patch);
}
```

`SessionChat.tsx`: load `listRunners()` and `listRunnerInstances()` once per mount (same `useEffect` pattern as `fetchRunnerModels`; both are device-local routes, fine in both workspaces). Keep `const initialChoiceRef = useRef({ runner: session.runner, instanceId: session.instance_id })` as the org default marker. Replace `PromptInputFooter` with:

```tsx
          <PromptInputFooter className="flex-col items-stretch gap-1">
            <div className="flex items-center justify-between gap-2">
              <PromptInputTools>{/* existing model + effort selects, unchanged */}</PromptInputTools>
              <PromptInputSubmit … />
            </div>
            <div className="flex items-center gap-2 text-[11.5px] text-[var(--color-text-dim)]">
              {live.state === "draft" && access.canResume && session.runner ? (
                <PromptInputSelect value={encodeRunnerChoice(session.runner, session.instance_id)} onValueChange={handleRunnerChange}>
                  <PromptInputSelectTrigger className="h-6 w-auto min-w-0 text-[11.5px]" title="Runner a instance — platí pro celé vlákno, mění se jen u nového">
                    <PromptInputSelectValue />
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    {runnerPickerGroups(runners, instances, initialChoiceRef.current).map((g) => (
                      <SelectGroup key={g.runner}>
                        <SelectLabel>{g.label}</SelectLabel>
                        {g.options.map((o) => (
                          <PromptInputSelectItem key={o.value} value={o.value}>{o.label}{o.isDefault ? " (výchozí)" : ""}</PromptInputSelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>
              ) : (
                <span>{runnerChoiceLabel(session, instances)}</span>
              )}
              {host && <span>· {host}</span>}
            </div>
          </PromptInputFooter>
```

`handleRunnerChange`:

```ts
  const handleRunnerChange = (value: string) => {
    const { runner, instanceId } = decodeRunnerChoice(value);
    onSessionUpdated({ ...session, runner, instance_id: instanceId });
    void patchSessionRunnerInstance(session.id, { runner, instance_id: instanceId }).catch((e) => setError(String(e)));
  };
```

`SelectGroup`/`SelectLabel` come from `@/components/ui/select`. `host` is `hostDisplayName(session)` (moved here from the header). The `#376` comment about a runner-less draft querying `"claude"` models is replaced: `fetchRunnerModels(session.runner ?? "claude")` stays as the fallback, but re-runs on `session.runner` (it already does).

- [ ] **Step 5: Verify**

Run: `node --import tsx --test test/runner-picker.test.ts && npm --prefix apps/web run typecheck`. In the browser: a new draft shows row 1 (Model, Effort, send) and row 2 with the runner/instance select preselected to the org default and the host; change the instance, reload — the choice persists (the row was patched); send the first message — row 2 becomes a plain label. A draft on a device with no logged-in runner reads "Žádný runner není přihlášený".

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/runner-picker.ts apps/web/src/api.ts apps/web/src/components/SessionChat.tsx test/runner-picker.test.ts
git commit -m "feat(web): runner and instance chosen in the composer's second row while the thread is a draft"
```

### Phase 2 gate

- [ ] `npm run qa` (server) and `npm --prefix apps/web run build`; then `npm run test:pglite` because Task 7 touched an INSERT.

---

## Phase 3 — The activity model

### Task 10: Copy `loader` and `chain-of-thought`

**Files:**
- Create: `apps/web/src/components/ai-elements/loader.tsx`, `apps/web/src/components/ai-elements/chain-of-thought.tsx`

- [ ] **Step 1: Write both files from the registry source** (`https://registry.ai-sdk.dev/loader.json`, `…/chain-of-thought.json`, ai-elements 1.9.x — read `conversation.tsx`'s header for the exact version string used and the wording). Header per Global Constraints. Changes to list: `cn` import from `"cn"`; `"use client"` dropped; `ChainOfThoughtImage`, `ChainOfThoughtSearchResults`, `ChainOfThoughtSearchResult` dropped (unused, they pull `Badge`); `ChainOfThought`'s `max-w-prose` dropped (the column is bounded by Task 3). Dependencies already present: `@radix-ui/react-use-controllable-state`, `lucide-react`, `ui/collapsible`.

- [ ] **Step 2: Verify** `npm --prefix apps/web run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ai-elements/loader.tsx apps/web/src/components/ai-elements/chain-of-thought.tsx
git commit -m "chore(web): copy AI Elements loader and chain-of-thought"
```

### Task 11: Transcript row derivation, the activity sentence, the working label

**Files:**
- Modify: `apps/web/src/lib/session-chat.ts`
- Test: `test/session-chat-helpers.test.ts`

**Interfaces:**
- Produces:

```ts
export type ActivityItem =
  | { kind: "reasoning"; seq: number; summary: string }
  | { kind: "tool"; seq: number; call: ToolCallEvent["payload"] }
  | { kind: "file_change"; seq: number; path: string; op: FileChangeOp };

export type TranscriptRow =
  | { kind: "prompt"; key: string; text: string }
  | { kind: "answer"; key: string; text: string }
  | { kind: "activity"; key: string; runId: string | null; items: ActivityItem[]; live: boolean }
  | { kind: "question"; key: string; title: string }
  | { kind: "compaction"; key: string }
  | { kind: "summary"; key: string }
  | { kind: "error"; key: string; message: string };

export type WorkingPhase = "starting" | "thinking" | "continuing";

// Rows from the seq-ordered, tool-collapsed events. `liveRunId` says which
// run is live: its trailing activity group (after the last answer) is
// marked live. run_started, run_ended(completed) and state_changed yield
// nothing; run_ended with another reason yields an error row.
export function deriveTranscriptRows(events: readonly ChatEvent[], liveRunId: string | null): TranscriptRow[];

// "Přečteno 3 soubory · upraven 1 · 2 příkazy · uvažoval 12 s" -- a
// single call shows its own title; failures carry the failed count.
export function activitySummary(items: readonly ActivityItem[], reasoningSeconds?: number | null): { text: string; failed: number };

// What the working row says after the last thing that happened.
export function workingPhase(events: readonly ChatEvent[], liveRunId: string | null, sentAt: number | null): WorkingPhase | null;
export const WORKING_LABEL: Record<WorkingPhase, string>; // Spouštím… / Přemýšlím… / Pokračuji…
export function toolVerbCounts(items: readonly ActivityItem[]): Map<string, number>; // exported for the test
```

Verb table (`TOOL_VERBS`): `Read`/`Glob`/`Grep`/`LS`/`WebFetch`/`WebSearch` → `read`; `Edit`/`MultiEdit`/`NotebookEdit` → `edited`; `Write` → `created`; `Bash` → `command`; anything else → its own name. Czech rendering with `plural` from `apps/web/src/lib/plural.ts` (check its signature first): read → "Přečteno N soubor/soubory/souborů", edited → "upraven N / upraveny N / upraveno N" (use the neutral "upraveno N" form for all counts to keep one string), created → "vytvořeno N", command → "N příkaz / příkazy / příkazů", other → "N × <tool>". `file_change` items are not counted (the tool call already is). `reasoningSeconds` → "uvažoval N s".

- [ ] **Step 1: Write the failing tests**

Append to `test/session-chat-helpers.test.ts`:

```ts
import { deriveTranscriptRows, activitySummary, workingPhase } from "../apps/web/src/lib/session-chat.js";

function tool(seq: number, id: string, tool: string, status: "started" | "completed" | "failed", title = tool) {
  return ev(seq, "tool_call", { tool_use_id: id, tool, category: "other", title, input_summary: "{}", status, output_excerpt: null, truncated: false });
}

describe("deriveTranscriptRows", () => {
  it("a run with two answers yields two activity groups; bookkeeping yields nothing", () => {
    const rows = deriveTranscriptRows([
      ev(1, "user_message", { text: "hi", source: "chat" }),
      ev(2, "run_started", { run_id: "R1", runner: "claude", instance_id: null, resume: null }),
      ev(3, "reasoning", { summary: "think" }),
      tool(4, "t1", "Read", "completed"),
      ev(5, "assistant_message", { text: "first" }),
      tool(6, "t2", "Bash", "failed"),
      ev(7, "assistant_message", { text: "second" }),
      ev(8, "run_ended", { run_id: "R1", reason: "completed", usage: null }),
      ev(9, "state_changed", { from: "running", to: "suspended", waiting: false }),
    ], null);
    assert.deepEqual(rows.map((r) => r.kind), ["prompt", "activity", "answer", "activity", "answer"]);
    const g1 = rows[1] as Extract<typeof rows[number], { kind: "activity" }>;
    assert.deepEqual(g1.items.map((i) => i.kind), ["reasoning", "tool"]);
    assert.equal(g1.live, false);
  });

  it("the trailing group of the live run is live; a non-completed run end is an error row", () => {
    const rows = deriveTranscriptRows([
      ev(1, "user_message", { text: "hi", source: "chat" }),
      ev(2, "run_started", { run_id: "R1", runner: "claude", instance_id: null, resume: null }),
      tool(3, "t1", "Read", "started"),
    ], "R1");
    assert.deepEqual(rows.map((r) => r.kind), ["prompt", "activity"]);
    assert.equal((rows[1] as { live: boolean }).live, true);

    const ended = deriveTranscriptRows([
      ev(1, "run_started", { run_id: "R1", runner: "claude", instance_id: null, resume: null }),
      ev(2, "run_ended", { run_id: "R1", reason: "error", usage: null }),
    ], null);
    assert.deepEqual(ended.map((r) => r.kind), ["error"]);
  });

  it("question, compaction and handoff keep their markers", () => {
    const rows = deriveTranscriptRows([
      ev(1, "question", { request_id: "q", type: "approval", tool: "x", title: "Smím?", detail: "", options: null, decision: null }),
      ev(2, "compaction", { trigger: "auto" }),
      ev(3, "handoff", { path: null, hash: null }),
    ], null);
    assert.deepEqual(rows.map((r) => r.kind), ["question", "compaction", "summary"]);
  });
});

describe("activitySummary", () => {
  const items = (calls: [string, string][]) =>
    calls.map(([tool, status], i) => ({ kind: "tool" as const, seq: i, call: { tool_use_id: String(i), tool, category: "other" as const, title: tool, input_summary: "{}", status: status as "completed" | "failed", output_excerpt: null, truncated: false } }));

  it("builds the sentence from verb counts", () => {
    const r = activitySummary(items([["Read", "completed"], ["Grep", "completed"], ["Glob", "completed"], ["Edit", "completed"], ["Bash", "completed"], ["Bash", "completed"]]), 12);
    assert.equal(r.text, "Přečteno 3 soubory · upraveno 1 · 2 příkazy · uvažoval 12 s");
    assert.equal(r.failed, 0);
  });

  it("a single call shows its title; failures are counted", () => {
    assert.equal(activitySummary(items([["Bash", "completed"]])).text, "Bash");
    const r = activitySummary(items([["Bash", "failed"], ["Read", "completed"]]));
    assert.equal(r.failed, 1);
    assert.match(r.text, /1 selhal/);
  });

  it("an unknown tool falls back to its own name", () => {
    assert.equal(activitySummary(items([["mcp__portuni__portuni_get_node", "completed"], ["mcp__portuni__portuni_get_node", "completed"]])).text, "2 × mcp__portuni__portuni_get_node");
  });
});

describe("workingPhase", () => {
  const started = ev(1, "run_started", { run_id: "R1", runner: "claude", instance_id: null, resume: null });
  it("is null with no live run and no message in flight", () => {
    assert.equal(workingPhase([], null, null), null);
  });
  it("starting between send and run_started, thinking after it, continuing after a tool completes", () => {
    assert.equal(workingPhase([], null, Date.now()), "starting");
    assert.equal(workingPhase([started], "R1", null), "thinking");
    assert.equal(workingPhase([started, tool(2, "t1", "Read", "completed")], "R1", null), "continuing");
    assert.equal(workingPhase([started, tool(2, "t1", "Read", "started")], "R1", null), null); // the live tool row shows instead
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/session-chat-helpers.test.ts`
Expected: FAIL (functions missing).

- [ ] **Step 3: Implement in `session-chat.ts`**

```ts
// --- Transcript rows (v2 spec, "The activity model") -------------------------

export type ActivityItem =
  | { kind: "reasoning"; seq: number; summary: string }
  | { kind: "tool"; seq: number; call: ToolCallEvent["payload"] }
  | { kind: "file_change"; seq: number; path: string; op: FileChangeOp };

export type TranscriptRow =
  | { kind: "prompt"; key: string; text: string }
  | { kind: "answer"; key: string; text: string }
  | { kind: "activity"; key: string; runId: string | null; items: ActivityItem[]; live: boolean }
  | { kind: "question"; key: string; title: string }
  | { kind: "compaction"; key: string }
  | { kind: "summary"; key: string }
  | { kind: "error"; key: string; message: string };

export function deriveTranscriptRows(events: readonly ChatEvent[], liveRunId: string | null): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let open: Extract<TranscriptRow, { kind: "activity" }> | null = null;
  let currentRun: string | null = null;
  const close = () => { open = null; };
  const push = (item: ActivityItem) => {
    if (!open) {
      open = { kind: "activity", key: `a${item.seq}`, runId: currentRun, items: [], live: false };
      rows.push(open);
    }
    open.items.push(item);
  };
  for (const { seq, event } of collapseToolCalls(events)) {
    switch (event.kind) {
      case "user_message": close(); rows.push({ kind: "prompt", key: `e${seq}`, text: event.payload.text }); break;
      case "assistant_message": close(); rows.push({ kind: "answer", key: `e${seq}`, text: event.payload.text }); break;
      case "reasoning": push({ kind: "reasoning", seq, summary: event.payload.summary }); break;
      case "tool_call": push({ kind: "tool", seq, call: event.payload }); break;
      case "file_change": push({ kind: "file_change", seq, path: event.payload.path, op: event.payload.op }); break;
      case "run_started": currentRun = event.payload.run_id; close(); break;
      case "run_ended":
        close();
        if (event.payload.reason !== "completed") rows.push({ kind: "error", key: `e${seq}`, message: `Běh skončil: ${runEndReasonLabel(event.payload.reason)}` });
        currentRun = null;
        break;
      case "question": close(); rows.push({ kind: "question", key: `e${seq}`, title: event.payload.title }); break;
      case "compaction": close(); rows.push({ kind: "compaction", key: `e${seq}` }); break;
      case "handoff": close(); rows.push({ kind: "summary", key: `e${seq}` }); break;
      case "error": close(); rows.push({ kind: "error", key: `e${seq}`, message: event.payload.message }); break;
      case "state_changed": break;
    }
  }
  if (open && liveRunId !== null && (open as TranscriptRow & { runId: string | null }).runId === liveRunId) {
    (open as { live: boolean }).live = true;
  }
  return rows;
}
```

(Note: `open`'s narrowing inside closures needs the `as` casts shown or a local `let` of the exact type; write it whichever way `tsc` accepts without `any`.) Move `runEndReasonLabel` from `SessionChat.tsx` into this file and export it: `completed → "dokončeno", interrupted → "přerušeno", suspended → "pozastaveno", error → "chyba", limit → "limit", host_lost → "proces osiřel"`.

```ts
// --- The activity sentence ---------------------------------------------------

type Verb = "read" | "edited" | "created" | "command";
const TOOL_VERBS: Record<string, Verb> = {
  Read: "read", Glob: "read", Grep: "read", LS: "read", WebFetch: "read", WebSearch: "read",
  Edit: "edited", MultiEdit: "edited", NotebookEdit: "edited",
  Write: "created",
  Bash: "command",
};

export function toolVerbCounts(items: readonly ActivityItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const key = TOOL_VERBS[item.call.tool] ?? `tool:${item.call.tool}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function czechCount(n: number, one: string, few: string, many: string): string {
  return n === 1 ? one : n >= 2 && n <= 4 ? few : many;
}

export function activitySummary(items: readonly ActivityItem[], reasoningSeconds?: number | null): { text: string; failed: number } {
  const tools = items.filter((i): i is Extract<ActivityItem, { kind: "tool" }> => i.kind === "tool");
  const failed = tools.filter((t) => t.call.status === "failed").length;
  if (tools.length === 1 && !reasoningSeconds) {
    const t = tools[0];
    return { text: failed ? `${t.call.title || t.call.tool} · selhal` : t.call.title || t.call.tool, failed };
  }
  const parts: string[] = [];
  const counts = toolVerbCounts(items);
  const read = counts.get("read"); if (read) parts.push(`Přečteno ${read} ${czechCount(read, "soubor", "soubory", "souborů")}`);
  const edited = counts.get("edited"); if (edited) parts.push(`upraveno ${edited}`);
  const created = counts.get("created"); if (created) parts.push(`vytvořeno ${created}`);
  const cmd = counts.get("command"); if (cmd) parts.push(`${cmd} ${czechCount(cmd, "příkaz", "příkazy", "příkazů")}`);
  for (const [key, n] of counts) if (key.startsWith("tool:")) parts.push(`${n} × ${key.slice(5)}`);
  if (reasoningSeconds) parts.push(`uvažoval ${reasoningSeconds} s`);
  if (failed) parts.push(`${failed} ${czechCount(failed, "selhal", "selhaly", "selhalo")}`);
  if (parts.length === 0 && items.some((i) => i.kind === "reasoning")) parts.push("Uvažoval");
  const text = parts.join(" · ");
  return { text: text.charAt(0).toUpperCase() + text.slice(1), failed };
}

// --- The working row -----------------------------------------------------------

export type WorkingPhase = "starting" | "thinking" | "continuing";
export const WORKING_LABEL: Record<WorkingPhase, string> = {
  starting: "Spouštím…",
  thinking: "Přemýšlím…",
  continuing: "Pokračuji…",
};

// null = nothing to show: no run and no send in flight, or the run's last
// event is a still-running tool (the live activity row shows that one).
export function workingPhase(events: readonly ChatEvent[], liveRunId: string | null, sentAt: number | null): WorkingPhase | null {
  if (liveRunId === null) return sentAt !== null ? "starting" : null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event;
    if (e.kind === "run_started" && e.payload.run_id === liveRunId) return "thinking";
    if (e.kind === "tool_call") return e.payload.status === "started" ? null : "continuing";
    if (e.kind === "assistant_message" || e.kind === "reasoning") return "continuing";
  }
  return "thinking";
}
```

- [ ] **Step 4: Run tests until green; adjust the expected strings only if the Czech is wrong, never the rule**

Run: `node --import tsx --test test/session-chat-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/session-chat.ts test/session-chat-helpers.test.ts
git commit -m "feat(web): transcript row derivation, the activity sentence and the working label"
```

### Task 12: Delta coalescing

**Files:**
- Modify: `apps/web/src/lib/session-chat.ts`
- Test: `test/session-chat-helpers.test.ts`

**Interfaces:**
- Produces:

```ts
export interface DeltaCoalescer {
  push(delta: { run_id: string; channel: "text" | "reasoning"; text: string }): void;
  // Flush now (a run_ended, an unmount): delivers what is buffered, cancels the pending tick.
  flush(): void;
  clear(): void;
}
export function createDeltaCoalescer(
  deliver: (batch: { run_id: string; channel: "text" | "reasoning"; text: string }[]) => void,
  schedule: (cb: () => void) => () => void, // requestAnimationFrame in the browser, injected in tests
): DeltaCoalescer;
```

- [ ] **Step 1: Write the failing test**

```ts
import { createDeltaCoalescer } from "../apps/web/src/lib/session-chat.js";

describe("createDeltaCoalescer", () => {
  it("N frames in one tick deliver as one batch with the text concatenated per channel", () => {
    let tick: (() => void) | null = null;
    const delivered: unknown[] = [];
    const c = createDeltaCoalescer((b) => delivered.push(b), (cb) => { tick = cb; return () => { tick = null; }; });
    c.push({ run_id: "R1", channel: "text", text: "ab" });
    c.push({ run_id: "R1", channel: "text", text: "cd" });
    c.push({ run_id: "R1", channel: "reasoning", text: "th" });
    assert.equal(delivered.length, 0);
    tick!();
    assert.deepEqual(delivered, [[{ run_id: "R1", channel: "text", text: "abcd" }, { run_id: "R1", channel: "reasoning", text: "th" }]]);
  });

  it("flush delivers immediately and cancels the tick; clear drops without delivering", () => {
    let cancelled = 0;
    const delivered: unknown[] = [];
    const c = createDeltaCoalescer((b) => delivered.push(b), () => () => { cancelled++; });
    c.push({ run_id: "R1", channel: "text", text: "x" });
    c.flush();
    assert.equal(delivered.length, 1);
    assert.equal(cancelled, 1);
    c.push({ run_id: "R1", channel: "text", text: "y" });
    c.clear();
    c.flush();
    assert.equal(delivered.length, 1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test test/session-chat-helpers.test.ts`.

- [ ] **Step 3: Implement**

```ts
// --- Delta coalescing (v2 spec, "Streaming") ----------------------------------
// A burst of delta frames costs one render: frames are buffered per
// (run, channel) and delivered once per scheduler tick. The desktop bridge
// forwards frames unchanged; this is the webview's own batching.

type Delta = { run_id: string; channel: "text" | "reasoning"; text: string };

export interface DeltaCoalescer {
  push(delta: Delta): void;
  flush(): void;
  clear(): void;
}

export function createDeltaCoalescer(deliver: (batch: Delta[]) => void, schedule: (cb: () => void) => () => void): DeltaCoalescer {
  const buffer = new Map<string, Delta>();
  let cancel: (() => void) | null = null;
  const drain = () => {
    cancel = null;
    if (buffer.size === 0) return;
    const batch = [...buffer.values()];
    buffer.clear();
    deliver(batch);
  };
  return {
    push(delta) {
      const key = `${delta.run_id}\u0000${delta.channel}`;
      const prev = buffer.get(key);
      buffer.set(key, prev ? { ...prev, text: prev.text + delta.text } : { ...delta });
      if (!cancel) cancel = schedule(drain);
    },
    flush() {
      if (cancel) { cancel(); cancel = null; }
      drain();
    },
    clear() {
      buffer.clear();
      if (cancel) { cancel(); cancel = null; }
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**, then **commit**

```bash
git add apps/web/src/lib/session-chat.ts test/session-chat-helpers.test.ts
git commit -m "feat(web): coalesce streamed deltas to one state update per frame"
```

### Task 13: SessionChat renders rows, the live row and the working row

**Files:**
- Modify: `apps/web/src/components/SessionChat.tsx` (replace `EventRow`/`SystemMarker`/`displayEvents`; new `ActivityGroupRow`, `WorkingRow`; wire the coalescer; `sentAt` state)

**Interfaces:**
- Consumes: Task 10's `Loader`, `ChainOfThought*`; Task 11's `deriveTranscriptRows`, `activitySummary`, `workingPhase`, `WORKING_LABEL`, `runEndReasonLabel`; Task 12's `createDeltaCoalescer`; `useNowTick` (`apps/web/src/lib/use-now-tick.ts`).

- [ ] **Step 1: Wire the coalescer**

Replace the `offDelta` handler body:

```ts
    const coalescer = createDeltaCoalescer(
      (batch) => {
        for (const d of batch) {
          if (d.channel === "reasoning") setReasoningDeltaBuffers((prev) => appendDelta(prev, d.run_id, d.text));
          else setTextDeltaBuffers((prev) => appendDelta(prev, d.run_id, d.text));
        }
      },
      (cb) => {
        const id = requestAnimationFrame(cb);
        return () => cancelAnimationFrame(id);
      },
    );
    const offDelta = sessionsClient.onDelta(session.id, (delta) => coalescer.push(delta));
```

In the `onEvent` handler's `run_ended` branch call `coalescer.flush()` before clearing the buffers; in the cleanup call `coalescer.clear()`.

- [ ] **Step 2: Track the send moment**

`const [sentAt, setSentAt] = useState<number | null>(null);` — set `Date.now()` in `handlePromptSubmit` after `sessionsClient.message` resolves; reset to `null` when `run_started` arrives (in the `onEvent` handler) and when a send throws.

- [ ] **Step 3: Derive rows and render**

```tsx
  const rows = useMemo(() => deriveTranscriptRows(events, liveRunId), [events, liveRunId]);
  const phase = runIsLive || sentAt !== null ? workingPhase(events, liveRunId, sentAt) : null;
  const showWorking = phase !== null && !streamingText && !streamingReasoning;
```

Transcript body:

```tsx
              {rows.map((row) => (
                <TranscriptRowView key={row.key} row={row} onOpenFile={onOpenFile} />
              ))}
              {streamingReasoning && (…unchanged Reasoning…)}
              {streamingText && (…unchanged Message…)}
              {showWorking && <WorkingRow phase={phase} />}
```

`TranscriptRowView` (replaces `EventRow`):

```tsx
function TranscriptRowView({ row, onOpenFile }: { row: TranscriptRow; onOpenFile?: (relPath: string) => void }) {
  switch (row.kind) {
    case "prompt": return (<Message from="user"><MessageContent className="group-[.is-user]:border group-[.is-user]:border-[var(--color-border)] group-[.is-user]:bg-[var(--color-accent-soft)]"><MessageResponse>{row.text}</MessageResponse></MessageContent></Message>);
    case "answer": return (<Message from="assistant"><MessageContent><MessageResponse>{row.text}</MessageResponse></MessageContent></Message>);
    case "activity": return <ActivityGroupRow row={row} onOpenFile={onOpenFile} />;
    case "question": return <SystemMarker>Otázka: {row.title}</SystemMarker>;
    case "compaction": return (<Checkpoint className="justify-center text-[11px]"><CheckpointIcon className="size-3.5" />Komprese kontextu</Checkpoint>);
    case "summary": return <SystemMarker>Shrnutí uloženo</SystemMarker>;
    case "error": return (<SystemMarker><span style={{ color: "var(--color-danger)" }}>{row.message}</span></SystemMarker>);
  }
}
```

`ActivityGroupRow`:

```tsx
function ActivityGroupRow({ row, onOpenFile }: { row: Extract<TranscriptRow, { kind: "activity" }>; onOpenFile?: (relPath: string) => void }) {
  const [open, setOpen] = useState(false);
  const running = row.live ? row.items.find((i) => i.kind === "tool" && i.call.status === "started") : undefined;
  const summary = activitySummary(row.items);
  const color = summary.failed > 0 ? "var(--color-danger)" : undefined;
  return (
    <ChainOfThought open={row.live || open} onOpenChange={setOpen} className="text-[12.5px]">
      <ChainOfThoughtHeader className="text-[12.5px]" style={{ color }}>
        {row.live ? <Shimmer duration={1.5}>{summary.text || "Pracuji…"}</Shimmer> : summary.text}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {row.live && !open && running
          ? <ToolStep item={running} onOpenFile={onOpenFile} />
          : row.items.map((item) => <ToolStep key={item.seq} item={item} onOpenFile={onOpenFile} />)}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

function ToolStep({ item, onOpenFile }: { item: ActivityItem; onOpenFile?: (relPath: string) => void }) {
  if (item.kind === "reasoning") {
    return (
      <ChainOfThoughtStep label="Uvažování" icon={BrainIcon}>
        <Reasoning isStreaming={false} defaultOpen={false}><ReasoningTrigger getThinkingMessage={reasoningTriggerMessage} /><ReasoningContent>{item.summary}</ReasoningContent></Reasoning>
      </ChainOfThoughtStep>
    );
  }
  if (item.kind === "file_change") {
    return (
      <ChainOfThoughtStep label={onOpenFile ? <Button variant="link" size="xs" className="h-auto p-0 text-inherit" onClick={() => onOpenFile(item.path)}>{item.path}</Button> : item.path} description={fileChangeOpLabel(item.op)} />
    );
  }
  const p = item.call;
  const failed = p.status === "failed";
  return (
    <ChainOfThoughtStep label={p.title || p.tool} status={p.status === "started" ? "active" : "complete"}>
      <Tool defaultOpen={false} className="mb-0 bg-[var(--color-surface)]">
        <ToolHeader title={p.title || undefined} tool={p.tool} state={p.status} className="p-2.5" />
        <ToolContent>
          {p.input_summary && <ToolInput input={p.input_summary} />}
          <ToolOutput output={failed ? null : p.output_excerpt} errorText={failed ? p.output_excerpt : null} />
        </ToolContent>
      </Tool>
    </ChainOfThoughtStep>
  );
}
```

`WorkingRow`:

```tsx
function WorkingRow({ phase }: { phase: WorkingPhase }) {
  const [since] = useState(() => Date.now());
  const now = useNowTick(1000);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-text-dim)]" role="status">
      <Loader size={14} />
      <Shimmer duration={1.5}>{WORKING_LABEL[phase]}</Shimmer>
      <span className="tabular-nums">{seconds} s</span>
    </div>
  );
}
```

Delete `EventRow`, the `run_started`/`run_ended`/`state_changed` markers, `runEndReasonLabel` (now imported), keep `fileChangeOpLabel`, `SystemMarker`, `reasoningTriggerMessage`. `ChainOfThoughtHeader`'s default icon is `BrainIcon`; pass no children icon change (fine). Import `BrainIcon` from `lucide-react`.

- [ ] **Step 4: Verify**

`npm --prefix apps/web run typecheck && npm --prefix apps/web run build`. In the browser with a real run: send → "Spouštím…" row with a counter → run starts → "Přemýšlím…" → streaming reasoning/text → a tool starts → the live group shows its running tool → tool ends → "Pokračuji…" → answer streams → run ends → the group collapses to one sentence, no "Běh spuštěn/ukončen" markers, the prompt and answer are the only full-weight elements. Expand a historical group — the `ChainOfThought` list with a `Tool` per call.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SessionChat.tsx
git commit -m "feat(web): the conversation is the content -- folded activity groups, a live row and a working row"
```

### Phase 3 gate

- [ ] `npm run qa` and `npm --prefix apps/web run build`.

---

## Phase 4 — Context

### Task 14: The `context_usage` canonical event from the Claude adapter

**Files:**
- Modify: `apps/server/domain/runner/types.ts` (new `ContextUsageEvent`, added to `CanonicalEvent`)
- Modify: `apps/web/src/lib/session-chat.ts` (the mirror)
- Modify: `apps/server/domain/runner/adapters/claude.ts:300-345` (state gains `contextMaxTokens`, `model`), `translateAssistantMessage` (emit after the blocks), the `result` branch (update max, emit)
- Test: `test/runner-claude-adapter.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ContextUsageEvent {
  kind: "context_usage";
  payload: {
    run_id: string;
    model: string | null;
    used_tokens: number;         // input + cache_creation + cache_read of the latest assistant usage
    max_tokens: number | null;   // modelUsage[model].contextWindow from the latest result
    input_tokens: number;
    cached_tokens: number;       // cache_creation + cache_read
    output_tokens: number;
  };
}
```

- [ ] **Step 1: Write the failing test**

In `test/runner-claude-adapter.test.ts` (reuse `makeFakeQuery`, `makeRunStart`, `resultMessage`, and the file's collect-events helper):

```ts
  it("emits context_usage after every assistant message and every result; max_tokens is null before the first result", async () => {
    const script: SDKMessage[] = [
      { type: "assistant", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 } } } as unknown as SDKMessage,
      resultMessage({ usage: { input_tokens: 150, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: { "claude-opus-5": { contextWindow: 200000, inputTokens: 150, outputTokens: 7 } } }),
    ];
    const { events } = await runScript(script); // the file's helper that runs the adapter and collects sink events
    const usages = events.filter((e): e is Extract<CanonicalEvent, { kind: "context_usage" }> => "kind" in e && e.kind === "context_usage");
    assert.equal(usages.length, 2);
    assert.deepEqual(usages[0].payload, { run_id: "R1", model: "claude-opus-5", used_tokens: 150, max_tokens: null, input_tokens: 100, cached_tokens: 50, output_tokens: 5 });
    assert.equal(usages[1].payload.max_tokens, 200000);
    assert.equal(usages[1].payload.used_tokens, 150);
  });
```

Adapt the helper name to what the file actually uses (`grep -n "async function run\|function collect" test/runner-claude-adapter.test.ts`).

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test test/runner-claude-adapter.test.ts`.

- [ ] **Step 3: Implement**

`types.ts`: add the interface above (with a comment pointing at the v2 spec, "The context ring") and `| ContextUsageEvent` to the union. `session-chat.ts`: identical mirror.

`claude.ts`: `RunTranslationState` gains `contextMaxTokens: number | null; model: string | null;` (init `null`). Add:

```ts
function usageNumber(usage: Record<string, unknown> | undefined, key: string): number {
  const v = usage?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function contextUsageFrom(runId: string, state: RunTranslationState, usage: Record<string, unknown> | undefined): CanonicalEvent {
  const input = usageNumber(usage, "input_tokens");
  const cached = usageNumber(usage, "cache_creation_input_tokens") + usageNumber(usage, "cache_read_input_tokens");
  return {
    kind: "context_usage",
    payload: {
      run_id: runId,
      model: state.model,
      used_tokens: input + cached,
      max_tokens: state.contextMaxTokens,
      input_tokens: input,
      cached_tokens: cached,
      output_tokens: usageNumber(usage, "output_tokens"),
    },
  };
}
```

In `translateAssistantMessage` (needs `runId` — add a parameter, update the one call site), after the block loop: `state.model = typeof msg.message.model === "string" ? msg.message.model : state.model; sink(contextUsageFrom(runId, state, msg.message.usage as Record<string, unknown> | undefined));`. In the `result` branch, before `providerResultFailure`: 

```ts
        const modelUsage = (msg as { modelUsage?: Record<string, { contextWindow?: unknown }> }).modelUsage ?? {};
        const entry = state.model ? modelUsage[state.model] : Object.values(modelUsage)[0];
        if (entry && typeof entry.contextWindow === "number") state.contextMaxTokens = entry.contextWindow;
        sink(contextUsageFrom(run.runId, state, msg.usage as Record<string, unknown> | undefined));
```

- [ ] **Step 4: Run to verify it passes**, plus `npm run typecheck` (the web mirror must compile: every `switch` over `event.kind` in `SessionChat.tsx`/`session-chat.ts` gets a `case "context_usage": break;`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/domain/runner/types.ts apps/server/domain/runner/adapters/claude.ts apps/web/src/lib/session-chat.ts test/runner-claude-adapter.test.ts
git commit -m "feat(runner): context_usage canonical event from the Claude adapter"
```

### Task 15: The two counters on `sessions`, folded from the latest event

**Files:**
- Modify: `apps/server/infra/schema-triggers.ts:158-190` (`DDL_SESSIONS`), `apps/server/infra/schema-migrations.ts` (036's `sessions_new`, new migration 039), `apps/server/infra/schema.pg.ts:176-200`
- Modify: `apps/server/shared/types.ts:143-171` (`SessionRow`), `apps/server/shared/api-types.ts` (`SessionSummary`), `apps/server/api/sessions.ts` (`toSummary`, `PatchSessionBody`), `apps/server/domain/runner/store.ts` (`PatchSessionInput`, `patchSession`), `apps/server/domain/runner/session-runtime.ts:376-395` (`handleAdapterEvent`)
- Test: `test/migration-039-sessions-context-counters.test.ts` (new), `test/api-sessions-runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/migration-039-sessions-context-counters.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { runMigration039 } from "../apps/server/infra/schema-migrations.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("migration 039 sessions context counters", () => {
  it("fresh install has both columns", async () => {
    const db = createClient({ url: ":memory:" });
    const { ensureSchemaOn } = await import("../apps/server/infra/schema.js");
    await ensureSchemaOn(db);
    const cols = new Set((await db.execute("PRAGMA table_info(sessions)")).rows.map((r) => r.name as string));
    assert.ok(cols.has("context_used_tokens"));
    assert.ok(cols.has("context_max_tokens"));
  });
  it("is idempotent", async () => {
    const { db } = await makeSharedDb("libsql");
    await runMigration039(db);
    await runMigration039(db);
  });
});
```

`test/api-sessions-runtime.test.ts`:

```ts
  test("a context_usage event folds its counters into the session summary", async () => {
    installRuntime([
      { kind: "context_usage", payload: { run_id: "ignored", model: "m", used_tokens: 1234, max_tokens: 200000, input_tokens: 1000, cached_tokens: 234, output_tokens: 9 } },
      { wait: "message" },
    ]);
    const res = await call(makeIdentity("U1"), "POST", "/sessions", { node_id: dbFixture.nodeId, brief: "go", runner: "fake" });
    const { session } = JSON.parse(res.body) as { session: SessionSummary };
    const listRes = await call(makeIdentity("U1"), "GET", `/nodes/${dbFixture.nodeId}/sessions`);
    const row = (JSON.parse(listRes.body) as { sessions: SessionSummary[] }).sessions.find((s) => s.id === session.id)!;
    assert.equal(row.context_used_tokens, 1234);
    assert.equal(row.context_max_tokens, 200000);
  });
```

(If the fake's sink delivers the script asynchronously, await `runtime.drain?.(session.id)` or poll `GET /sessions/:id/events` for the event before reading the list, the way neighbouring tests wait for `run_started`.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`schema-triggers.ts` `DDL_SESSIONS`, after `effort`:

```sql
    -- v2 task surface: the latest context_usage event's counters, so a
    -- list row and the header render the ring without reading the log.
    context_used_tokens INTEGER,
    context_max_tokens INTEGER,
```

Same two lines in 036's `sessions_new` (CREATE only, the INSERT column list is unchanged) and in `PG_BASELINE_DDL`'s sessions table. Migration:

```ts
  // v2 task surface (docs/superpowers/specs/2026-09-21-task-surface-v2-design.md,
  // "The context ring"): two nullable counters, two ADD COLUMNs, no rebuild,
  // no index. Also in DDL_SESSIONS, 036's rebuild and PG_BASELINE_DDL; no
  // pg-002 (cutover not run).
  {
    id: "039_sessions_context_counters",
    isApplied: async (db) => {
      const r = await db.execute("PRAGMA table_info(sessions)");
      return r.rows.some((row) => String(row.name) === "context_max_tokens");
    },
    up: runMigration039,
  },
…
export async function runMigration039(db: DbClient): Promise<void> {
  await db.execute("ALTER TABLE sessions ADD COLUMN context_used_tokens INTEGER");
  await db.execute("ALTER TABLE sessions ADD COLUMN context_max_tokens INTEGER");
}
```

`SessionRow`: `context_used_tokens: z.union([z.number(), z.null()]), context_max_tokens: z.union([z.number(), z.null()]),` — check `getSessionRow`/row mapping in `domain/sessions.ts` parses numerics (grep `name_is_custom: Number(` for the pattern and add both). `SessionSummary` gains the same two fields; `toSummary` copies them. `PatchSessionInput` and `PatchSessionBody` gain `context_used_tokens?: number | null; context_max_tokens?: number | null;` (`z.number().int().nullable().optional()`), `patchSession` writes them. `handleAdapterEvent`, after `appendAndPublish`:

```ts
    if (canonical.kind === "context_usage") {
      await store.patchSession(sessionId, {
        context_used_tokens: canonical.payload.used_tokens,
        context_max_tokens: canonical.payload.max_tokens,
      });
      return;
    }
```

(In a team workspace this is `CentralSessionStore.patchSession` → `PATCH /sessions/:id`, which the extended body accepts; the Task 8 guard does not fire because the body carries no runner/instance.)

- [ ] **Step 4: Run** `npm test` and `npm run test:pglite`; both green.

- [ ] **Step 5: Commit**

```bash
git add apps/server test/migration-039-sessions-context-counters.test.ts test/api-sessions-runtime.test.ts
git commit -m "feat(server,runner): sessions carry the latest context counters (migration 039)"
```

### Task 16: The ring in the header

**Files:**
- Create: `apps/web/src/components/ui/hover-card.tsx`, `apps/web/src/components/ui/progress.tsx` (shadcn, `radix-ui` umbrella, header note)
- Create: `apps/web/src/components/ai-elements/context.tsx` (AI Elements `context`, stripped)
- Create: `apps/web/src/lib/context-ring.ts`
- Modify: `apps/web/src/components/SessionChat.tsx` (header ring, Continue button variant)
- Test: `test/context-ring.test.ts`

**Interfaces:**
- Produces in `context-ring.ts`:

```ts
export const CONTEXT_WARN_FRACTION = 0.8;
export type ContextRingState = { used: number; max: number | null; fraction: number | null; warn: boolean; label: string };
// From the session summary's counters or the latest context_usage event,
// whichever is newer (the event wins while the thread is live).
export function contextRingState(used: number | null, max: number | null): ContextRingState | null;
export function latestContextUsage(events: readonly ChatEvent[]): { used: number; max: number | null } | null;
```

`label`: `"42 %"` when `max` is known (rounded, `"<1 %"` under one), else `"12,3 k tokenů"` (Czech compact: `k` thousands with a comma decimal; `formatTokens(n)` exported).

`context.tsx` keeps `Context`, `ContextTrigger`, `ContextContent`, `ContextContentHeader`, `ContextContentBody`, `ContextInputUsage`, `ContextOutputUsage`, `ContextCacheUsage`; drops `ContextContentFooter`, `ContextReasoningUsage`, `TokensWithCost`'s cost, the `ai`/`tokenlens` imports; `usage` is a local `{ inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }`; `maxTokens` is `number | null` and the icon/percent render the bare count when null.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contextRingState, latestContextUsage, formatTokens } from "../apps/web/src/lib/context-ring.js";

describe("contextRingState", () => {
  it("is null with nothing recorded", () => { assert.equal(contextRingState(null, null), null); });
  it("percent under the threshold is not a warning; at 80 % it is", () => {
    assert.deepEqual(contextRingState(79_000, 100_000), { used: 79_000, max: 100_000, fraction: 0.79, warn: false, label: "79 %" });
    assert.equal(contextRingState(80_000, 100_000)!.warn, true);
  });
  it("without a max it shows the count", () => {
    const s = contextRingState(12_345, null)!;
    assert.equal(s.fraction, null);
    assert.equal(s.warn, false);
    assert.equal(s.label, "12,3 k tokenů");
  });
});

describe("latestContextUsage", () => {
  it("returns the newest event's counters", () => {
    const ev = (seq: number, used: number, max: number | null) => ({ seq, event: { kind: "context_usage" as const, payload: { run_id: "R", model: null, used_tokens: used, max_tokens: max, input_tokens: used, cached_tokens: 0, output_tokens: 0 } } });
    assert.deepEqual(latestContextUsage([ev(1, 10, null), ev(2, 20, 100)]), { used: 20, max: 100 });
    assert.equal(latestContextUsage([]), null);
  });
});

describe("formatTokens", () => {
  it("compact with a Czech decimal", () => {
    assert.equal(formatTokens(950), "950");
    assert.equal(formatTokens(12_345), "12,3 k");
    assert.equal(formatTokens(200_000), "200 k");
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `context-ring.ts`**

```ts
import type { ChatEvent } from "./session-chat";

export const CONTEXT_WARN_FRACTION = 0.8;

export type ContextRingState = { used: number; max: number | null; fraction: number | null; warn: boolean; label: string };

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const text = k >= 100 ? String(Math.round(k)) : (Math.round(k * 10) / 10).toString().replace(".", ",");
  return `${text} k`;
}

export function contextRingState(used: number | null, max: number | null): ContextRingState | null {
  if (used === null) return null;
  if (max === null || max <= 0) return { used, max: null, fraction: null, warn: false, label: `${formatTokens(used)} tokenů` };
  const fraction = used / max;
  const percent = Math.round(fraction * 100);
  return { used, max, fraction, warn: fraction >= CONTEXT_WARN_FRACTION, label: percent < 1 ? "<1 %" : `${percent} %` };
}

export function latestContextUsage(events: readonly ChatEvent[]): { used: number; max: number | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event;
    if (e.kind === "context_usage") return { used: e.payload.used_tokens, max: e.payload.max_tokens };
  }
  return null;
}
```

- [ ] **Step 4: Copy the three components and render the ring**

`SessionChat.tsx` header right side, before the buttons:

```tsx
  const liveUsage = useMemo(() => latestContextUsage(events), [events]);
  const ring = contextRingState(liveUsage?.used ?? session.context_used_tokens, liveUsage?.max ?? session.context_max_tokens);
…
          {ring && (
            <Context usedTokens={ring.used} maxTokens={ring.max}>
              <ContextTrigger className="h-7 gap-1.5 px-1.5 text-[12px]" style={{ color: ring.warn ? "var(--color-node-process)" : "var(--color-text-dim)" }} title="Využití kontextového okna" />
              <ContextContent>
                <ContextContentHeader />
                <ContextContentBody className="space-y-1"><ContextInputUsage /><ContextCacheUsage /><ContextOutputUsage /></ContextContentBody>
              </ContextContent>
            </Context>
          )}
```

The stripped `ContextTrigger` renders `ring.label`-style text: pass `label={ring.label}` (add that prop in the copy; it replaces the en-US percent formatter). `ContextContentHeader` shows `formatTokens(used) / formatTokens(max)` or just `used` when `max` is null (import `formatTokens`). The `usage` prop for the breakdown comes from the latest event's `input_tokens`/`cached_tokens`/`output_tokens` (extend `latestContextUsage` to return them too, or pass `usage` only when `liveUsage` exists).

"Pokračovat v nové session": `<Button variant={ring?.warn ? "default" : "outline"} size="sm" …>` — give `HeaderButton` a `variant` prop.

- [ ] **Step 5: Verify**

`node --import tsx --test test/context-ring.test.ts && npm --prefix apps/web run typecheck && npm --prefix apps/web run build`. In the browser: a draft has no ring; after the first assistant message a ring with a count appears; after the first result it shows a percentage; hover shows used/max and the breakdown; a thread past 80 % turns amber and the Continue button becomes filled. A reload shows the ring from the summary before the log replays.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ui/hover-card.tsx apps/web/src/components/ui/progress.tsx apps/web/src/components/ai-elements/context.tsx apps/web/src/lib/context-ring.ts apps/web/src/components/SessionChat.tsx test/context-ring.test.ts
git commit -m "feat(web): the context ring in the thread header with the 80 % warning"
```

### Task 17: Docs

**Files:**
- Modify: `docs/architecture/task-surface-web.md` (SessionChat: column, rows, live/working rows, coalescing; Sidebar thread rows: one active row, CLI rule, no suspended dot; "Model and effort picker" → "The composer's rows"; Event rendering: the row table; Known gaps: drop "no ring / no token accounting"; Helpers and tests: the new files)
- Modify: `docs/architecture/sessions-and-runner.md` (`context_usage` event, the two counters, draft runner/instance at creation, the PATCH guard)
- Modify: `docs/superpowers/specs/2026-09-15-task-surface-design.md` (one line under the title: superseded sections → the v2 spec)
- Modify: `sites/docs/src/content/docs/guides/working-in-the-app.md` (the composer's two rows, the ring, the palette footer), `sites/docs/src/content/docs/reference/runners.md` (runner/instance is chosen per thread while it is new; default from the organisation)
- Modify: `CLAUDE.md` "Sessions and runner" bullet: "Migration 036 carries `draft`, `model`, `effort`; 039 the context counters; …"

- [ ] **Step 1: Write the doc changes** (what the reader must know, no history).
- [ ] **Step 2: Build the docs site** — `npm --prefix sites/docs run build`.
- [ ] **Step 3: Commit**

```bash
git add docs CLAUDE.md sites/docs
git commit -m "docs: task surface v2 -- rows, composer, context ring, palette, draft runner"
```

---

## Phase 5 — Přehled

### Task 18: Counter strip, row cap, threads only

**Files:**
- Create: `apps/web/src/lib/overview-view.ts` (pure: `overviewCounters`, `capRows`, `splitThreadsAndCli`)
- Modify: `apps/web/src/components/OverviewView.tsx` (width, strip, cards with the cap footer)
- Test: `test/overview-view-helpers.test.ts`

**Interfaces:**

```ts
export const OVERVIEW_ROW_CAP = 8;
export function capRows<T>(rows: readonly T[], expanded: boolean): { shown: T[]; hidden: number };
export function splitThreadsAndCli(rows: readonly OverviewSessionRow[]): { threads: OverviewSessionRow[]; cli: { total: number; running: number } };
export function overviewCounters(payload: { running: OverviewSessionRow[]; suspended: OverviewSessionRow[]; attention: number; unsynced: number }, meId: string | null): { waiting: number; running: number; attention: number; unsynced: number };
```

- [ ] **Step 1: Tests** for the three helpers (cap at 8 with `hidden`, expanded shows all; CLI rows split by `cli !== null || session_type !== "interactive_task"`, running counted; counters restricted to the caller's own sessions like `sortInboxSessions`).
- [ ] **Step 2: Implement the helpers**, run the tests.
- [ ] **Step 3: The view**: `max-w-[1400px] px-6 py-6`; a `grid grid-cols-2 gap-4 lg:grid-cols-4` strip of `Card`s (number 24 px semibold, label 12 px dim, whole card a button); each list card takes `expanded` state, renders `capRows(...).shown`, and a footer `Button variant="link" size="xs"` "Zobrazit všech N" when `hidden > 0`; `SessionsCard` lists `threads` and prints the CLI line in its footer; the unsynced count comes from `useSyncPending` (check `apps/web/src/lib/use-sync-pending.ts` for the hook's shape) and the counter opens the existing Nesynchronizováno dialog via a new `onOpenSyncOverview` prop wired in `App.tsx`.
- [ ] **Step 4: Verify** in the browser at 1400 px and 1000 px; typecheck; commit `feat(web): Přehled with a counter strip, an 8-row cap per card and threads only in Relace`.

### Final gate

- [ ] `scripts/agent-gate.sh` green. Open a PR from `feat/task-surface-v2` to `main` titled `feat(web,runner,server): task surface v2 — the conversation is the content` with the phases as the body and the spec linked.

---

## Self-review

- **Spec coverage:** column (T3), activity model rows/group/live/working (T11, T13), streaming coalescing (T12), composer rows (T9 + existing model/effort), header (T4, T16), runner/instance on the draft incl. record route, PATCH guard, promotion (T7, T8), context event/columns/ring (T14, T15, T16), left column metrics/one active row/CLI rule/dot rule (T5), palette (T6), unsynced link (T2), draft chip (T1), components copied (T10, T16), docs (T17). Testing list: rows/summary/working/coalescing (T11, T12), adapter (T14), sessions (T7, T8, T15), left column reducers (T5), ring (T16).
- **Placeholders:** none; every code step carries its code.
- **Type consistency:** `TranscriptRow`/`ActivityItem` (T11) are what T13 renders; `createDeltaCoalescer` (T12) is what T13 wires; `ContextUsageEvent` (T14) is what T15 folds and T16 reads; `CreateDraftSessionInput.runner/instance_id` (T7) is what the record route and central client forward; `encodeRunnerChoice`/`decodeRunnerChoice` (T9) are used only inside T9.
