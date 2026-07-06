# Cluster A — Terminal Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three terminal-UI fixes — make the active session unmistakable (úkol 1), make the green "agent working" dot mean an agent is actually working rather than "the PTY emitted bytes" (úkol 6a), and make diffs/code readable in light mode by giving xterm a real per-mode ANSI palette (úkol 8).

**Architecture:** Frontend-only (React + xterm.js). úkol 6a's logic lives in the pure `app/src/lib/sessions.ts` (unit-tested via `node --test`); its rendering plus úkol 1's active marker live in `WorkspaceNodeList.tsx`. úkol 8 adds a 16-color ANSI palette to `theme.ts` and feeds it into `buildXtermTheme(theme)` in `TerminalPane.tsx`. No backend, no Rust, no Tauri-config change. (úkol 6b — true foreground-process "is it computing" detection — and úkol 7 — Finder drag-drop — are deferred to the Tauri-batch plan; this plan's 6a is the frontend-only honest improvement.)

**Tech Stack:** React 19, TypeScript, xterm.js v6 (`ITheme`), Tailwind v4 (CSS variables), `node --test` via `tsx` for the pure helpers.

## Global Constraints

- **No emoji in code.**
- **Frontend strings stay Czech with diacritics** (existing UI convention: "Idle", "Nová session", etc.).
- **`sessions.ts` stays pure** (no React/DOM/Tauri) so it keeps its `node --test` coverage.
- **The activity indicator is "agent working", per the multi-session spec** (`docs/superpowers/specs/2026-05-07-multi-session-workspace-design.md`): green = agent working, amber = idle/not-an-agent.
- **Verification needs the desktop shell.** The embedded terminal renders only in Tauri (browser-only Vite shows a placeholder), so visual checks run under `cargo tauri dev` (UI still hot-reloads via Vite). The `sessions.ts` logic is covered headlessly by `npm test`.
- Test: `npm test` / single file `node --import tsx --test test/sessions-helpers.test.ts`. Typecheck: `npm --prefix app run build` (tsc) or `npm run typecheck` (backend). Frontend dev: `varlock run -- npm --prefix app run dev` (HMR) plus `cargo tauri dev` for live terminals.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `app/src/lib/sessions.ts` | Pure session-list helpers + activity model | Add `isAgentCommand`, `sessionIsAgentWorking`, `nodeHasWorkingAgent` (Task 1) |
| `test/sessions-helpers.test.ts` | `node --test` coverage of the helpers | Add agent-gating cases (Task 1) |
| `app/src/components/WorkspaceNodeList.tsx` | Left-column node/session list, activity dots, active styling | Use agent-gated helpers for dots + labels (úkol 6a); strengthen active-session marker (úkol 1) (Task 2) |
| `app/src/lib/theme.ts` | Theme color tables | Add `AnsiPalette` to `ThemeColors` + populate dark/light (Task 3) |
| `app/src/components/TerminalPane.tsx` | xterm pane + theme snapshot | `buildXtermTheme(theme)` merges the ANSI palette; update both call sites (Task 3) |

---

### Task 1: Agent-gated activity helpers in `sessions.ts` (TDD)

**Files:**
- Modify: `app/src/lib/sessions.ts` (add three exports after `nodeIsActive`, ~line 95)
- Test: `test/sessions-helpers.test.ts` (add imports + a `describe` block)

**Interfaces:**
- Consumes: existing `isSessionActive(now, lastOutputAt, threshold)`, `TerminalSession` (has `command: string`, `lastOutputAt: number`).
- Produces:
  - `isAgentCommand(command: string): boolean`
  - `sessionIsAgentWorking(session: Pick<TerminalSession,"command"|"lastOutputAt">, now: number, thresholdMs?: number): boolean`
  - `nodeHasWorkingAgent(sessions: readonly TerminalSession[], nodeId: string, now: number, thresholdMs?: number): boolean`

- [ ] **Step 1: Write the failing tests**

In `test/sessions-helpers.test.ts`, extend the import block (lines 3-10) to add the three names:

```ts
import {
  createSession,
  removeSession,
  markActivity,
  isSessionActive,
  nodeIsActive,
  countSessionsByNode,
  isAgentCommand,
  sessionIsAgentWorking,
  nodeHasWorkingAgent,
} from "../app/src/lib/sessions.js";
```

Then add this block after the existing `describe("sessions helpers", ...)` block (after line 112):

```ts
describe("agent activity gating", () => {
  const agent = { ...baseNode, command: "claude 'hello'" };
  const shell = { ...baseNode, command: "zsh -l" };

  it("isAgentCommand matches agent CLIs, not bare shells", () => {
    assert.equal(isAgentCommand("claude 'do x'"), true);
    assert.equal(isAgentCommand("codex"), true);
    assert.equal(isAgentCommand("vibe --trust 'y'"), true);
    assert.equal(isAgentCommand("zsh -l"), false);
    assert.equal(isAgentCommand("ls -la"), false);
    assert.equal(isAgentCommand(""), false);
  });

  it("sessionIsAgentWorking requires both an agent command and recent output", () => {
    const a = { ...createSession(agent, 1000), lastOutputAt: 1000 };
    const s = { ...createSession(shell, 1000), lastOutputAt: 1000 };
    assert.equal(sessionIsAgentWorking(a, 2000), true); // agent + fresh output
    assert.equal(sessionIsAgentWorking(s, 2000), false); // busy shell must NOT light up
    assert.equal(sessionIsAgentWorking(a, 5000), false); // agent, stale output
  });

  it("nodeHasWorkingAgent ignores busy shell sessions", () => {
    const a = { ...createSession({ ...agent, nodeId: "n1" }, 1000), lastOutputAt: 1000 };
    const s = { ...createSession({ ...shell, nodeId: "n2" }, 1000), lastOutputAt: 1000 };
    assert.equal(nodeHasWorkingAgent([a, s], "n1", 2000), true);
    assert.equal(nodeHasWorkingAgent([a, s], "n2", 2000), false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test --test-name-pattern "agent activity gating" test/sessions-helpers.test.ts`
Expected: FAIL — `isAgentCommand` / `sessionIsAgentWorking` / `nodeHasWorkingAgent` are not exported.

- [ ] **Step 3: Implement the helpers**

In `app/src/lib/sessions.ts`, after `nodeIsActive` (ends line 95), add:

```ts
// The activity indicator means "an agent is working", not "the PTY emitted
// bytes". A bare shell that echoes keystrokes, redraws a prompt, or runs
// `ls` must NOT light up green. Only sessions launched as an agent CLI
// qualify -- matched against the session's launch command.
export function isAgentCommand(command: string): boolean {
  return /\b(claude|codex|vibe|opencode)\b/i.test(command);
}

// A session is "agent working" when it was launched as an agent AND it
// produced output within the activity window. The command gate answers
// "which kind of session", the output recency answers "is it doing
// anything right now".
export function sessionIsAgentWorking(
  session: Pick<TerminalSession, "command" | "lastOutputAt">,
  now: number,
  thresholdMs: number = ACTIVITY_THRESHOLD_MS,
): boolean {
  return (
    isAgentCommand(session.command) &&
    isSessionActive(now, session.lastOutputAt, thresholdMs)
  );
}

// Node-level aggregate: green when any of the node's sessions is an agent
// that is currently working.
export function nodeHasWorkingAgent(
  sessions: readonly TerminalSession[],
  nodeId: string,
  now: number,
  thresholdMs: number = ACTIVITY_THRESHOLD_MS,
): boolean {
  return sessions.some(
    (s) => s.nodeId === nodeId && sessionIsAgentWorking(s, now, thresholdMs),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/sessions-helpers.test.ts`
Expected: PASS (existing cases + the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/sessions.ts test/sessions-helpers.test.ts
git commit -m "feat(workspace): agent-gated activity helpers (sessions.ts)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire agent-gated dots + strengthen the active-session marker

**Files:**
- Modify: `app/src/components/WorkspaceNodeList.tsx` (imports; node dot ~line 77/100-105; session dot ~line 110/123-127; active sub-row styling ~line 117-128)

**Interfaces:**
- Consumes: `nodeHasWorkingAgent`, `sessionIsAgentWorking` from Task 1.

- [ ] **Step 1: Swap the imports**

In `app/src/components/WorkspaceNodeList.tsx`, replace the `sessions` import (lines 12-17):

```ts
import {
  countSessionsByNode,
  isSessionActive,
  nodeIsActive,
  type TerminalSession,
} from "../lib/sessions";
```

with:

```ts
import {
  countSessionsByNode,
  nodeHasWorkingAgent,
  sessionIsAgentWorking,
  type TerminalSession,
} from "../lib/sessions";
```

- [ ] **Step 2: Use the node-level agent gate + honest label**

Replace line 77:

```ts
        const active = nodeIsActive(sessions, r.id, now);
```

with:

```ts
        const active = nodeHasWorkingAgent(sessions, r.id, now);
```

Then in the node dot (lines 100-105), change the `title` so it no longer claims "Agent píše" for raw output:

```tsx
              <span
                role="img"
                className={`inline-block h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-amber-500/70"}`}
                title={active ? "Agent pracuje" : "Idle"}
                aria-label={active ? "active" : "idle"}
              />
```

- [ ] **Step 3: Use the session-level agent gate**

Replace line 110:

```ts
                  const sessActive = isSessionActive(now, s.lastOutputAt);
```

with:

```ts
                  const sessActive = sessionIsAgentWorking(s, now);
```

- [ ] **Step 4: Strengthen the active-session marker (úkol 1) + add a dot title**

Replace the session sub-row button opening tag and the dot/label (lines 114-128) with:

```tsx
                      <button
                        type="button"
                        onClick={() => onSelectSession(r.id, s.id)}
                        style={
                          sessSelected
                            ? { boxShadow: "inset 2px 0 0 0 var(--color-accent)" }
                            : undefined
                        }
                        className={`group flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] transition-colors ${
                          sessSelected
                            ? "bg-[var(--color-surface)] font-medium text-[var(--color-text)]"
                            : "text-[var(--color-text-dim)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        <span
                          role="img"
                          aria-label={sessActive ? "active" : "idle"}
                          title={sessActive ? "Agent pracuje" : "Idle"}
                          className={`inline-block h-1.5 w-1.5 rounded-full ${sessActive ? "bg-emerald-500" : "bg-amber-500/70"}`}
                        />
                        <span
                          className={`font-mono text-[11.5px] ${
                            sessSelected ? "font-semibold text-[var(--color-accent)]" : ""
                          }`}
                        >
                          #{idx + 1}
                        </span>
```

(The closing `</button>` and the X close-control span below stay unchanged.)

- [ ] **Step 5: Typecheck**

Run: `npm --prefix app run build`
Expected: tsc passes (no unused-import error for the swapped `sessions` imports; `nodeIsActive`/`isSessionActive` are no longer referenced in this file).

- [ ] **Step 6: Visual verification (desktop shell)**

Start the desktop dev shell: `cargo tauri dev`. Then:
- Open two sessions on one node: a Claude session and a bare shell (`zsh`). Confirm: the Claude session's dot goes green while it streams output; the shell's dot stays amber even while you type or run `ls`. (Fixes úkol 6a.)
- Switch the active session. Confirm the selected sub-row now has a clear accent left-bar, surface background, and accent-colored `#N` — unmistakable vs. the others. (Fixes úkol 1.)

- [ ] **Step 7: Commit**

```bash
git add app/src/components/WorkspaceNodeList.tsx
git commit -m "feat(workspace): agent-gated activity dot + clear active-session marker" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Per-mode ANSI palette for the terminal (úkol 8)

**Files:**
- Modify: `app/src/lib/theme.ts` (add `AnsiPalette` type + `ansi` field on `ThemeColors`; populate `DARK_THEME` and `LIGHT_THEME`)
- Modify: `app/src/components/TerminalPane.tsx` (import `THEMES`; `buildXtermTheme(theme)`; update call sites at lines 133 and 437)

**Interfaces:**
- Produces: `ThemeColors.ansi: AnsiPalette` (the 16 standard xterm ANSI keys).
- Consumes: `Theme` (already imported in TerminalPane), `THEMES` from `theme.ts`.

- [ ] **Step 1: Add the ANSI palette to the theme tables**

In `app/src/lib/theme.ts`, add the type after `ThemeColors` (after line 15):

```ts
// The 16 ANSI colors xterm uses for SGR-colored output (diffs, agent
// spinners, syntax). xterm's built-in defaults are tuned for a dark
// background; on the light theme's near-white bg the bright defaults
// vanish. We supply an explicit palette per mode so diff +/- lines and
// code stay readable in both. Keys match xterm's ITheme exactly.
export type AnsiPalette = {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};
```

Add `ansi: AnsiPalette;` to the `ThemeColors` type (before its closing brace at line 15):

```ts
  nodeColors: Record<string, string>;
  nodeColorDefault: string;
  ansi: AnsiPalette;
};
```

In `DARK_THEME` (before its closing brace at line 35), add:

```ts
  ansi: {
    black: "#1e2127",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#d1d5db",
    brightBlack: "#6b7280",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#f9fafb",
  },
```

In `LIGHT_THEME` (before its closing brace at line 55), add a palette whose colors are dark enough to read on the near-white background:

```ts
  ansi: {
    black: "#1e293b",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#b45309",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#475569",
    brightBlack: "#334155",
    brightRed: "#b91c1c",
    brightGreen: "#15803d",
    brightYellow: "#a16207",
    brightBlue: "#1d4ed8",
    brightMagenta: "#7e22ce",
    brightCyan: "#0e7490",
    brightWhite: "#1e293b",
  },
```

- [ ] **Step 2: Feed the palette into `buildXtermTheme`**

In `app/src/components/TerminalPane.tsx`, change the theme import (line 26):

```ts
import type { Theme } from "../lib/theme";
```

to:

```ts
import { THEMES, type Theme } from "../lib/theme";
```

Replace `buildXtermTheme` (lines 59-71) with a theme-aware version:

```ts
// Read current CSS variables into an xterm ITheme, merged with the
// mode's 16-color ANSI palette. Called at mount and on every theme flip.
function buildXtermTheme(theme: Theme): ITheme {
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue("--color-bg").trim();
  const fg = css.getPropertyValue("--color-text").trim();
  const accent = css.getPropertyValue("--color-accent").trim();
  return {
    background: bg || "#0e1015",
    foreground: fg || "#e6e7ea",
    cursor: accent || "#7ec8ff",
    cursorAccent: bg || "#0e1015",
    selectionBackground: "rgba(126, 200, 255, 0.25)",
    ...THEMES[theme].ansi,
  };
}
```

- [ ] **Step 3: Update both call sites to pass `theme`**

At line ~133 (inside the `new Terminal({...})` options), change:

```ts
      theme: buildXtermTheme(),
```

to:

```ts
      theme: buildXtermTheme(theme),
```

At line ~437 (the theme-flip effect), change:

```ts
    term.options.theme = buildXtermTheme();
```

to:

```ts
    term.options.theme = buildXtermTheme(theme);
```

- [ ] **Step 4: Typecheck**

Run: `npm --prefix app run build`
Expected: tsc passes. (`theme` is in scope at both call sites: the constructor runs inside the component body where the `theme` prop is visible, and the effect already lists `theme` in its dependency array.)

- [ ] **Step 5: Visual verification (desktop shell)**

Under `cargo tauri dev`, open a terminal and run an agent that prints a colored diff (e.g. ask Claude to show a small `git diff`, or run `git --no-pager diff` on a dirty file). Toggle light mode (theme button in the sidebar). Confirm: in BOTH light and dark mode the `+`/`-` diff lines, file headers, and code are clearly readable — nothing washes out to near-invisible on the light background. (Fixes úkol 8.)

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/theme.ts app/src/components/TerminalPane.tsx
git commit -m "fix(terminal): per-mode ANSI palette so diffs read in light mode" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Cluster A of the design spec):**
- Úkol 1 (active terminal not marked): Task 2 Step 4 (accent bar + surface bg + accent `#N`). ✓
- Úkol 6a (indicator green without agent working): Tasks 1 + 2 (command-gated `sessionIsAgentWorking`/`nodeHasWorkingAgent`, honest titles). ✓
- Úkol 8 (diffs invisible in light mode): Task 3 (16-color ANSI palette per mode). ✓
- "6a frontend-only via `session.command`; 6b deferred to Tauri batch": Architecture note + Task 1 design. ✓
- "Keep `sessions.ts` pure / node-test covered": Task 1 is pure + tested. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every verification step names the exact command + observable outcome. ✓

**Type consistency:** `buildXtermTheme(theme: Theme)` ← both call sites pass the `theme` prop; `...THEMES[theme].ansi` is `AnsiPalette`, whose keys are the xterm `ITheme` ANSI keys. `sessionIsAgentWorking`/`nodeHasWorkingAgent` names identical between `sessions.ts` (definition), `test/sessions-helpers.test.ts` (import), and `WorkspaceNodeList.tsx` (import). The removed `nodeIsActive`/`isSessionActive` imports are no longer referenced in `WorkspaceNodeList.tsx`. ✓
