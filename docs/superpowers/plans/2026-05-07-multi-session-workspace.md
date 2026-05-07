# Multi-session workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-node single-terminal lifecycle with a Workspace view that hosts multiple parallel PTY sessions, keeps them alive across node switches, and surfaces activity per session and per node.

**Architecture:** Lift terminal session state from `DetailPane` into `App.tsx` (single source of truth), keep every `TerminalPane` mounted with `display:none` so the underlying PTY never gets killed by a tab switch, and add a third top-level view (Práce) with a 3-column layout (node list / terminal tabs+pane / collapsible detail). The Tauri PTY backend (`src-tauri/src/pty.rs`) already supports a session map — only the frontend needs to evolve.

**Tech Stack:** React 19, TypeScript, xterm.js v6 + addons (already wired), Tauri 2 + portable-pty (already wired), no new runtime deps. Backend tests run via `node --import tsx --test test/*.test.ts`.

**Spec:** See `docs/superpowers/specs/2026-05-07-multi-session-workspace-design.md`.

**Resolved open questions (from spec):**

- **Levý sloupec** — only nodes with active sessions in v1. Pinning bez session přidáme později, pokud bude potřeba; YAGNI.
- **Detail panel** — collapsible. Toggle button vpravo; sklopený stav persistován jako `workspace.detailVisible` v localStorage vedle `agent_command`.
- **Persistence sessions přes restart** — out of scope for v1 (Cmd+Q kills all PTY children, agreed).

---

## File Structure

**New files:**

- `app/src/lib/sessions.ts` — Pure session-list helpers + `TerminalSession` type. No React.
- `app/src/lib/sessions.types.ts` (optional, fold into `sessions.ts` if small) — types only.
- `app/src/components/WorkspaceView.tsx` — 3-column layout shell, owns the detail-collapse state.
- `app/src/components/WorkspaceNodeList.tsx` — Left column: nodes that currently have ≥1 session.
- `app/src/components/TerminalTabs.tsx` — Tab strip + new-session button + per-tab close confirm.
- `app/src/components/WorkspaceEmpty.tsx` — Empty state with node search picker.
- `app/src/components/SettingsPage.actors.tsx` — Actors moves under Settings as a sub-section.
- `test/sessions-helpers.test.ts` — Tests for the pure helpers in `app/src/lib/sessions.ts`.

**Modified files:**

- `app/src/App.tsx` — Owns `sessions[]`, `selectedWorkspaceNodeId`, `activeSessionIdByNode`, listens to `pty-data` for `lastOutputAt`. Wires `view: "workspace"`. Replaces local terminal state in `DetailPane`.
- `app/src/components/Sidebar.tsx` — View toggle becomes Graf | Práce. Aktéři moves out of top-level. Workspace badge `(N)` shows total live sessions.
- `app/src/components/SettingsPage.tsx` — Adds sub-tab nav (Obecné / Aktéři) and renders the actors sub-page when on that tab.
- `app/src/components/TerminalPane.tsx` — Refactor: take `sessionId` from props, never kill on prop changes (parent owns lifecycle), skip `pty_resize` when `offsetParent === null`.
- `app/src/components/DetailPane.tsx` — Drop local terminal state. Replace `openEmbeddedTerminal` with `onOpenTerminal(node)` callback prop.
- `app/src/components/StatusFooter.tsx` — Add session counter; click → switch view to workspace.
- `app/src/lib/settings.ts` — Add `loadDetailVisible` / `saveDetailVisible` helpers.

**Decomposition rule applied:** session state (data model) is a pure module; UI components are split per column so each file holds one responsibility. `App.tsx` becomes the integration layer but stays at single-file size by delegating layout to `WorkspaceView`.

---

## Task 1: Pure session state module + tests

**Files:**

- Create: `app/src/lib/sessions.ts`
- Create: `test/sessions-helpers.test.ts`

- [ ] **Step 1: Write failing tests for the session helpers**

```ts
// test/sessions-helpers.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  removeSession,
  markActivity,
  isSessionActive,
  nodeIsActive,
  countSessionsByNode,
  type TerminalSession,
} from "../app/src/lib/sessions.js";

const baseNode = {
  nodeId: "node_a",
  nodeName: "Node A",
  nodeType: "project" as const,
  cwd: "/tmp/a",
  command: "claude 'hello'",
};

describe("sessions helpers", () => {
  it("createSession assigns id, createdAt, lastOutputAt = createdAt", () => {
    const now = 1_000_000;
    const s = createSession(baseNode, now);
    assert.equal(s.nodeId, "node_a");
    assert.equal(s.createdAt, now);
    assert.equal(s.lastOutputAt, now);
    assert.match(s.id, /^term_node_a_/);
  });

  it("removeSession returns a new array without the matching id", () => {
    const a = createSession(baseNode, 1);
    const b = createSession(baseNode, 2);
    const out = removeSession([a, b], a.id);
    assert.deepEqual(out.map((s) => s.id), [b.id]);
  });

  it("markActivity updates lastOutputAt only for the target session", () => {
    const a = createSession(baseNode, 1);
    const b = createSession(baseNode, 2);
    const out = markActivity([a, b], a.id, 999);
    assert.equal(out.find((s) => s.id === a.id)!.lastOutputAt, 999);
    assert.equal(out.find((s) => s.id === b.id)!.lastOutputAt, 2);
  });

  it("isSessionActive uses 1500ms threshold by default", () => {
    assert.equal(isSessionActive(2000, 1000), true); // 1000ms ago
    assert.equal(isSessionActive(2600, 1000), false); // 1600ms ago
    assert.equal(isSessionActive(2000, 1000, 500), false); // tighter threshold
  });

  it("nodeIsActive is true if any session for that node is active", () => {
    const a = { ...createSession(baseNode, 1000), lastOutputAt: 1000 };
    const b = { ...createSession({ ...baseNode, nodeId: "node_b" }, 100), lastOutputAt: 100 };
    assert.equal(nodeIsActive([a, b], "node_a", 2000), true); // a is recent
    assert.equal(nodeIsActive([a, b], "node_b", 2000), false); // b is stale
  });

  it("countSessionsByNode returns a map of nodeId -> count", () => {
    const a = createSession(baseNode, 1);
    const b = createSession(baseNode, 2);
    const c = createSession({ ...baseNode, nodeId: "node_b" }, 3);
    const counts = countSessionsByNode([a, b, c]);
    assert.equal(counts.get("node_a"), 2);
    assert.equal(counts.get("node_b"), 1);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
node --import tsx --test test/sessions-helpers.test.ts
```

Expected: `Cannot find module '../app/src/lib/sessions.js'` or all tests fail (file does not exist yet).

- [ ] **Step 3: Implement the module**

