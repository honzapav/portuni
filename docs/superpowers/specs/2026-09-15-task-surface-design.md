# The task surface: a thread is a canvas, not a detail pane

Supersedes the **Web** section of
`docs/superpowers/specs/2026-09-12-runner-and-session-design.md` for
everything about where a task lives and how one is started. The rest of
that spec — model, runtime, events, live channel, API, adapters — stands
unchanged.

What that spec said, and what phase 3 (#342) implemented faithfully: "the
centre is `SessionChat` when the selected node has an open session, else
the node detail". Four consequences, all observed on 0.16.1:

- Opening a task hides the node. `WorkspaceView.tsx`'s `detailSurface()`
  swaps `SessionChat` in for `DetailPane` in the same slot, and with no
  terminal open that slot IS the centre, so no right aside exists at all.
- A node can hold exactly one task. `App.tsx`'s `workspaceOpenSession` is
  a single `SessionSummary | null` (the first running/suspended row);
  terminals have had tabs since day one.
- Starting a task is a modal that demands the brief up front, before
  there is anything to react to.
- There is no model choice anywhere: `RunStart` has no field for it,
  `POST /sessions` does not accept one, and the Claude adapter builds its
  SDK `Options` without `model`, so every task runs on the CLI default.

## Scope

In: the Práce canvas layout, task threads as tabs, starting a task,
thread naming, model and run parameters end to end (web → REST →
`RunStart` → adapter).

Out: the chat's own event rendering (markdown #369, activity visibility
#370), the terminal's removal (runner spec, phase 4), remote hosts.

## Rules

1. **A thread is a canvas tab, peer to a terminal tab.** The canvas is
   the centre; the node detail is the right aside and stays visible
   whenever any canvas tab is open. The node detail takes the centre only
   when the node has no tab at all.
2. **A node holds as many threads as the user opens**, concurrently, the
   way it holds terminals.
3. **A thread opens empty.** No modal, no required field. The tab exists,
   the composer is focused, the transcript is empty.
4. **The first message starts the run.** Until then the thread is
   client-side only: no `sessions` row, no runner process. This keeps the
   runner spec's Rule 2 ("the session exists before the runner") — `POST
   /sessions` still creates the row and then starts the run, it is just
   called on send instead of from a dialog.
5. **A thread names itself from its first message**, not from the date.
6. **Model and parameters are the thread's**, defaulted from the runner
   instance, changeable while the thread is open.

## Model, effort and the rest of the parameters

Only what `@anthropic-ai/claude-agent-sdk` actually exposes (verified
against the pinned 0.3.270 `sdk.d.ts`), no invented knobs — there is no
temperature here:

| Field | SDK `Options` | Notes |
|---|---|---|
| `model` | `model` | Alias (`opus`, `sonnet`, `haiku`) or full id; unset = CLI default |
| `fallback_model` | `fallbackModel` | Used when the primary is overloaded |
| `effort` | `effort` | `low \| medium \| high \| xhigh \| max`, only on models whose `ModelInfo.supportsEffort` is true |
| `max_turns` | `maxTurns` | Guard rail for an unattended thread |

`thinking` / `maxThinkingTokens` stay out: adaptive thinking is the
default on the models this ships against, and a token budget is not a
choice a user of this app can make well.

**Enumerating models.** `Query.supportedModels()` returns `ModelInfo[]`
(canonical id, display name, description, `supportsEffort`,
`effortLevels`). It lives on a live query, so the adapter interface gains
`models(): Promise<RunnerModel[]>`, implemented for Claude by starting a
throwaway query, reading the list and closing it; served as `GET
/runners/:runner/models` and cached for the process lifetime with an
explicit refresh. When enumeration fails the picker degrades to a free
text field — the SDK accepts a bare alias, so a failed list must never
block starting a task.

**Where a value comes from**, first match wins:

1. The thread's own setting (`sessions.model` / `sessions.effort` / …).
2. The runner instance's defaults (`runners.json`, next to `env` and the
   org defaults it already carries).
3. Unset — the CLI's own default.

Changing a thread's model applies to its next run; a run in flight keeps
the one it started with.

## Storage

- Migration **036**: `sessions` gains `model TEXT`, `fallback_model
  TEXT`, `effort TEXT`, `max_turns INTEGER`, all nullable. Both dialects
  (`schema.pg.ts` baseline + the libsql migration), per B2/B3.
- `runners.json` instances gain an optional `defaults` object with the
  same four keys. `instances.ts` validates it; an unknown key is
  refused the way an unknown env key already is.

## API

- `POST /sessions` accepts `model`, `fallback_model`, `effort`,
  `max_turns`, all optional; persisted on the row.
- `PATCH /sessions/:id` accepts the same four (the thread's picker),
  alongside the rename it already serves. Its double shape stays: a bare
  `{name}` keeps returning `SessionSummary`, anything else returns the
  raw row.
- `GET /runners/:runner/models` → `{ models: RunnerModel[] }`.
- `SessionSummary` carries the four so the chat header can render the
  current choice without a second fetch.
- `RunStart` carries them resolved (thread → instance → unset), so the
  adapter never reads config itself.

Every one of these is device-local in central mode already; the routing
in `is_local_only_path` is unchanged except for the new `/runners/*`
sub-path, which is in the local set already.

## Web

**Layout** (`WorkspaceView.tsx`). The centre is the canvas: the tab strip
plus the active tab's body, a terminal or a thread. The right aside is
`DetailPane`/`EditorPane` whenever the canvas has at least one tab,
collapsible as today. A node with no tab keeps today's centred detail.
`detailSurface()` loses its `SessionChat` branch; `SessionChat` becomes a
canvas body next to `TerminalPane`.

**Tabs.** One strip for both kinds, each tab carrying its kind's icon,
its name and a close affordance; `TerminalTabs` generalizes rather than
gaining a sibling. A thread's tab label is its session name, live from
`session_state`. Closing a thread tab closes the view, never the session
— a running task keeps running, and it is reopened from Relace or the
sidebar. This is the opposite of a terminal tab, whose close kills the
PTY, so the close affordance must say which it is (thread: „Zavřít
záložku", terminal: unchanged).

**State** (`App.tsx`). `workspaceOpenSession` (single) is replaced by the
open-thread set per node plus an active-tab pointer, mirroring
`activeSessionIdByNode`. A persistent session id and a PTY terminal id
must not share one map — the #343 note about `workspaceSelectSession`
stealing a terminal's active pointer is exactly this hazard.

**Starting a task.** „Nový úkol" opens an empty thread tab and focuses
the composer. `NewTaskDialog` is removed. The runner/instance/model
controls move into the thread header, where they are pickers with
resolved defaults preselected, editable before the first message and
after it. Sending the first message calls `POST /sessions` with the
brief and the current picker state, then subscribes the way the chat
already does.

**Naming.** The row's `name` comes from the first message: its first
line, trimmed, collapsed whitespace, cut at ~60 characters on a word
boundary, with an ellipsis when cut. `computeDefaultSessionName`'s `node
· date time` stays for what has no first message of its own — a
hand-opened CLI, an `interactive_chat`. `name_is_custom` semantics are
unchanged, so the handoff-title enrichment at suspend still refines an
auto-name later, and a manual rename still wins over both.

**Relace / sidebar / Přehled.** „Otevřít chat" opens the thread as a tab
and focuses it, or focuses the tab if it is already open; it never
replaces the node detail.

## Phases

Four issues, in order; 1 is the only one the others depend on.

1. **Canvas and tabs**: layout, the shared tab strip, per-node thread
   set, empty thread, first message starts the run, `NewTaskDialog`
   removed. Naming rides along (it is the same call site).
2. **Model plumbing**: migration 036, `runners.json` defaults, the REST
   fields, `RunStart`, the Claude adapter's `Options`. No UI beyond
   passing what it is given.
3. **Model enumeration**: the adapter's `models()`, the REST route, the
   cache and its fallback.
4. **Pickers** in the thread header, wired to 2 and 3.

## Testing

- Pure helpers (tab-set reducers, the name-from-first-message function,
  the model resolution chain) unit-tested through the server's
  `node:test` runner, as `lib/session-chat.ts`'s helpers already are.
- Adapter: `Options.model`/`effort`/`maxTurns` set from `RunStart`
  against the injected fake `query`; `models()` against a fake
  `supportedModels`.
- REST: the four fields round-trip through `POST`/`PATCH /sessions`.
- Layout and pickers are macOS/visual verification, not the gate.

## Known gaps, accepted

- Enumeration costs one throwaway CLI start per refresh. The initialize
  response already carries `models`, so a later change can populate the
  cache from a real run's own handshake instead.
- `effort` is offered only for models that declare `supportsEffort`; a
  model that silently downgrades it is the CLI's business, not ours.
- The terminal stays until the runner spec's phase 4. Until then both
  kinds of tab live in one strip, which is the point — they are
  comparable on the same node.
