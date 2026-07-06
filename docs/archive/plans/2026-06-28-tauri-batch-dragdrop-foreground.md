# Tauri Batch — Finder Drag-Drop + Foreground-Process Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two terminal fixes that need the desktop/Rust layer (the slow `cargo tauri` loop), batched together: drop a file from Finder onto the active terminal to insert its path (úkol 7), and — as the precision layer on top of cluster A's úkol 6a — detect whether an agent is actually *computing* via the PTY foreground process group (úkol 6b).

**Architecture:** úkol 7 is frontend-only against an existing Tauri command: the active `TerminalPane` listens to Tauri's native `onDragDropEvent` (which carries real filesystem paths, unlike the webview's HTML5 drop on macOS) and writes the shell-quoted path(s) to its session via the existing `pty_write` command. No `tauri.conf.json` change (we keep `dragDropEnabled` at its default `true` so the native event fires) and no capability change (`core:event:default` is already granted). úkol 6b is a Rust spike in `pty.rs` (foreground-pgrp polling), then a small event + frontend consumer — it is genuinely uncertain with `portable-pty` and is scoped as a spike, not a turnkey edit.

**Tech Stack:** Tauri 2 (Rust), `portable-pty`, React/xterm.js frontend, `@tauri-apps/api/webview` (`onDragDropEvent`).

## Global Constraints

- **No emoji in code.**
- **Keep `dragDropEnabled` at default (`true`).** On macOS the webview's HTML5 drop does NOT expose a real filesystem path; Tauri's native `onDragDropEvent` does. Disabling it would break the path-capture approach.
- **Only the active pane listens.** All `TerminalPane`s are mounted (inactive = `display:none`); the drag-drop listener must be registered only by the `active` pane so the drop targets the visible session.
- **úkol 6b is a spike first.** Do not ship speculative Rust as if verified — Task 2 Step 1 is a feasibility gate; if the master fd isn't reachable through `portable-pty`, stop and report rather than forcing it.
- **This is the slow loop.** Verification needs `cargo tauri dev` (first Rust build 10-15 min, incremental 30-60 s) or a full `cargo tauri build`. Frontend-only parts of Task 1 still hot-reload under `cargo tauri dev`.
- Rust: `cargo build` / `cargo tauri dev` from `src-tauri/` (or repo root for the tauri CLI). Frontend typecheck: `npm --prefix app run build`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `app/src/components/TerminalPane.tsx` | xterm pane + PTY IPC | úkol 7: `onDragDropEvent` listener on the active pane + `shellQuote` (Task 1) |
| `src-tauri/src/pty.rs` | PTY sessions, reader thread | úkol 6b: foreground-pgrp poll + `pty-foreground` emit (Task 2, spike) |
| `src-tauri/src/lib.rs` | command/event wiring | úkol 6b: only if the spike adds a command (Task 2) |
| `app/src/App.tsx` + `app/src/lib/sessions.ts` | session activity model | úkol 6b: consume the busy signal (Task 2) |

---

### Task 1: Drop a Finder file onto the active terminal (úkol 7)

**Files:**
- Modify: `app/src/components/TerminalPane.tsx` (add a `shellQuote` helper near the top; add a drag-drop `useEffect` alongside the other effects, ~after the theme effect at line 438)

**Interfaces:**
- Consumes: the existing `pty_write` command — `invoke("pty_write", { args: { session_id, data } })` (the exact shape already used at `TerminalPane.tsx:273-276`); the `active` and `sessionId` props.

- [ ] **Step 1: Add a POSIX shell-quote helper**

In `app/src/components/TerminalPane.tsx`, near the other module-scope helpers (e.g. after `b64ToBytes`, ~line 84), add:

```ts
// POSIX single-quote a path so spaces/quotes/specials survive when written
// into the shell line. Wrap in '...' and escape embedded ' as '\''.
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}
```

- [ ] **Step 2: Add the drag-drop effect (active pane only)**