```ts
// app/src/lib/sessions.ts
// Pure session-list helpers. No React, no DOM, no Tauri. The whole point
// of pulling this out is so the data shape can be unit-tested with the
// backend node-test runner without a browser environment.

export type NodeTypeLite =
  | "organization"
  | "project"
  | "process"
  | "area"
  | "principle"
  | (string & {}); // forward-compatible — popp.ts owns the canonical list

export type TerminalSessionInput = {
  nodeId: string;
  nodeName: string;
  nodeType: NodeTypeLite;
  cwd: string;
  command: string;
};

export type TerminalSession = TerminalSessionInput & {
  id: string;
  createdAt: number;
  lastOutputAt: number;
};

const ACTIVITY_THRESHOLD_MS = 1500;

// Build a unique session id. The format is keyed on nodeId + timestamp +
// random suffix so a casual reader can grep logs for "term_<node>_" and
// see all sessions that ever existed for that node. The PTY backend
// treats it as an opaque key.
export function createSession(
  input: TerminalSessionInput,
  now: number = Date.now(),
): TerminalSession {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    ...input,
    id: `term_${input.nodeId}_${now}_${rand}`,
    createdAt: now,
    lastOutputAt: now,
  };
}

export function removeSession(
  sessions: readonly TerminalSession[],
  id: string,
): TerminalSession[] {
  return sessions.filter((s) => s.id !== id);
}

export function markActivity(
  sessions: readonly TerminalSession[],
  id: string,
  at: number = Date.now(),
): TerminalSession[] {
  let mutated = false;
  const next = sessions.map((s) => {
    if (s.id !== id) return s;
    mutated = true;
    return { ...s, lastOutputAt: at };
  });
  return mutated ? next : sessions.slice();
}

export function isSessionActive(
  now: number,
  lastOutputAt: number,
  thresholdMs: number = ACTIVITY_THRESHOLD_MS,
): boolean {
  return now - lastOutputAt <= thresholdMs;
}

export function nodeIsActive(
  sessions: readonly TerminalSession[],
  nodeId: string,
  now: number,
  thresholdMs: number = ACTIVITY_THRESHOLD_MS,
): boolean {
  return sessions.some(
    (s) => s.nodeId === nodeId && isSessionActive(now, s.lastOutputAt, thresholdMs),
  );
}

export function countSessionsByNode(
  sessions: readonly TerminalSession[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    out.set(s.nodeId, (out.get(s.nodeId) ?? 0) + 1);
  }
  return out;
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
node --import tsx --test test/sessions-helpers.test.ts
```

Expected: 6 passing tests, no failures.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/sessions.ts test/sessions-helpers.test.ts
git commit -m "feat(app): pure session-list helpers + tests"
```

---

## Task 2: TerminalPane refactor — accept sessionId from parent, decouple lifecycle

**Files:**

- Modify: `app/src/components/TerminalPane.tsx` (full rewrite of effect block)

The current `TerminalPane` generates its own session id on mount and kills the PTY on unmount. Multi-session needs the parent to own the id (so panes can be remounted/hidden without the PTY dying), and an explicit kill is moved to a separate effect tied to a `kill` prop or imperative ref.

- [ ] **Step 1: Change props shape**

Replace the existing prop block (around line 25):

```ts
type Props = {
  // Pre-allocated by the parent. Used as the PTY backend session id —
  // stable across re-renders so the PTY survives prop changes.
  sessionId: string;
  cwd: string;
  command: string;
  // True when the pane is the active tab. False for background panes
  // that are mounted but display:none — those skip resize-IPC since
  // their measurements would be wrong anyway.
  active: boolean;
  // Called when the user closes the tab; parent removes from state +
  // invokes pty_kill. Component itself never calls pty_kill.
  onExit?: (code: number | null) => void;
  // Each emitted byte chunk fires this so App.tsx can update lastOutputAt
  // for the activity indicator. Keep the byte payload — App.tsx ignores
  // the bytes and only uses the timing.
  onOutput?: () => void;
};
```

- [ ] **Step 2: Replace the effect body**

In the `useEffect` (currently `[nodeId, cwd, command]` deps), the new dep array is `[sessionId]` only — cwd/command only matter at spawn, and sessionId is stable per session. The cleanup MUST NOT call `pty_kill`. Replace the unmount cleanup that calls `pty_kill` with one that only disposes xterm + listeners.

Key changes (apply within `useEffect`):

```ts
useEffect(() => {
  if (!isTauri()) return;
  const container = containerRef.current;
  if (!container) return;

  // No more random-id generation here — sessionId is the parent's.
  const id = sessionId;

  // ... existing xterm.open + addon setup ...

  let cancelled = false;
  let unlistenData: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let pendingResizeTimer: number | null = null;

  const init = async () => {
    await document.fonts.ready;
    if (cancelled) return;
    term.open(container);
    try { fit.fit(); } catch (e) { void e; }

    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    unlistenData = await listen<PtyDataPayload>("pty-data", (e) => {
      if (e.payload.session_id === id) {
        term.write(b64ToBytes(e.payload.data_b64));
        onOutputRef.current?.();
      }
    });
    unlistenExit = await listen<PtyExitPayload>("pty-exit", (e) => {
      if (e.payload.session_id === id) {
        term.writeln("");
        term.writeln(
          `\x1b[90m[session ended${
            e.payload.code != null ? ` (code ${e.payload.code})` : ""
          }]\x1b[0m`,
        );
        onExitRef.current?.(e.payload.code);
      }
    });

    if (cancelled) return;
    try {
      await invoke("pty_spawn", {
        args: { session_id: id, cwd, command, cols: term.cols, rows: term.rows },
      });
    } catch (err) {
      term.writeln(`\x1b[31mFailed to spawn pty: ${String(err)}\x1b[0m`);
      return;
    }

    term.onData((data) => {
      void invoke("pty_write", { args: { session_id: id, data } }).catch(() => {});
    });

    // Skip resize-IPC for hidden panes. offsetParent === null is the
    // canonical "I'm in a display:none subtree" check; using it means
    // hidden tabs don't fire spurious SIGWINCH at the agent.
    let lastCols = term.cols;
    let lastRows = term.rows;
    resizeObserver = new ResizeObserver(() => {
      if (container.offsetParent === null) return;
      if (pendingResizeTimer != null) window.clearTimeout(pendingResizeTimer);
      pendingResizeTimer = window.setTimeout(() => {
        pendingResizeTimer = null;
        try { fit.fit(); } catch { return; }
        if (term.cols === lastCols && term.rows === lastRows) return;
        lastCols = term.cols;
        lastRows = term.rows;
        void invoke("pty_resize", {
          args: { session_id: id, cols: term.cols, rows: term.rows },
        });
      }, 80);
    });
    resizeObserver.observe(container);
  };

  void init().catch((err) => {
    try { term.writeln(`\x1b[31m[terminal init failed: ${String(err)}]\x1b[0m`); } catch {}
  });

  return () => {
    // CRUCIAL: do NOT call pty_kill here. The parent owns lifecycle so
    // a tab switch (which can rerender us) doesn't tear down the PTY.
    cancelled = true;
    if (pendingResizeTimer != null) window.clearTimeout(pendingResizeTimer);
    try { resizeObserver?.disconnect(); } catch {}
    try { unlistenData?.(); } catch {}
    try { unlistenExit?.(); } catch {}
    try { term.dispose(); } catch {}
  };
}, [sessionId]);
```

Plus an `active` effect that calls `fit.fit()` whenever the pane becomes active (so a previously-hidden pane re-fits after `display: none → block`):

```ts
// fit when becoming active (a hidden pane has 0×0 measurements; fitting
// only when we become visible avoids wasted work and bad sizes).
useEffect(() => {
  if (!active) return;
  const id = setTimeout(() => {
    try { fitRef.current?.fit(); } catch {}
  }, 16);
  return () => clearTimeout(id);
}, [active]);
```

(Hold `fitRef` and `onOutputRef` outside the spawn effect so they're stable.)

- [ ] **Step 3: Update component signature + refs**

```ts
export default function TerminalPane({
  sessionId,
  cwd,
  command,
  active,
  onExit,
  onOutput,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onExitRef = useRef(onExit);
  const onOutputRef = useRef(onOutput);
  useEffect(() => { onExitRef.current = onExit; }, [onExit]);
  useEffect(() => { onOutputRef.current = onOutput; }, [onOutput]);
  // ... effects above ...
  if (!isTauri()) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-[var(--color-text-dim)]">
        Vestavěný terminál je dostupný jen v desktop verzi Portuni.
      </div>
    );
  }
  return (
    <div className="h-full w-full bg-[var(--color-bg)] p-5">
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}
```

- [ ] **Step 4: Manual smoke — typecheck only**

```bash
cd app && npx tsc -b --noEmit
```

Expected: passes (callers in DetailPane will be wired up in later tasks; for now they still pass `nodeId`/`cwd`/`command`. Update the DetailPane call site temporarily so the signature compiles — pass a derived `sessionId={"legacy_"+node.id}` and `active={true}` and `onExit={() => setTerminal(null)}`. This is a temporary bridge that Task 9 will undo.)

- [ ] **Step 5: Commit**

```bash
git add app/src/components/TerminalPane.tsx app/src/components/DetailPane.tsx
git commit -m "refactor(terminal): parent-owned sessionId, no pty_kill on unmount"
```

---

## Task 3: Settings sub-router — Obecné / Aktéři

**Files:**

- Modify: `app/src/components/SettingsPage.tsx`
- Create: `app/src/components/SettingsPage.actors.tsx` (re-exports `ActorsPage` content for embedding)
- Modify: `app/src/App.tsx` (drop `view === "actors"` branch; ActorsPage no longer top-level)
- Modify: `app/src/components/Sidebar.tsx` (drop "Aktéři" from view toggle)

- [ ] **Step 1: Create the actors sub-page wrapper**

```tsx
// app/src/components/SettingsPage.actors.tsx
// Re-exports the existing actors page so SettingsPage can render it as
// a sub-tab. Kept as a separate file so the lazy import in SettingsPage
// can still code-split cytoscape away from the settings bundle.
import { lazy, Suspense } from "react";

