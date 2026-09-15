# The task surface: a thread is a canvas, not a detail pane

Supersedes the **Web** section of
`docs/superpowers/specs/2026-09-12-runner-and-session-design.md` for
everything about where a task lives and how one is started. The rest of
that spec — model, runtime, events, live channel, API, adapters — stands
unchanged.

"The runner" below is always the `claude` binary the Agent SDK spawns as
a subprocess (`domain/runner/adapters/claude.ts`), authenticated by its
own login, never an API key.

What the runner spec said, and what phase 3 (#342) implemented
faithfully: "the centre is `SessionChat` when the selected node has an
open session, else the node detail". Four consequences, all observed on
0.16.1:

- Opening a task hides the node. `WorkspaceView.tsx`'s `detailSurface()`
  swaps `SessionChat` in for `DetailPane` in the same slot, and with no
  terminal open that slot IS the centre, so no right aside exists at all.
- A node can hold exactly one task. `App.tsx`'s `workspaceOpenSession` is
  a single `SessionSummary | null` (the first running/suspended row);
  terminals have been a list per node from the start.
- Starting a task is a modal that demands the brief up front, before
  there is anything to react to.
- There is no model choice anywhere: `RunStart` has no field for it,
  `POST /sessions` does not accept one, and the adapter builds its SDK
  `Options` without `model`, so every task runs on the runner's default.

A fifth, underneath all of them: `SessionChat.tsx` is a hand-written
chat. Every part of it — bubbles, tool rows, a scroll container, a
composer, markdown, a "something is happening" affordance — is a solved
problem being re-solved badly.

## Scope

In: the Práce canvas, threads as open sessions in the left column,
adopting AI Elements for everything inside the thread, starting a task,
thread naming, model and reasoning effort end to end (web → REST →
`RunStart` → adapter).

Out: remote hosts.

## The terminal comes out first

Every "how do a terminal tab and a thread behave the same" question
exists only because both are on screen at once. That was phase 3's
deliberate choice (compare them on a real node), and it has served its
purpose. **Run the runner spec's phase 4 — the terminal's removal —
before the work below**, so this spec has exactly one kind of canvas to
describe and no dual-behaviour compromises get built into the layout.
Everything here is written as if the terminal is already gone.

## The chat is AI Elements

[AI Elements](https://elements.ai-sdk.dev) (Vercel, **Apache-2.0**) is a
shadcn registry: `npx ai-elements@latest add <component>` copies the
component's **source into this repo**, it is not a locked npm dependency.
Its component set is close to a one-to-one map of our own canonical
events, which is the actual argument for it — we are not adopting a look,
we are deleting a layer we should never have written.

| `CanonicalEvent` / need | Component |
|---|---|
| `assistant_message`, streamed deltas | `Message` + `Streamdown` |
| `reasoning` | `Reasoning`, `Chain of Thought` |
| `tool_call` | `Tool`, `Task` |
| `question` (a permission ask) | `Confirmation` |
| `compaction` | `Checkpoint` |
| the composer | `Prompt Input` |
| model choice | `Model Selector` |
| messages queued while a run is busy | `Queue` |
| "something is happening" | `Loader`, `Shimmer` |
| keeping the transcript pinned to the bottom | `Conversation` |

**What the kit does not give us**, and stays ours: the left column, the
node aside, the `draft` state, suspend/resume and handoffs, and the
transport. Their `useChat` is unusable here — we carry canonical events
over our own WebSocket (#341) — so the boundary is a pure adapter,
`CanonicalEvent` → component props. That adapter is where our work is,
and it is mapping, not design.

**Adoption rules.**

- `apps/web` has no shadcn today (React 19, Tailwind v4 and
  `lucide-react` are already there; Radix, `cva` and `cn` are not).
  Initialize shadcn/ui and pull the primitives the chosen components
  declare (`button`, `collapsible`, `command`, `dialog`, `select`,
  `tooltip`, `badge`, `alert`, `scroll-area`).
- **Bridge the tokens, do not restyle the app.** shadcn's
  `--background`/`--foreground`/`--muted`/… are defined in `index.css` in
  terms of the existing `--color-*` tokens, inside the same
  light/dark blocks. Portuni's palette stays the single source; no
  component may hardcode a colour.
- **Strip the `ai` package.** Most components import it type-only
  (`UIMessage["role"]`). We own the copies: replace those with our own
  union and do not add the dependency.
- New runtime dependencies, all pinned: `streamdown` (+ its code/math/
  mermaid/cjk plugins), `use-stick-to-bottom`, `nanoid`. The heavy
  Streamdown plugins are lazy-loaded, the way xterm already is.
- Keep each copied file's Apache-2.0 header, and record the upstream
  component + version it came from so a later `add` is a readable diff.

`react-markdown`/`remark-gfm` stay for `MarkdownPreview` (the file
preview), which is not chat and is not being touched.

## Rules

1. **The canvas has no chrome.** The middle column is the active thread,
   nothing else. This is not new: the per-node strip was deliberately
   moved out of the middle column into the left one (see the comment
   atop `TerminalTabs.tsx`), and that decision stands.
2. **Open threads live in the left column**, as sub-rows under their
   node in `WorkspaceNodeList`, exactly where a node's terminals are
   today: every node's threads visible at once, one click to any of
   them, inline rename, a status chip per row.
3. **A node holds as many threads as the user opens**, concurrently.
4. **The node detail is the right aside** whenever a thread is open, and
   takes the centre only when the node has none.
5. **A thread opens empty**: no modal, no required field, composer
   focused, transcript empty.
6. **A thread is open or closed, nothing in between.** Closing it is
   Uzavřít — the one irreversible action and so the one that asks
   first; the × on its row in the left column is that same action.
   Whether the runner's process is currently alive is the server's
   business, never a button.
7. **A thread names itself from its first message**; only a manual
   rename ever replaces that name.
8. **Model and reasoning effort are the thread's**, defaulted from the
   runner instance.

## The session row exists from the moment the thread opens

A thread is a session from the first click, not from the first message:
one surface, one row, no client-only state that other windows and Relace
cannot see.

- `sessions.state` gains **`draft`** (schema check in both dialects, the
  `SessionState` union, `ALLOWED_TRANSITIONS`: `draft → running`, and
  `draft` is terminal only by deletion). A draft has a name
  („Nový úkol"), a node, an owner, and nothing else.
- The first message transitions it to `running` and starts the run.
  `POST /sessions` keeps creating the row for a task started any other
  way; a draft is promoted by `POST /sessions/:id/messages` instead.
- **Every list filters drafts out**: `GET /overview`, the WS snapshot,
  Relace, the sidebar's session sub-rows in other windows. A draft is
  visible only as the open thread it is.
- **Prune.** A draft is deleted when its thread is closed still empty,
  and `boot/session-sweep.ts` deletes any draft older than 24 hours —
  the same sweep that already resolves rows left `running` by a dead
  process. A draft has no runs, no events and no handoff, so deletion is
  a single `DELETE`, not an archive.

## Thread lifecycle

Every action here is deterministic: the server decides and acts, and
none of it waits on the agent choosing to cooperate. Drawn in
`docs/superpowers/mockups/2026-09-15-task-chat.html`.

**Stop** is the composer's own submit button, flipped to a stop square
by `Prompt Input`'s `status`, plus the Esc key. It cancels the current
turn (`Query.interrupt()`) and nothing more: process, prompt queue and
run stay alive, and the next message is an ordinary message.
`adapters/claude.ts` stops ending the prompt queue inside `interrupt()`
— that is what collapses it into "kill the run" today and leaves a
session `running` with no live run for `sendMessage` to refuse. Ending
the queue belongs to `close()` alone.

**Idle.** The server ends a run with no activity for
`PORTUNI_RUN_IDLE_MS` (default 30 min), writes the summary and moves
the session to `suspended`, labelled **Nečinné**. No user action
produces that state and none is offered for it.

**The summary is the server's, written from `session_events`** — the
last messages, the files changed, any open question, the write set —
whenever a run ends other than by Uzavřít. Mechanical, instant, always
available. `SUSPEND_INSTRUCTION`, the 30 s `pollUntilSuspended`, the
`suspend_timeout` fallback, the `generated_by: agent | server` split
and `POST /sessions/:id/suspend` all go. `portuni_session_suspend`
stays for hand-opened CLIs, the only channel those have; a handoff a
thread happens to have is appended to the summary, never waited for.

**Resume is writing.** Sending into a thread whose run has ended starts
a new one: `--resume` on the last run's `agent_session_id` while that is
still valid, from the summary when it is not. The server picks — no
mode picker, no Nahodit. `POST /sessions/:id/resume` becomes internal
to `POST /sessions/:id/messages`.

**The notice.** An open thread with no live run shows a bar above the
composer: the process was ended, and the next message replays the whole
conversation into the model. It informs, it does not block — the
composer works with the bar still up. Dismissing hides that one bar;
the next thread woken this way shows a new one.

**Pokračovat v nové session** carries the work into a fresh context.
`POST /sessions/:id/continue` closes this session and creates a new one
on the same node seeded with its summary, and that new row becomes the
active thread. **A new row is the point**: the context boundary is
where the user later looks for "where did this go wrong", so it belongs
in the list, not buried as another run under one thread. Offered beside
the context ring at any time, emphasised once the ring passes 80 %.

**Navázat** is the same endpoint on a closed thread, without the
closing step. A closed thread shows its transcript, no composer, and
this one button.

**Uzavřít** writes the summary, then `closed`, after a confirmation.

No storage change: `suspended` keeps its name in the database and is
only ever reached by the server.

## Model and reasoning effort

Only what `@anthropic-ai/claude-agent-sdk` exposes (verified against the
pinned 0.3.270 `sdk.d.ts`); there is no temperature here.

| Choice | SDK | When it can change |
|---|---|---|
| Model | `Options.model` at start, `Query.setModel(model?)` after | **Any time**, mid-run, without restarting anything |
| Reasoning effort | `Options.effort` (`low \| medium \| high \| xhigh \| max`) | **At the start of a run only** — the SDK has no `setEffort` |

Both are offered in `Prompt Input`'s own model area (`Model Selector`)
before the first message; afterwards the model keeps working live
(`setModel` on the live `Query`, through a new `RunHandle.setModel`),
while a changed effort applies from the next run — the control says so
rather than pretending otherwise. Effort is offered only on models whose
`ModelInfo.supportsEffort` is true.

`fallbackModel`, `maxTurns`, `thinking`/`maxThinkingTokens` stay out of
the UI entirely: none is a choice this app's user can make well, and
each has a working default.

**Where a value comes from**, first match wins: the thread's own setting
(`sessions.model` / `sessions.effort`), then the runner instance's
defaults (`runners.json`, next to the `env` and org defaults it already
carries), then the runner's own default.

**Enumerating models.** `Query.supportedModels()` returns `ModelInfo[]`
(canonical id, display name, description, `supportsEffort`,
`effortLevels`) and lives on a live query — which a running thread
already has. The adapter caches the list from the first live run of the
process (`RunnerAdapter.models()` reads that cache) and serves it at
`GET /runners/:runner/models`. Before any run has ever happened the list
is the documented aliases (`opus`, `sonnet`, `haiku`) plus free text; a
bare alias is accepted by the SDK, so an empty cache must never block
starting a task. No throwaway process is started just to build a picker.

## Storage

- Migration **036**: `sessions` gains `model TEXT` and `effort TEXT`
  (both nullable) and `draft` joins the `state` check constraint. Both
  dialects — the libsql migration and `schema.pg.ts`'s baseline — per
  B2/B3.
- `runners.json` instances gain an optional `defaults: { model?,
  effort? }`, validated by `instances.ts`; an unknown key is refused the
  way an unknown env key already is.

## API

- `POST /sessions` accepts `model` and `effort`, both optional.
- `PATCH /sessions/:id` accepts the same two, alongside the rename it
  already serves; setting `model` on a session with a live run calls
  through to `RunHandle.setModel` instead of only writing the column.
  Its double shape stays: a bare `{name}` keeps returning
  `SessionSummary`, anything else returns the raw row.
- `POST /sessions/:id/messages` promotes a `draft` to `running` and
  starts the first run.
- `DELETE /sessions/:id` removes a `draft` (and only a draft).
- `GET /runners/:runner/models` → `{ models: RunnerModel[] }`.
- `POST /sessions/:id/continue` → `{ session, run }`: closes this
  session and starts a new one on the same node from its summary.
  Serves both Pokračovat v nové session and Navázat.
- `POST /sessions/:id/interrupt` keeps its route and cancels the
  current turn only.
- `POST /sessions/:id/suspend` and `POST /sessions/:id/resume` leave
  the client surface entirely: idling is the server's, resuming is
  `messages`.
- `SessionSummary` carries `model` and `effort` so the header renders
  the current choice without a second fetch.
- `RunStart` carries them resolved (thread → instance → unset), so the
  adapter never reads config itself.

Routing in `is_local_only_path` is unchanged: `/sessions/:id/messages`
and `/runners/*` are already in the device-local set.

## Web

**Layout** (`WorkspaceView.tsx`). The middle column is the active
thread, mounted for every open thread and toggled with `display:none`
the way terminal panes already are, so a transcript and its scroll
position survive switching nodes. The right aside is
`DetailPane`/`EditorPane` whenever the node has an open thread,
collapsible as today; a node with no thread keeps today's centred
detail. `detailSurface()` loses its `SessionChat` branch.

**Inside the thread**: `Conversation` wrapping the mapped event list,
`Prompt Input` as the composer — whose submit button is also the stop
button, driven by `status` — and a thin header of our own: name, status
chip, runner · instance, the kit's `Context` ring, and two actions,
Pokračovat v nové session and Uzavřít. A question renders as
`Confirmation` above the composer, never as a modal — Povolit, Odmítnout,
and a Povolit vše v tomto vlákně that switches the session's policy to
`auto`.

**The adapter** (`lib/session-chat.ts`, which keeps its pure-helper
role): `CanonicalEvent` → component props, one mapping per kind, plus
the delta buffer feeding `Streamdown`'s streaming input instead of being
withheld from it. `collapseToolCalls` survives; the bubble, tool-row and
markdown rendering it fed do not.

**Left column** (`WorkspaceNodeList.tsx`). Thread sub-rows replace
terminal sub-rows one-for-one: status chip from `session_state`, the
session name as the label, inline rename (`PATCH /sessions/:id`), and a
close affordance that is Uzavřít, confirmation included. `App.tsx`'s single
`workspaceOpenSession` becomes the open-thread set per node plus an
active-thread pointer; a persistent session id and a PTY terminal id
must never share one map (the #343 hazard).

**Starting a task.** Unchanged in placement: the button that opened a
terminal (`NewTaskButton`, `DetailPane.files.tsx`) opens a thread, and
opening it is the whole interaction — one click, the thread is there,
the composer has focus. `NewTaskDialog` is removed. The same button in
the Graf tab's detail pane switches to Práce, opens the node and focuses
the new thread — Graf has no canvas of its own, so a thread started
there must land where it is visible.

**Naming.** `name` comes from the first message: first line, trimmed,
whitespace collapsed, cut at ~60 characters on a word boundary with an
ellipsis. `computeDefaultSessionName`'s `node · date time` stays for what
has no first message of its own (a hand-opened CLI session,
`interactive_chat`). The handoff-title enrichment at suspend
(`sessions.ts`) no longer applies to a thread named this way — the first
message is the user's own words and outranks the agent's summary; only a
manual rename replaces it.

**Relace / Přehled.** „Otevřít chat" opens the thread in the left column
and focuses it, or focuses it if already open; it never replaces the
node detail.

## Phases

1. **The kit**: shadcn init, the token bridge, the components above, and
   `SessionChat` rebuilt on them behind the existing props — the
   adapter, `Conversation`, `Message`/`Streamdown`, `Tool`,
   `Confirmation`, `Prompt Input`. No layout change yet, so the two can
   be compared on one node.
2. **Canvas and threads**: layout, thread sub-rows in the left column,
   per-node thread set, the `draft` state and its prune, first message
   starts the run, naming, `NewTaskDialog` removed.
3. **Lifecycle**: `interrupt()` back to cancelling a turn, the
   server-written summary replacing the suspend handshake, the idle
   sweep, resume-by-writing and its notice, `POST
   /sessions/:id/continue`, Uzavřít's confirmation and Navázat.
4. **Model and effort plumbing**: migration 036, `runners.json`
   defaults, the REST fields, `RunStart`, the adapter's `Options`,
   `RunHandle.setModel`.
5. **Enumeration and the picker**: `RunnerAdapter.models()` with the
   live-run cache, the REST route, `Model Selector` wired to it, and
   the window size the `Context` ring needs.

## Testing

- The adapter is the testable part: `CanonicalEvent` → props, the
  name-from-first-message function, the value-resolution chain, the
  thread-set reducers — all pure, through the server's `node:test`
  runner, as `lib/session-chat.ts`'s helpers already are.
- Copied components are not ours to unit-test; a bug in one is fixed in
  our copy like any other source file.
- Runner adapter: `Options.model`/`effort` set from `RunStart`,
  `setModel` reaching the live query, `models()` against a fake
  `supportedModels`.
- Storage: the `draft` transitions, the prune sweep, and that every list
  endpoint excludes drafts.
- Lifecycle: that `interrupt()` leaves the run live and a message after
  it is accepted; the summary builder against a fixture event list; the
  idle sweep's cutoff; that `continue` closes one session and seeds the
  next; that the summary exists after every non-Uzavřít run end.
- Layout and pickers are macOS/visual verification, not the gate.

## Known gaps, accepted

- Effort cannot change mid-run; the SDK has no setter for it. The
  control states that it applies from the next run.
- The model list is empty until this process has run one task, and falls
  back to aliases plus free text.
- The `Context` ring needs both halves: spent tokens (`session_runs
  .usage`, already recorded) and the model's window size, which only
  the model list carries. Until phase 5 lands there is no ring.
- A server-written summary is a mechanical digest, not the agent's own
  account of where it got to. That is the price of not waiting on the
  agent, and it is the right trade: a summary that always exists beats
  a better one that sometimes does not.
- Copied source means upstream fixes arrive only when we re-run the CLI
  and read the diff. That is the shadcn bargain and it is the reason the
  components can be bent to our events at all.
- Streamdown's math and mermaid plugins are weight we do not need on
  every launch; lazy-load them and check `npm --prefix apps/web run
  build`'s chunk sizes before and after.