In `app/src/components/TerminalPane.tsx`, after the theme effect (the `useEffect(... , [theme])` block ending at line 438), add:

```tsx
  // (D) Finder drag-and-drop. Drop a file onto the ACTIVE terminal to
  // insert its shell-quoted path at the cursor. Only the active pane
  // registers the listener, so the drop targets the session the user is
  // looking at. Tauri's native drag-drop event carries the real
  // filesystem paths (the webview's HTML5 drop does not on macOS), so we
  // use onDragDropEvent and write via the existing pty_write command.
  useEffect(() => {
    if (!isTauri() || !active) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const { invoke } = await import("@tauri-apps/api/core");
      const un = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths;
        if (!paths || paths.length === 0) return;
        const data = paths.map(shellQuote).join(" ") + " ";
        void invoke("pty_write", {
          args: { session_id: sessionId, data },
        }).catch(() => undefined);
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [active, sessionId]);
```

- [ ] **Step 3: Typecheck**

Run: `npm --prefix app run build`
Expected: tsc passes. (`@tauri-apps/api/webview` ships `onDragDropEvent`; `event.payload` is the `DragDropEvent` union with a `"drop"` variant carrying `paths: string[]`.)

- [ ] **Step 4: Verify in the desktop shell**

Run `cargo tauri dev`. Open a terminal session, make it the active pane, and drag a file from Finder onto the terminal area. Confirm the file's absolute path (single-quoted) is inserted at the prompt followed by a space, ready to use as an argument. Drag a file with a space in its name and confirm the quoting holds. Switch to a different session and confirm the drop now targets that one (only the active pane reacts). (Fixes úkol 7.)

- [ ] **Step 5: Commit**