const ActorsPage = lazy(() => import("./ActorsPage"));

export default function SettingsActorsPanel() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-[14px] text-[var(--color-text-dim)]">
          Načítám aktéry…
        </div>
      }
    >
      <ActorsPage />
    </Suspense>
  );
}
```

- [ ] **Step 2: Add sub-tab nav to `SettingsPage`**

Modify `app/src/components/SettingsPage.tsx`. Add at top of component:

```tsx
import SettingsActorsPanel from "./SettingsPage.actors";

type SubTab = "general" | "actors";

export default function SettingsPage({
  agentCommand,
  onAgentCommandChange,
}: Props) {
  const [tab, setTab] = useState<SubTab>(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get("settingsTab") === "actors" ? "actors" : "general";
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === "general") url.searchParams.delete("settingsTab");
    else url.searchParams.set("settingsTab", tab);
    window.history.replaceState(null, "", url.toString());
  }, [tab]);
  // ... existing draft state below ...
```

Render at the top of the main scroll container, before the `<header>` of the existing General content:

```tsx
<div className="mx-auto flex max-w-[840px] flex-col gap-8 px-8 py-8">
  <header>
    <h1 className="text-[20px] font-semibold tracking-tight text-[var(--color-text)]">
      Nastavení
    </h1>
    <div className="mt-3 flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 w-max">
      <button
        onClick={() => setTab("general")}
        className={`px-3 py-1 rounded text-[13px] ${
          tab === "general" ? "bg-[var(--color-bg)] text-[var(--color-text)]" : "text-[var(--color-text-dim)]"
        }`}
      >
        Obecné
      </button>
      <button
        onClick={() => setTab("actors")}
        className={`px-3 py-1 rounded text-[13px] ${
          tab === "actors" ? "bg-[var(--color-bg)] text-[var(--color-text)]" : "text-[var(--color-text-dim)]"
        }`}
      >
        Aktéři
      </button>
    </div>
  </header>

  {tab === "general" && (
    <>
      <McpServerSection />
      {/* existing agent-command section */}
    </>
  )}

  {tab === "actors" && <SettingsActorsPanel />}
</div>
```

- [ ] **Step 3: Drop "Aktéři" top-level view from `App.tsx`**

In `app/src/App.tsx`:

- Remove the `if (v === "actors") return "actors";` branch from the URL parse.
- Remove the lazy `ActorsPage` import (now lives behind SettingsPage).
- Remove the `{view === "actors" && (<Suspense> ... <ActorsPage /> ...)}` JSX.
- The `AppView` union changes from `"graph" | "actors" | "settings"` to `"graph" | "workspace" | "settings"` — this is partly Task 4's work; for now temporarily allow either by leaving `"actors"` in the type. It will be replaced wholesale in Task 4.

Wait — to keep Task 3 self-contained, leave the AppView union for Task 4. In Task 3 just make `view === "actors"` no longer route anywhere by removing it from the URL parse and Sidebar toggle (so it can never be set), and delete the JSX branch. The leftover union member is dead code — Task 4 retypes it.

- [ ] **Step 4: Drop "Aktéři" from `Sidebar` view toggle**

In `app/src/components/Sidebar.tsx`, remove the second `<ViewToggleButton ... label="Aktéři" .../>`. The `view === "actors"` JSX branch (lines ~121–126 and the trailing footer hint) should also go — Task 4 replaces these with the workspace ones.

- [ ] **Step 5: Manual smoke**

```bash
cd app && npx tsc -b --noEmit
```

Then:

```bash
varlock run -- npm --prefix app run dev
```

Open `http://portuni.test/?view=settings` → see two tabs (Obecné / Aktéři). Click Aktéři → existing actors UI renders inside settings. Going to `?view=actors` should now no-op (just shows graph since the URL parser drops it).

