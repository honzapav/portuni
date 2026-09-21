# The task surface, second revision: the conversation is the content

Supersedes, in `docs/superpowers/specs/2026-09-15-task-surface-design.md`,
the sections **Inside the thread**, **Left column**, **Model and
reasoning effort** (the picker placement only) and the known gap "there
is no ring". Everything else in that spec — the `draft` state, the
lifecycle, the server-written summary, naming, the storage of `model`
and `effort` — stands unchanged.

References: `docs/superpowers/mockups/2026-09-15-task-chat.html` for the
lifecycle states, [AI Elements](https://elements.ai-sdk.dev) for the
components, and [t3code](https://github.com/pingdotgg/t3code) (MIT) for
the activity model and the composer layout.

## Scope

In: the transcript's width, the activity model (what is on screen while
the agent works, how tool calls and reasoning are shown), the composer
and its two rows, runner and instance as a per-thread choice, the
header, the context ring and its data path, one active row and the
spacing in the left column, the command palette, the draft chip, the
node link in the unsynced overview.

Out: remote hosts, a permission-mode picker (the `policy` field stays
`default` until a later spec), attachments, message queueing.

## Rules

1. **The conversation is the content; everything else is folded.** The
   user's prompt and the agent's answer are the only elements rendered
   at full weight. Reasoning, tool calls, file changes and run
   bookkeeping render collapsed, one summary row per turn, and expand on
   demand.
2. **Something is always on screen while a run is live.** Between the
   moment a message is sent and the moment the run ends there is at
   every instant either streaming content or a live activity row. A
   live run with an empty transcript end is a bug.
3. **The thread column is centred and bounded.** Transcript and composer
   share one column with side gutters of at least 10 % of the pane
   width and a maximum column width of 768 px.
4. **Choices live in the composer, facts in the header.** Model,
   effort, runner and instance are chosen in the composer's rows. The
   header shows the name, the status, the context ring and the two
   thread actions, nothing else.
5. **Runner and instance are the thread's, chosen before the first
   message.** A draft opens with the organisation's defaults already
   written on its row, the composer shows them, and they can be changed
   until the first message promotes the draft. After that they are
   fixed for the thread; model stays live, effort applies from the next
   run.
6. **One row is active in the left column.** The fill and the accent
   bar mark exactly one row: the open thread when there is one,
   otherwise the selected node.
7. **A hand-opened CLI session is not a thread.** It has no sub-row in
   Práce; it lives in Relace.

## The thread column

`Conversation`'s content and the composer sit in one column:
`width: min(80%, 768px)`, centred, at every pane width. The scroll
container stays full-width so the scrollbar keeps its edge; only the
content is bounded. The lifecycle notice bar, the `Confirmation` panel
and the composer are the same width as the transcript.

## The activity model

### Rows

The transcript is a list of rows derived from the canonical events of
the session. Derivation is pure (`lib/session-chat.ts`), tested from the
server's `node:test` runner, and produces these row kinds:

| Row | Source | Rendering |
|---|---|---|
| prompt | `user_message` | `Message from="user"`: bubble, as today |
| answer | `assistant_message` | `Message from="assistant"`: plain text, `Streamdown` |
| activity group | every `reasoning`, `tool_call`, `file_change` between two answers (or between a prompt and the first answer) of one run | one collapsed summary row; expanded, a `ChainOfThought` list with one `Tool` per call |
| live activity | the current run's open activity group while the run is live | the group's summary row plus the one tool that is `running`, always expanded, at the transcript end |
| working | a live run with no open tool and no delta in flight | `Loader` with a label and an elapsed counter |
| question | `question` | marker when historical; `Confirmation` above the composer when open (unchanged) |
| compaction | `compaction` | `Checkpoint` (unchanged) |
| summary | `handoff` | marker "Shrnutí uloženo" |
| note | `run_ended` with reason `interrupted` | neutral marker "Přerušeno" |
| error | `error`, and a `run_ended` with reason `error`, `limit` or `host_lost` | marker in the danger colour |

`run_started`, `run_ended` with reason `completed` or `suspended` (the
ordinary end of every run in this runtime), and `state_changed` produce
no row. They still drive the live-run detection and the
lifecycle notice.

### The activity group

The summary row reads like a sentence built from counts, in Czech:
"Přečteno 3 soubory · upraven 1 · 2 příkazy · uvažoval 12 s". The
mapping from tool name to verb lives in one table in
`lib/session-chat.ts` (`Read`/`Glob`/`Grep` → přečteno, `Edit`/`Write`
→ upraven/vytvořen, `Bash` → příkaz, anything else → its own name). A
failed call makes the row carry the danger colour and the failed count.
A group with a single call shows that call's title instead of a
sentence.

Expanded, the group is a `ChainOfThought` whose steps are the calls in
order, each a `Tool` with the input summary and output excerpt, and the
reasoning block first when there is one. The expanded state is per
group and per mount; a group never expands on its own except the live
one.

### The live row

While a run is live the transcript end is exactly one of:

- streaming reasoning (`Reasoning isStreaming`), then
- streaming answer text (`MessageResponse isAnimating`), then
- the live activity row when a tool is `running`, then
- the working row.

The working row's label follows the last thing that happened:
"Spouštím…" from the message until `run_started`, "Přemýšlím…" after
that until the first delta or tool, "Pokračuji…" after a tool finishes
until the next delta or tool. The counter shows seconds since the row
appeared. The row is removed when the run ends.

### Streaming

Deltas are coalesced on the client: the client buffers delta frames and
flushes them to React state once per animation frame, so a burst of
frames costs one render. The desktop bridge (`sessions_ws.rs`) forwards
delta frames unchanged; the coalescing is in the webview only, so both
the browser and the desktop paths share it.

## The composer

Two rows under the textarea, both inside the composer's border.

**Row 1 — the run's choices, left; send/stop, right.**
`Model ▾` · `Effort ▾` (only when the model supports it; the trigger's
title says a change applies from the next run). The submit button is
the stop button while a run is live, as today.

**Row 2 — where it runs, dimmer, smaller.**
`Runner · instance ▾` · `host`. The runner/instance trigger opens one
select listing every instance grouped by runner, the organisation's
default marked; it is enabled only while the thread is a draft and
renders as a plain label afterwards. The host is the device whose
sidecar runs the thread; it is a label, never a choice, and is hidden
when unknown.

Nothing in the header duplicates these rows. The sub-header text
"runner · instance · host · model · effort" is removed.

## The header

Left: status dot, name, status chip. Right: the context ring, then
"Pokračovat v nové session" and "Uzavřít" (unchanged behaviour).

The status chip for `draft` reads **Nový** in both the header and the
row variant, so a draft's header no longer reads "Nový úkol Nový úkol".

## Runner and instance on the draft

- `POST /sessions` with `draft: true` (and `POST /sessions/record`
  with `draft: true` in a team workspace) writes `runner` and
  `instance_id` on the draft row. The device resolves them
  (`resolveTaskDefaults`, which already reads the org default from
  `runners.json`) before the request; the store only records. A device
  with no usable runner still creates the draft, with both null, and the
  composer's row 2 says so ("Žádný runner není přihlášený") instead of
  the picker.
- `PATCH /sessions/:id` accepts `runner` and `instance_id` from a
  client only while `state = 'draft'`; on any other state the field is
  refused with 409 `SESSION_NOT_DRAFT`. (The promotion path's own patch,
  which sets them together with `state: "running"`, is unaffected.)
- Promotion uses the draft's `runner`/`instance_id` when set, and
  `resolveTaskDefaults` only when they are null.
- `SessionSummary` already carries both; no new field.

## The context ring

### Data

The Claude adapter emits a new canonical event after every SDK
`assistant` message and every `result`:

```
kind: "context_usage"
payload: {
  run_id, model,
  used_tokens,      // input + cache_creation + cache_read of the latest assistant usage
  max_tokens,       // modelUsage[model].contextWindow from the latest result, null until one exists
  input_tokens, cached_tokens, output_tokens
}
```

It is persisted like every other canonical event, so a replay rebuilds
the ring, and the latest one is folded into `SessionSummary` as
`context_used_tokens` / `context_max_tokens` (columns on `sessions`,
migration in both dialects, written by the runtime on each event) so
lists and the header render without reading the log. `run_ended.usage`
stays as it is.

### Rendering

AI Elements' `Context` in the header: the ring with the percentage,
hover card with used/max and the breakdown. Below 80 % it uses the
text-dim colour, from 80 % the warning colour, and "Pokračovat v nové
session" switches to the default (filled) button variant at the same
threshold. With `max_tokens` null the ring shows the used count only.
With no `context_usage` at all (a draft, an old session) the ring is
absent, not a placeholder.

## Left column

- Metrics: node rows 36 px, thread sub-rows 32 px, 4 px between
  sub-rows, 8 px between nodes, 16 px above a section heading, 12 px
  horizontal padding on the column, 10 px inside a row. Text stays at
  13 px on node rows and 12.5 px on sub-rows.
- The accent bar and the `surface-2` fill mark one row. When a thread
  is the active one, its node row renders unfilled (name in the normal
  weight). The node row is filled only when the centre shows the node
  itself.
- A node's sub-rows list its threads: sessions with
  `session_type = 'interactive_task'` and `cli = null`. A hand-opened
  CLI session (`cli` set) is not listed under the node; Relace keeps
  it.
- The status dot on a node row appears only when a thread under it is
  running or waiting; no dot for suspended or draft threads. In the
  "Stav" view no dots at all (the group is the status).

## Command palette

The node palette (⌘K) is shadcn's `CommandDialog` with its defaults,
not a styled copy:

- The search row is the dialog's own top row: 48 px, the icon in a 20 px
  slot at the left inset, the field bare with no border, no fill and no
  focus ring of its own; a 1 px divider below. The caret sits on the
  text baseline of the rows beneath it.
- The list has 8 px vertical padding. Rows are 40 px, inset 8 px from
  the dialog edge, `rounded-md`; the active row's fill is inset with
  the row, never flush to the dialog edge. Keyboard and pointer share
  the same active style.
- A row is: a 20 px icon slot holding the node's type dot, the name,
  and a right slot. The right slot holds the type name in the muted
  colour and the same size as the row text ("Organizace", "Oblast",
  "Projekt", "Proces", "Princip"); no bordered monospace badge. When a
  group heading already names the type the right slot is empty.
- Group headings: 12 px, muted, 8 px inset, 12 px above and 4 px below.
- A footer row under the list: key hints "↑↓ Navigace · Enter Otevřít ·
  Esc Zavřít" in `Kbd` chips, 44 px, on the dialog's `surface`
  background above a divider.
- The empty state ("Žádný uzel") is centred, muted, 24 px padding.

The palette keeps its single purpose (find and open a node); actions
are not added here.

## Přehled

The dashboard follows shadcn's dashboard block: a strip of counters on
top, the cards under it, the page using the width it has.

- The page is `max-w-[1400px]` with 24 px padding, not `max-w-5xl`.
- **Counter strip**, four cards in one row (two per row under 1024 px):
  Čeká na mě, Běží, Vyžaduje pozornost, Nesynchronizováno. Each is a
  number with its label under it; clicking one opens the matching place
  (Práce in the Stav view for the first two, Graf for attention, the
  Nesynchronizováno dialog for the last).
- **Cards**: Relace, Vyžaduje pozornost, Poslední aktivita, Nové uzly,
  in a two-column grid. Every card lists at most **8 rows**; the rest is
  behind a footer link "Zobrazit všech N" that expands the card in place
  (per mount). A card with nothing to show keeps its empty line, not its
  height.
- **Relace** lists threads (rule 7: `session_type = 'interactive_task'`,
  `cli = null`) — waiting first, then running, then suspended — plus the
  disconnected-jump queue as today. Hand-opened CLI sessions are not
  rows here; the card's footer says "K tomu N relací z CLI (N běží)" and
  Relace under the node keeps them.
- **Rows** are 36 px: name and chip on the first line, node · time on
  the second at 11.5 px; the chip is the state chip from
  `sessionRowChip`, not a text fragment.

## Unsynced overview

The node name in "Nesynchronizováno" navigates the way Přehled's node
links do: select the node and switch to Graf with its detail open.

## API and storage

- `POST /sessions` (draft) and `POST /sessions/record` (draft): accept
  and write `runner`, `instance_id`.
- `PATCH /sessions/:id`: `runner`/`instance_id` from a client only on a
  draft, else 409 `SESSION_NOT_DRAFT`.
- New canonical event `context_usage` (types, adapter, replay, the
  `CanonicalEvent` mirror in `apps/web`).
- Migration: `sessions.context_used_tokens INTEGER`,
  `sessions.context_max_tokens INTEGER`, both nullable, both dialects,
  plus migration 030's rebuild shape and `PG_BASELINE_DDL` per the
  three-places rule in `CLAUDE.md`.
- `SessionSummary` gains the two counters.
- No new route; `/runners/instances` already serves the picker.

## Components

Copied from AI Elements with the repo's header and version note:
`loader`, `chain-of-thought`, `context`. `task` and `queue` stay out
(nothing here needs them). The `Context` copy takes its numbers from
props only; the `tokenlens` cost estimate and its dependency are
stripped like the `ai` import was.

## Phases

1. **Column, header, left column, palette**: the 80 % / 768 px column,
   the header reduced to name · chip · actions, the draft chip "Nový",
   the unsynced overview link, the left column's metrics, one active
   row and the CLI-session rule, the command palette on shadcn
   defaults. No data change.
2. **Composer rows**: row 1 model/effort, row 2 runner/instance/host,
   the draft's `runner`/`instance_id` written at creation and patchable
   while draft, promotion honouring them.
3. **Activity model**: the row derivation, the activity group with its
   summary sentence, the live row, the working row, markers reduced,
   delta coalescing. `chain-of-thought` and `loader` copied.
4. **Context**: the `context_usage` event end to end, the two columns,
   the ring with its threshold behaviour. `context` copied.
5. **Přehled**: the counter strip, the row cap with the expand footer,
   threads only in Relace, the wider page. No data change; the payload
   already carries everything.

Each phase works in a team workspace and a personal workspace before it
closes (the draft creation and the patch have a central half in
`agent-router.ts` and `CentralSessionStore`; the event is device-side
only and travels through the existing log path).

## Testing

- Row derivation: fixtures of canonical events → rows, including a run
  with two answers (two groups), a failed call, a run that ends in
  error, a replay with a delta in flight.
- The summary sentence: counts per verb, single-call groups, failures.
- The working-row label state machine.
- Delta coalescing: N frames in one tick → one flush with the
  concatenated text; a `run_ended` flushes and clears.
- Adapter: `context_usage` from a fake `assistant` + `result` pair,
  `max_tokens` null before the first result.
- Sessions: a draft records the given runner/instance; a patch of them
  on a running session is 409; promotion prefers the draft's values.
- Left column reducers: exactly one active row for every combination of
  selected node and active thread; CLI sessions excluded.
- Layout, the ring and the live behaviour are macOS/visual, not the
  gate.

## Known gaps, accepted

- The summary sentence's verb table covers Claude's tool names; another
  runner's tools fall back to their own names until they are added.
- `max_tokens` is unknown until the first `result` of the process; the
  ring shows a bare count until then.
- The palette finds nodes only; actions such as "Nový uzel" or "Nový
  úkol v…" are a later group, not this revision.
- A permission-mode choice ("Full access" in t3code) is not offered;
  the `policy` column keeps its default and the `Confirmation` panel
  keeps asking per call.