```bash
git add app/src/components/TerminalPane.tsx
git commit -m "feat(terminal): drop a Finder file to insert its path in the active terminal" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Foreground-process "agent is computing" signal (úkol 6b) — SPIKE

> **This task is a spike, not a turnkey edit.** Cluster A's úkol 6a already removed the false-green on bare-shell sessions (command-gated). úkol 6b adds precision: green only while an agent session is *actually computing* (a child is in the PTY foreground), amber when it's idle at its prompt. The mechanism is a Unix `tcgetpgrp` on the PTY master fd — whose reachability through `portable-pty`'s `Box<dyn MasterPty>` is the open question. Step 1 is a hard feasibility gate.

**Files:**
- Investigate/Modify: `src-tauri/src/pty.rs` (the `Session` struct + reader/poll); possibly `src-tauri/src/lib.rs` (event already flows via `Emitter`, so likely no new command)
- Modify (if the spike lands): `app/src/App.tsx` (listen for the new event), `app/src/lib/sessions.ts` (fold "busy" into the activity model)

- [ ] **Step 1: Feasibility gate — can we read the foreground pgrp?**

In `src-tauri/src/pty.rs`, the `Session` already holds the `master` (`MasterPty`) and the spawned `child`. Determine whether the master's raw fd is reachable on Unix. Concretely, in a scratch build try:

```rust
// portable-pty exposes the master; on Unix we need its fd for tcgetpgrp.
// Path A: master.as_raw_fd() if Box<dyn MasterPty> implements AsRawFd.
// Path B: master.try_clone_reader()/take_writer() do NOT give the fd;
//         if A fails, check portable_pty's PtyPair/native master concrete
//         type for an as_raw_fd(), or store the fd at spawn via the
//         openpty path before boxing.
```

Decision:
- If a raw fd is obtainable: continue to Step 2.
- If not: **stop.** Record the finding in `docs/lessons-learned.md` (one paragraph: portable-pty does not surface the master fd; úkol 6b needs either a portable-pty patch or capturing the fd at openpty time) and leave úkol 6 as solved by 6a. Do not force a brittle workaround.

- [ ] **Step 2: Poll the foreground pgrp and derive "busy"**

(Only if Step 1 succeeded.) The signal: a session is "agent computing" when the PTY's foreground process group differs from the shell's own pgid (i.e. a child — the agent or a command — currently owns the terminal foreground). At spawn, the child's pid is the shell's pgid (it's a session leader). Then, on the existing reader cadence (or a lightweight 500 ms poll thread per session), call `tcgetpgrp(master_fd)` and compare:

```rust
// fg_pgrp == shell_pgid  -> idle at the shell prompt (amber)
// fg_pgrp != shell_pgid  -> a child is foreground -> busy (green)
// libc::tcgetpgrp(fd) returns the foreground pgid, or -1 on error.
```

Store the shell pgid on the `Session` at spawn (the child's pid). Emit a new event whenever the busy state flips:

```rust
// app.emit("pty-foreground", ForegroundPayload { session_id, busy })
// (Emitter is already imported and used for pty-data/pty-exit.)
```

Keep it cheap: only emit on transitions, not every poll.

- [ ] **Step 3: Consume the signal in the frontend**

(Only if Step 2 landed.) In `app/src/App.tsx`, add a `pty-foreground` listener (next to the existing `pty-data`/`pty-exit` listeners, ~line 516) that records a per-session `busy: boolean`. Extend the session model in `app/src/lib/sessions.ts` with an optional `foregroundBusy` field and have `sessionIsAgentWorking` (added in cluster A) prefer it when present:

```ts
// When the Rust foreground signal is available, it is authoritative:
// agent working == agent command AND foreground-busy. Fall back to the
// output-recency heuristic only when no foreground signal has arrived.
```

Add a unit case to `test/sessions-helpers.test.ts` for the `foregroundBusy === false` path suppressing green even with recent output.

- [ ] **Step 4: Verify in the desktop shell**

(Only if implemented.) Under `cargo tauri dev`: launch an agent, give it a long task, and confirm the dot is green only while it computes and drops to amber within ~1 s of it returning to its prompt. Confirm a bare `sleep 5` in a shell session also reads as busy-then-idle (foreground child), which is acceptable — it is genuinely a foreground process. (Refines úkol 6.)

- [ ] **Step 5: Commit (whatever the outcome)**

If implemented:
```bash
git add src-tauri/src/pty.rs src-tauri/src/lib.rs app/src/App.tsx app/src/lib/sessions.ts test/sessions-helpers.test.ts
git commit -m "feat(terminal): foreground-process agent-busy signal (pty-foreground)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
If the spike concluded "not feasible":
```bash
git add docs/lessons-learned.md
git commit -m "docs: úkol 6b spike — portable-pty master fd not reachable; 6a stands" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Tauri batch of the design spec):**
- Úkol 7 (drag-drop from Finder): Task 1 (native `onDragDropEvent` → `pty_write`, active pane only). ✓
- Úkol 6b (foreground "computing vs idle" precision): Task 2, scoped honestly as a spike with a feasibility gate. ✓
- "Keep `dragDropEnabled` default, native event for real paths": Global Constraints + Task 1 design. ✓
- "6b is the deferred precision layer on top of 6a": Task 2 preamble. ✓

**Placeholder scan:** Task 1 is complete, runnable code. Task 2 is explicitly a spike — its Rust is illustrative-by-design with a hard feasibility gate (Step 1) and a documented stop-condition, not a pretend-verified edit. This is flagged, not hidden. ✓

**Type consistency:** Task 1's `invoke("pty_write", { args: { session_id, data } })` matches the existing call shape (`TerminalPane.tsx:273-276`) and the Rust `WriteArgs { session_id, data }` (`pty.rs:433-437`). Task 2's frontend additions (`foregroundBusy`, `pty-foreground`) are gated on the spike landing and would be wired through `sessionIsAgentWorking` (cluster A). ✓

**Known scope note:** úkol 6b may end at Step 1 as "not feasible without a portable-pty change"; that is an acceptable, documented outcome — úkol 6 remains fixed by cluster A's 6a in that case.