- [ ] **Step 6: Commit**

```bash
git add app/src/components/SettingsPage.tsx app/src/components/SettingsPage.actors.tsx app/src/App.tsx app/src/components/Sidebar.tsx
git commit -m "refactor(app): move Aktéři under Settings sub-tab"
```

---

## Task 4: Workspace view scaffolding + Sidebar toggle

**Files:**

- Modify: `app/src/App.tsx`
- Modify: `app/src/components/Sidebar.tsx`
- Create: `app/src/components/WorkspaceView.tsx` (skeleton — empty state only for now)

This task lands the navigation hook so the user can switch to a (still-empty) Práce view. The session list state is wired in Task 5 — here we just add the route + skeleton.

- [ ] **Step 1: Update `AppView` union and URL parser**

In `app/src/App.tsx`:

```ts
// import path stays the same — only the union changes
// In Sidebar.tsx:
export type AppView = "graph" | "workspace" | "settings";
```

```ts
// In App.tsx, replace the URL parser:
const [view, setView] = useState<AppView>(() => {
  const p = new URLSearchParams(window.location.search);
  const v = p.get("view");
  if (v === "workspace") return "workspace";
  if (v === "settings") return "settings";
  return "graph";
});
```

URL effect needs no change — its serialisation is `view !== "graph" ? set : delete`.

- [ ] **Step 2: Add Práce to Sidebar view toggle**

In `app/src/components/Sidebar.tsx`, replace the toggle row:

```tsx
import { Plus, Search, Sun, Moon, X, Settings, Waypoints, Terminal } from "lucide-react";

// ... inside the Sidebar JSX, where Graf | Aktéři used to be:
<div className="flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
  <ViewToggleButton
    label="Graf"
    icon={<Waypoints size={12} />}
    active={view === "graph"}
    onClick={() => onViewChange("graph")}
  />
  <ViewToggleButton
    label="Práce"
    icon={<Terminal size={12} />}
    active={view === "workspace"}
    onClick={() => onViewChange("workspace")}
    badge={workspaceBadge}
  />
</div>
```

Add `workspaceBadge?: number` to `Props` and to `ViewToggleButton` so a `(N)` shows when sessions are live (App will pass it in Task 5):

```tsx
function ViewToggleButton({
  label, icon, active, onClick, badge,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button onClick={onClick} className={`flex flex-1 items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-[13px] transition-colors ${active ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"}`}>
      {icon}
      {label}
      {badge != null && badge > 0 && (
        <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent-soft)] px-1 text-[10px] font-medium text-[var(--color-accent)]">
          {badge}
        </span>
      )}
    </button>
  );
}
```

Replace the trailing footer hint to include the new view:

```tsx
{view === "graph"
  ? "Kliknutím na uzel otevřete detail. Tažením posunete pohled, kolečkem přibližujete."
  : view === "workspace"
    ? "Sessions zůstávají naživu při přepnutí pohledu. Cmd+Q ukončí všechny."
    : "Změny se ukládají automaticky."}
```

The `view === "graph"` branch in the body remains exactly as today (graph filters etc).

- [ ] **Step 3: Workspace skeleton**

```tsx
// app/src/components/WorkspaceView.tsx
// 3-column layout shell. In this task it just renders a placeholder — the
// real left/middle/right column components arrive in Tasks 6-8. The
// detail-collapse state lives here so the layout owns its own UI state.

import { useState } from "react";
import { ChevronRight, ChevronLeft } from "lucide-react";

type Props = {
  // (Filled in by Task 5+)
};

export default function WorkspaceView(_props: Props) {
  const [detailVisible, setDetailVisible] = useState<boolean>(() => {
    return localStorage.getItem("portuni:workspace.detailVisible") !== "false";
  });
  const toggleDetail = () => {
    setDetailVisible((v) => {
      localStorage.setItem("portuni:workspace.detailVisible", String(!v));
      return !v;
    });
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--color-bg)]">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-[var(--color-border)]">
        <div className="px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
          Práce
        </div>
        <div className="flex-1 px-4 text-[13px] text-[var(--color-text-dim)]">
          Žádné aktivní sessions. Otevři terminál z detailu uzlu.
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center text-[14px] text-[var(--color-text-dim)]">
          Workspace placeholder
        </div>
      </main>
      {detailVisible ? (
        <aside className="flex w-[360px] shrink-0 flex-col border-l border-[var(--color-border)]">
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
              Detail
            </span>
            <button onClick={toggleDetail} title="Skrýt detail">
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="flex-1 px-4 text-[13px] text-[var(--color-text-dim)]">
            Detail placeholder
          </div>
        </aside>
      ) : (
        <button
          onClick={toggleDetail}
          title="Zobrazit detail"
          className="flex h-full w-6 shrink-0 items-center justify-center border-l border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
        >
          <ChevronLeft size={14} />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire Workspace into App**

In `app/src/App.tsx` next to the existing `view === "graph"` block:

```tsx
import WorkspaceView from "./components/WorkspaceView";

// ... inside <main>:
{view === "workspace" && <WorkspaceView />}
```

The detail pane on the right of the app currently only renders when `view === "graph" && selectedId`. Leave that condition untouched — workspace owns its own right-column detail; the global one stays graph-specific.

- [ ] **Step 5: Manual smoke**

```bash
cd app && npx tsc -b --noEmit
varlock run -- npm --prefix app run dev
```

Open `http://portuni.test/?view=workspace` → 3-column placeholder. Toggle the detail panel via the chevron — collapses to a 24px gutter, persists across reload.

- [ ] **Step 6: Commit**

```bash
git add app/src/App.tsx app/src/components/Sidebar.tsx app/src/components/WorkspaceView.tsx
git commit -m "feat(app): workspace view scaffolding + Práce nav toggle"
```

---

## Task 5: Lift terminal session state into App.tsx

**Files:**

- Modify: `app/src/App.tsx`
- Modify: `app/src/components/WorkspaceView.tsx` (props change)

This task does NOT yet move the terminal UI. It introduces the global state (`sessions[]`, `selectedWorkspaceNodeId`, `activeSessionIdByNode`) and the `pty-data` listener so `lastOutputAt` updates centrally. DetailPane still owns its legacy single-terminal flow until Task 9.

- [ ] **Step 1: Add session state in `App.tsx`**

```tsx
import {
  type TerminalSession,
  createSession,
  removeSession,
  markActivity,
  countSessionsByNode,
} from "./lib/sessions";

// ... inside App():
const [sessions, setSessions] = useState<TerminalSession[]>([]);
const [selectedWorkspaceNodeId, setSelectedWorkspaceNodeId] = useState<string | null>(null);
const [activeSessionIdByNode, setActiveSessionIdByNode] = useState<Record<string, string>>({});
const [now, setNow] = useState<number>(() => Date.now());

// 1s tick so the activity-indicator color flips green→orange as the
// 1.5s threshold passes without further output. Cheap; the only state
// consumers are the indicator dots.
useEffect(() => {
  const id = window.setInterval(() => setNow(Date.now()), 1000);
  return () => window.clearInterval(id);
}, []);
```

- [ ] **Step 2: Listen for `pty-data` and `pty-exit` at App level**

```tsx
useEffect(() => {
  let unlistenData: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let cancelled = false;
  (async () => {
    if (typeof window === "undefined") return;
    // Browser-mode (vite dev outside Tauri) has no pty events. Skip.
    try {
      const { listen } = await import("@tauri-apps/api/event");
      type PtyData = { session_id: string };
      type PtyExit = { session_id: string; code: number | null };
      unlistenData = await listen<PtyData>("pty-data", (e) => {
        if (cancelled) return;
        const id = e.payload.session_id;
        setSessions((prev) => markActivity(prev, id));
      });
      unlistenExit = await listen<PtyExit>("pty-exit", (e) => {
        if (cancelled) return;
        const id = e.payload.session_id;
        setSessions((prev) => removeSession(prev, id));
        setActiveSessionIdByNode((prev) => {
          const next: Record<string, string> = {};
          for (const [nid, sid] of Object.entries(prev)) {
            if (sid !== id) next[nid] = sid;
          }
          return next;
        });
      });
    } catch {
      // Not running in Tauri — fine.
    }
  })();
  return () => {
    cancelled = true;
    try { unlistenData?.(); } catch {}
    try { unlistenExit?.(); } catch {}
  };
}, []);
```

- [ ] **Step 3: Open-session callback**

```tsx
const openSession = useCallback(
  (input: { node: NodeDetail; cwd: string; command: string }) => {
    const session = createSession({
      nodeId: input.node.id,
      nodeName: input.node.name,
      nodeType: input.node.type,
      cwd: input.cwd,
      command: input.command,
    });
    setSessions((prev) => [...prev, session]);
    setSelectedWorkspaceNodeId(input.node.id);
    setActiveSessionIdByNode((prev) => ({ ...prev, [input.node.id]: session.id }));
    setView("workspace");
  },
  [],
);
```

```tsx
const closeSession = useCallback((sessionId: string) => {
  setSessions((prev) => removeSession(prev, sessionId));
  setActiveSessionIdByNode((prev) => {
    const next = { ...prev };
    for (const [nid, sid] of Object.entries(next)) {
      if (sid === sessionId) delete next[nid];
    }
    return next;
  });
  // Best-effort: tell the backend the PTY is gone. Errors swallowed —
  // the pty-exit reader thread will clean up its own map entry once
  // the child SIGHUPs.
  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("pty_kill", { args: { session_id: sessionId } });
    } catch {}
  })();
}, []);
```

- [ ] **Step 4: Wire into Sidebar badge + WorkspaceView**

```tsx
// In App.tsx Sidebar usage:
<Sidebar
  // ... existing props ...
  workspaceBadge={sessions.length}
/>

// In App.tsx, replace `{view === "workspace" && <WorkspaceView />}`:
{view === "workspace" && (
  <WorkspaceView
    graph={graph}
    sessions={sessions}
    now={now}
    selectedNodeId={selectedWorkspaceNodeId}
    onSelectNode={setSelectedWorkspaceNodeId}
    activeSessionIdByNode={activeSessionIdByNode}
    onSetActiveSession={(nodeId, sessionId) =>
      setActiveSessionIdByNode((p) => ({ ...p, [nodeId]: sessionId }))
    }
    onCloseSession={closeSession}
    onOpenSessionFromPicker={(node) => {
      // Mirror creation lives in Task 9 plumbing — for now the empty
      // state opens a session by deferring to DetailPane via selecting
      // the node in graph view. Workspace task 8 wires the picker.
      setSelectedId(node.id);
      setView("graph");
    }}
    detailNodeId={selectedWorkspaceNodeId}
  />
)}
```

Update `WorkspaceView` props:

```tsx
import type { GraphPayload } from "../types";
import type { TerminalSession } from "../lib/sessions";

type Props = {
  graph: GraphPayload | null;
  sessions: TerminalSession[];
  now: number;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  activeSessionIdByNode: Record<string, string>;
  onSetActiveSession: (nodeId: string, sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onOpenSessionFromPicker: (node: { id: string; name: string; type: string }) => void;
  detailNodeId: string | null;
};
```

(Implementation of the columns lands in Tasks 6–8; for now `WorkspaceView` continues to render placeholders but with the props in place.)

- [ ] **Step 5: Pass `workspaceBadge` to Sidebar**

In `app/src/components/Sidebar.tsx`, add to `Props`:

```ts
workspaceBadge?: number;
```

Forward into the toggle button created in Task 4.

- [ ] **Step 6: Manual smoke**

```bash
cd app && npx tsc -b --noEmit
varlock run -- npm --prefix app run dev
```

The state is in place but no UI exposes it yet — the badge stays at 0. Just confirm the typecheck passes and the app still renders graph + workspace placeholder.

- [ ] **Step 7: Commit**

```bash
git add app/src/App.tsx app/src/components/Sidebar.tsx app/src/components/WorkspaceView.tsx
git commit -m "feat(app): global session state + pty-event listeners in App"
```

---

## Task 6: WorkspaceNodeList — left column

**Files:**

- Create: `app/src/components/WorkspaceNodeList.tsx`
- Modify: `app/src/components/WorkspaceView.tsx` (replace left placeholder)

- [ ] **Step 1: Component**

```tsx
// app/src/components/WorkspaceNodeList.tsx
// Left column of the workspace view. Lists every node that currently has
// at least one PTY session, in the order the first session was created.
// A node disappears the instant its last session is closed (no pinning
// in v1 — see spec).
import { countSessionsByNode, nodeIsActive, type TerminalSession } from "../lib/sessions";

type NodeRow = {
  id: string;
  name: string;
  type: string;
};

type Props = {
  sessions: TerminalSession[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  now: number;
};

function nodeTypeVar(type: string): string {
  const known = ["organization", "project", "process", "area", "principle"];
  return known.includes(type) ? `var(--color-node-${type})` : "var(--color-node-default)";
}

export default function WorkspaceNodeList({ sessions, selectedNodeId, onSelectNode, now }: Props) {
  const counts = countSessionsByNode(sessions);

  // Stable order: first-seen wins. We can derive this from sessions[]
  // because they're appended chronologically.
  const seen = new Set<string>();
  const rows: NodeRow[] = [];
  for (const s of sessions) {
    if (seen.has(s.nodeId)) continue;
    seen.add(s.nodeId);
    rows.push({ id: s.nodeId, name: s.nodeName, type: s.nodeType });
  }

  if (rows.length === 0) {
    return (
      <div className="px-4 py-6 text-[13px] text-[var(--color-text-dim)]">
        Žádné aktivní sessions.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 px-2 py-2">
      {rows.map((r) => {
        const count = counts.get(r.id) ?? 0;
        const active = nodeIsActive(sessions, r.id, now);
        const selected = r.id === selectedNodeId;
        return (
          <li key={r.id}>
            <button
              onClick={() => onSelectNode(r.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                selected
                  ? "bg-[var(--color-surface)] text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              }`}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: nodeTypeVar(r.type) }}
                aria-hidden
              />
              <span className="flex-1 truncate">{r.name}</span>
              <span className="font-mono text-[11px] text-[var(--color-text-dim)]">{count}</span>
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-amber-500/70"}`}
                title={active ? "Agent píše" : "Idle"}
                aria-label={active ? "active" : "idle"}
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 2: Wire into `WorkspaceView`**

Replace the left aside placeholder block:

```tsx
import WorkspaceNodeList from "./WorkspaceNodeList";

// ...
<aside className="flex w-[260px] shrink-0 flex-col border-r border-[var(--color-border)]">
  <div className="px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
    Práce
  </div>
  <div className="flex-1 overflow-y-auto scroll-thin">
    <WorkspaceNodeList
      sessions={sessions}
      selectedNodeId={selectedNodeId}
      onSelectNode={onSelectNode}
      now={now}
    />
  </div>
</aside>
```

- [ ] **Step 3: Manual smoke**

```bash
cd app && npx tsc -b --noEmit
```

(End-to-end smoke happens after Task 7 when sessions can actually be created.)

- [ ] **Step 4: Commit**

```bash
git add app/src/components/WorkspaceNodeList.tsx app/src/components/WorkspaceView.tsx
git commit -m "feat(workspace): left column node list with activity dots"
```

---

## Task 7: TerminalTabs middle column + multi-pane mounting

**Files:**

- Create: `app/src/components/TerminalTabs.tsx`
- Modify: `app/src/components/WorkspaceView.tsx` (replace middle placeholder)

- [ ] **Step 1: Component**

```tsx
// app/src/components/TerminalTabs.tsx
// Middle column. Renders one tab per session for the currently selected
// node, plus a "+" stub (re-using the parent's "open" callback). Every
// pane is mounted; only the active one is visible. Background panes
// keep their PTY alive and their xterm scrollback intact.
import { useState } from "react";
import { X, Plus } from "lucide-react";
import TerminalPane from "./TerminalPane";
import { isSessionActive, type TerminalSession } from "../lib/sessions";

type Props = {
  sessionsForNode: TerminalSession[]; // already filtered to one node
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onNewSession: () => void;
  now: number;
};

export default function TerminalTabs({
  sessionsForNode,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  onNewSession,
  now,
}: Props) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (sessionsForNode.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--color-text-dim)]">
        Žádné sessions pro tento uzel.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2">
        {sessionsForNode.map((s, idx) => {
          const active = isSessionActive(now, s.lastOutputAt);
          const selected = s.id === activeSessionId;
          return (
            <button
              key={s.id}
              onClick={() => onSelectSession(s.id)}
              className={`flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-[12.5px] transition-colors ${
                selected
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-amber-500/70"}`}
                aria-hidden
              />
              <span className="font-mono">#{idx + 1}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Zavřít session #${idx + 1}? Běžící proces dostane SIGHUP.`)) {
                    onCloseSession(s.id);
                  }
                }}
                className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-[var(--color-text-dim)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                title="Zavřít session"
              >
                <X size={11} />
              </span>
            </button>
          );
        })}
        <button
          onClick={onNewSession}
          className="ml-1 flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          title="Nová session pro tento uzel"
        >
          <Plus size={12} />
          Nová
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {sessionsForNode.map((s) => {
          const active = s.id === activeSessionId;
          return (
            <div
              key={s.id}
              className="absolute inset-0"
              style={{ display: active ? "block" : "none" }}
            >
              <TerminalPane
                sessionId={s.id}
                cwd={s.cwd}
                command={s.command}
                active={active}
                onExit={() => onCloseSession(s.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into `WorkspaceView`**

Replace the middle `<main>` placeholder:

```tsx
import TerminalTabs from "./TerminalTabs";

// ...
<main className="flex min-w-0 flex-1 flex-col">
  {selectedNodeId ? (
    <TerminalTabs
      sessionsForNode={sessions.filter((s) => s.nodeId === selectedNodeId)}
      activeSessionId={activeSessionIdByNode[selectedNodeId] ?? null}
      onSelectSession={(id) => onSetActiveSession(selectedNodeId, id)}
      onCloseSession={onCloseSession}
      onNewSession={() => {
        // Spawning a new session for the same node needs DetailPane's
        // mirror+command flow. Task 9 wires this. For now, no-op.
      }}
      now={now}
    />
  ) : (
    <div className="flex flex-1 items-center justify-center text-[14px] text-[var(--color-text-dim)]">
      Vyber uzel vlevo nebo otevři terminál z detailu.
    </div>
  )}
</main>
```

- [ ] **Step 3: Manual smoke**

End-to-end won't fully work until Task 9 wires the open-from-detail flow. But you can verify rendering by manually injecting a session in DevTools (App state). Skip if too fiddly — Task 9's smoke covers this together.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/TerminalTabs.tsx app/src/components/WorkspaceView.tsx
git commit -m "feat(workspace): terminal tabs with multi-pane mounting"
```

---

## Task 8: Empty-state node picker

**Files:**

- Create: `app/src/components/WorkspaceEmpty.tsx`
- Modify: `app/src/components/WorkspaceView.tsx`

- [ ] **Step 1: Picker component**

```tsx
// app/src/components/WorkspaceEmpty.tsx
// Shown when sessions[] is empty. A search box over graph.nodes (minus
// organisations) so the user can type and pick a node to open a session
// against. Mirrors the search UX from the sidebar so the muscle memory
// transfers.
import { useState } from "react";
import { Search } from "lucide-react";
import type { GraphNode, GraphPayload } from "../types";
import { foldForSearch } from "../lib/normalize";

type Props = {
  graph: GraphPayload | null;
  onPick: (node: GraphNode) => void;
};

function nodeTypeVar(type: string): string {
  const known = ["organization", "project", "process", "area", "principle"];
  return known.includes(type) ? `var(--color-node-${type})` : "var(--color-node-default)";
}

export default function WorkspaceEmpty({ graph, onPick }: Props) {
  const [query, setQuery] = useState("");
  const q = foldForSearch(query.trim());
  const all = graph?.nodes ?? [];
  const matches = q
    ? all
        .filter((n) => n.type !== "organization")
        .filter(
          (n) =>
            foldForSearch(n.name).includes(q) ||
            foldForSearch(n.description ?? "").includes(q),
        )
        .slice(0, 30)
    : all
        .filter((n) => n.type !== "organization")
        .slice(-15)
        .reverse();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8">
      <div className="text-[15px] font-medium text-[var(--color-text)]">
        Vyber uzel a otevři terminál
      </div>
      <p className="max-w-[420px] text-center text-[13px] text-[var(--color-text-dim)]">
        Sessions zůstávají naživu při přepnutí pohledu. Zavři je explicitně,
        nebo až ukončíš Portuni.
      </p>
      <div className="relative w-full max-w-[480px]">
        <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)]" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Hledat uzel…"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-8 pr-3 text-[13.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent-dim)]"
        />
      </div>
      <ul className="scroll-thin w-full max-w-[480px] flex-1 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
        {matches.map((n) => (
          <li key={n.id} className="border-b border-[var(--color-border)] last:border-b-0">
            <button
              onClick={() => onPick(n)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: nodeTypeVar(n.type) }} aria-hidden />
              <span className="flex-1 truncate">{n.name}</span>
              <span className="font-mono text-[11px] text-[var(--color-text-dim)]">{n.type}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Show it when sessions are empty**

In `WorkspaceView.tsx`, replace the middle column conditional:

```tsx
import WorkspaceEmpty from "./WorkspaceEmpty";
// ...
<main className="flex min-w-0 flex-1 flex-col">
  {sessions.length === 0 ? (
    <WorkspaceEmpty graph={graph} onPick={(n) => onOpenSessionFromPicker(n)} />
  ) : selectedNodeId ? (
    <TerminalTabs ... />
  ) : (
    <div className="flex flex-1 items-center justify-center text-[14px] text-[var(--color-text-dim)]">
      Vyber uzel vlevo nebo otevři terminál z detailu.
    </div>
  )}
</main>
```

The `onOpenSessionFromPicker` parent prop takes the `GraphNode`. App.tsx needs to fetch the full `NodeDetail` (for `local_mirror`) before calling `openSession`. The temporary implementation from Task 5 just selects the node + switches to graph view — that's the correct fallback while Task 9 wires the real spawn-from-picker path.

- [ ] **Step 3: Manual smoke**

Open `?view=workspace` with no sessions → see picker. Type to filter. Click a node → currently jumps back to graph view (Task 9 finishes the loop).

- [ ] **Step 4: Commit**

```bash
git add app/src/components/WorkspaceEmpty.tsx app/src/components/WorkspaceView.tsx
git commit -m "feat(workspace): empty-state node picker"
```

---

## Task 9: Wire DetailPane → openSession + finish picker loop

**Files:**

- Modify: `app/src/components/DetailPane.tsx`
- Modify: `app/src/App.tsx` (replace fallback `onOpenSessionFromPicker`)

- [ ] **Step 1: Lift mirror+command building from DetailPane to a helper used by both**

Both DetailPane (existing button) and WorkspaceEmpty (picker) need the same logic: ensure mirror exists, build command, call `openSession`. Extract into App.tsx or a small helper:

```tsx
// In App.tsx:
import { createNodeMirror } from "./api";
import { buildAgentCommand } from "./lib/prompt";
import { fetchNode } from "./api";

const openSessionForNodeId = useCallback(
  async (nodeId: string) => {
    let detail: NodeDetail | null = null;
    try {
      detail = await fetchNode(nodeId);
    } catch (err) {
      setGraphError(`Nelze načíst uzel: ${String(err)}`);
      return;
    }
    if (!detail) return;
    let cwd: string;
    try {
      const mirror = await createNodeMirror(nodeId);
      cwd = mirror.local_path;
    } catch (err) {
      setGraphError(`Nelze otevřít terminál: ${String(err)}`);
      return;
    }
    const enriched: NodeDetail = {
      ...detail,
      local_mirror: detail.local_mirror ?? {
        local_path: cwd,
        registered_at: new Date().toISOString(),
      },
    };
    const command = buildAgentCommand(enriched, agentCommand);
    openSession({ node: enriched, cwd, command });
  },
  [agentCommand, openSession],
);
```

(`openSession` was defined in Task 5.)

- [ ] **Step 2: Replace DetailPane local terminal flow**

In `app/src/components/DetailPane.tsx`:

- Remove the local `terminal` and `terminalOpening` states.
- Remove the entire `if (terminal) { return <PaneShell>...<TerminalPane>... }` branch (lines ~478–516).
- Replace `openEmbeddedTerminal` to call a new prop `onOpenTerminal(node.id)` instead.

```tsx
// Add to Props:
onOpenTerminal: (nodeId: string) => void;

// Replace handler:
const openEmbeddedTerminal = () => {
  onOpenTerminal(node.id);
};
```

The button JSX (line ~900) stays; remove `disabled={terminalOpening}` and the spinner-state label since we now hand off immediately.

```tsx
<button
  onClick={openEmbeddedTerminal}
  title="Otevře terminál v Práci a spustí v něm Claude. Pracovní složka bude vytvořena, pokud ještě neexistuje."
  className="flex items-center justify-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-[13px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]"
>
  Otevřít terminál v Portuni
</button>
```

Remove the `import TerminalPane from "./TerminalPane"` line — DetailPane no longer hosts a terminal.

- [ ] **Step 3: Pass `onOpenTerminal` from App.tsx**

```tsx
<DetailPane
  // ... existing props ...
  onOpenTerminal={openSessionForNodeId}
/>
```

- [ ] **Step 4: Replace the WorkspaceEmpty fallback**

```tsx
<WorkspaceView
  // ... existing props ...
  onOpenSessionFromPicker={(n) => { void openSessionForNodeId(n.id); }}
/>
```

The fallback that switched to graph view is gone.

- [ ] **Step 5: Wire TerminalTabs "Nová" button to spawn another session for the same node**

In WorkspaceView, the `onNewSession` for `TerminalTabs` calls back into App:

```tsx
// New prop on WorkspaceView:
onNewSessionForCurrentNode: (nodeId: string) => void;

// Inside <TerminalTabs ... onNewSession={() => onNewSessionForCurrentNode(selectedNodeId!)} />
```

App.tsx:

```tsx
onNewSessionForCurrentNode={(nodeId) => { void openSessionForNodeId(nodeId); }}
```

- [ ] **Step 6: Manual smoke (full e2e)**

```bash
cargo tauri build  # or `cargo tauri dev` if iterating
cp -R src-tauri/target/release/bundle/macos/Portuni.app /Applications/
open /Applications/Portuni.app
```

Verify:

1. Click any non-org node → DetailPane → "Otevřít terminál v Portuni" → switches to Práce, terminal active, Claude spawning.
2. Switch to Graf → terminal stays alive (no SIGHUP, no [session ended] in scrollback).
3. Switch back to Práce → terminal still there, scrollback intact.
4. Click "Nová" in tabs → second tab, second PTY for same node.
5. Switch tabs → both panes survive.
6. Click X on a tab → confirm dialog → tab closes, child gets SIGHUP, only the other survives.
7. Sidebar badge shows session count.
8. Empty state: close all sessions → picker shows → click a node → spawn + jump.

- [ ] **Step 7: Commit**

```bash
git add app/src/App.tsx app/src/components/DetailPane.tsx app/src/components/WorkspaceView.tsx
git commit -m "feat(workspace): connect DetailPane + picker to global session state"
```

---

## Task 10: StatusFooter session counter

**Files:**

- Modify: `app/src/components/StatusFooter.tsx`
- Modify: `app/src/App.tsx`

- [ ] **Step 1: Add count + click-to-workspace**

```tsx
// StatusFooter.tsx
type Props = {
  onOpenSettings: () => void;
  sessionCount: number;
  onOpenWorkspace: () => void;
};

// Insert next to existing MCP indicator:
{props.sessionCount > 0 && (
  <button
    type="button"
    title={`Aktivní sessions: ${props.sessionCount}`}
    onClick={props.onOpenWorkspace}
    className="ml-3 flex items-center gap-2 rounded px-2 py-0.5 transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
  >
    <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
    <span className="font-mono">{props.sessionCount} sess</span>
  </button>
)}
```

- [ ] **Step 2: Pass props from App.tsx**

```tsx
<StatusFooter
  onOpenSettings={() => setView("settings")}
  sessionCount={sessions.length}
  onOpenWorkspace={() => setView("workspace")}
/>
```

- [ ] **Step 3: Manual smoke**

Spawn 2 sessions → footer shows "2 sess". Switch to graph → footer still shows "2 sess". Click footer counter → jumps back to Práce.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/StatusFooter.tsx app/src/App.tsx
git commit -m "feat(footer): live session counter"
```

---

## Task 11: Self-review pass + final smoke + push branch

**Files:** None (review-only step + final manual verification + push)

- [ ] **Step 1: Code review checklist**

Re-read each modified file in editor and verify:

- `TerminalPane.tsx` cleanup never calls `pty_kill`. Search `pty_kill` in the file — only call sites should be in App.tsx.
- `DetailPane.tsx` no longer imports `TerminalPane`.
- `App.tsx` has exactly one `pty_kill` call site (in `closeSession`).
- All new files start with a 1-2 line top-of-file comment explaining intent (matches repo style).

- [ ] **Step 2: QA suite**

```bash
npm run lint
cd app && npx tsc -b --noEmit
node --import tsx --test test/sessions-helpers.test.ts
```

All three must be green. The full `npm run qa` runs the entire backend test suite which is unrelated to this work; if it goes red, investigate (likely pre-existing) before continuing.

- [ ] **Step 3: Real-app smoke (cargo tauri build)**

Re-run the e2e steps from Task 9 Step 6 against a fresh install. Pay attention to:

- Cmd+Q kills all PTY children (existing exit hooks — verify by checking `ps aux | grep claude` afterwards).
- Reload (Cmd+R inside the webview) should NOT survive sessions — full-page reload tears down the React tree, and we don't have backend persistence for the frontend session list. Document if that lands wrong.

- [ ] **Step 4: Push branch + open draft PR**

```bash
git push -u origin feat/multi-session-terminal
gh pr create --draft --title "feat(app): multi-session workspace" --body "$(cat <<'EOF'
## Summary

Adds a Workspace view (top-level "Práce" nav) that hosts multiple parallel
PTY sessions, persists them across node switches, and surfaces per-session
+ per-node activity. Supersedes the embedded-terminal-inside-DetailPane
flow from PR #14.

- 3-column layout (node list / terminal tabs / collapsible detail).
- Sessions outlive view switches; only Cmd+Q (existing exit hooks) or
  explicit close kills a PTY.
- Activity indicator (1.5s threshold) per session and aggregated per node.
- Aktéři moves under Settings as a sub-tab; top-level becomes Graf | Práce.
- TerminalPane refactored: parent owns sessionId + lifecycle, no more
  pty_kill on unmount, pty_resize skipped for hidden panes.
- New pure module \`app/src/lib/sessions.ts\` with backend-runner unit tests.

Spec: \`docs/superpowers/specs/2026-05-07-multi-session-workspace-design.md\`
Plan: \`docs/superpowers/plans/2026-05-07-multi-session-workspace.md\`

## Test plan

- [ ] Spawn 2 sessions on different nodes; switch nodes — both stay alive.
- [ ] Spawn 2 sessions on the same node; switch tabs — scrollback intact.
- [ ] Activity dot turns green during agent output, orange after 1.5s idle.
- [ ] Close tab via X — confirm dialog — child gets SIGHUP.
- [ ] Cmd+Q — all children die.
- [ ] Empty state picker filters and spawns.
- [ ] Footer counter increments + click navigates to Práce.
- [ ] Aktéři reachable under Settings, no longer top-level.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Final commit if anything was tweaked during review**

```bash
git status   # likely clean; commit any review-driven fixups under
             # a single "chore(workspace): self-review tweaks" commit.
```

---

## Out-of-scope (deferred)

- Persistence of sessions across app restarts. Cmd+Q tears everything down.
- Right-click context menu on graph nodes for "Spustit terminál" — current flow (click node → detail → button) is enough; revisit if user friction shows up.
- Pinned nodes in the left column without a session.
- Session-rename / "label this tab #2 something useful".
- Reordering tabs by drag.
- iTerm2/Ghostty external-terminal preset still uses the existing path in `lib.rs`. PR #13 (`feat/terminal-picker`) lives separately.

## Self-review

Spec coverage check (run during plan authoring):

- Branch name + status — Task 11 pushes the branch and opens PR.
- Top-level nav restructure (Graf / Práce / Nastavení Obecné/Aktéři) — Tasks 3+4.
- 3-column layout — Tasks 4 + 6 + 7.
- Activity indicator (green/orange) — Tasks 5 + 6 + 7.
- Data model — Task 1.
- Empty state — Task 8.
- Vstupy do workspace (DetailPane / picker) — Task 9. Graph context-menu deferred to out-of-scope; documented.
- Performance (mounted-permanently + skip resize) — Task 2 + Task 7.
- Closing safety (X + confirm) — Task 7.
- StatusFooter — Task 10.
- 14-step spec mapping — implementation steps 1–14 of spec map onto Tasks 3, 3, 5, 4, 6, 7, 5+6+7, 8, 2, 9, n/a (deferred), 10, 7, 2 respectively.

Placeholder scan: no TBD/TODO inline. All steps include code or exact commands.

Type consistency: `TerminalSession`, `createSession`, `markActivity`, `removeSession`, `nodeIsActive`, `countSessionsByNode`, `isSessionActive` are introduced in Task 1 and used unchanged in later tasks. `openSession` (Task 5) and `openSessionForNodeId` (Task 9) are distinct names with distinct argument shapes — both stable.
