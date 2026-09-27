---
title: Thread Lifecycle
description: The five states of a thread, what moves it between them, and which button does what.
---

A thread (a `sessions` row) is always in one of five states. You move it with a handful of buttons; the server moves it on its own only to suspend, archive or prune it. Full UI detail is in [Working in the Desktop App](/guides/working-in-the-app/#task-chat); the mechanism is in [`docs/architecture/sessions-and-runner.md`](https://github.com/honzapav/portuni/blob/main/docs/architecture/sessions-and-runner.md).

```
draft      ── first message ─────────────────────► running
draft      ── Close, ×, 24 h sweep ──────────────► deleted
running    ── run ends, idle, crash, Hand off ───► suspended
running    ── Close, ×, Continue in a new thread ► closed
suspended  ── write ─────────────────────────────► running
suspended  ── Close, ×, Continue in a new thread ► closed
closed     ── write ─────────────────────────────► running
closed     ── 30 days ───────────────────────────► archived
```

## States

| State | Label (row / chat header) | Composer | Where it shows |
|---|---|---|---|
| `draft` | New / New | Open. The first message starts the thread; runner and instance can be changed only here. | Only in the window that created it, and in other windows of the same account after they refresh the node's threads. Nobody else sees it. |
| `running` | Running / Running; **Waiting on me** while a question is open | Open. During a turn, Stop (Esc) replaces Send. | Work sidebar, Overview, node's Threads tab. |
| `suspended` | Suspended / Suspended | Open. Writing resumes the thread. | Work sidebar, Overview, node's Threads tab. |
| `closed` | Done / Closed | Open. Writing reopens the thread. | Node's Threads tab only. |
| `archived` | Archived / Archived | None ("This thread is archived."). | Node's Threads tab, behind "Show archived". |

`archived` is the only state with no way back.

## What you do

| Action | Where | Available in | Effect | Transition |
|---|---|---|---|---|
| New task | Detail pane, `+` on a node in the Work sidebar | always | Creates an empty thread with the organisation's default runner and instance, composer focused. | → `draft` |
| Send (Enter) | Composer | `draft`, `running`, `suspended`, `closed` | `draft`: names the thread from the message and starts the first run. `running`: delivers the message to the live run. `suspended`/`closed`: resumes the CLI conversation (`--resume`) while it exists, otherwise starts from a summary built from this device's transcript, or from the handoff file when one was written. | `draft`/`suspended`/`closed` → `running` |
| Stop (Esc) | Composer, during a turn | `running` | Cancels the current turn only. The run stays, the next message is an ordinary one. | none |
| Close thread | Chat header, Close on a Threads-tab row | `draft`, `running`, `suspended` | `draft`: deleted. Otherwise ends the live run. No dialog, no summary. | `draft` → deleted; → `closed` |
| `×` on a thread | Work sidebar, both arrangements | `draft`, `running`, `suspended` | Same as Close thread. | same as Close thread |
| `×` on a node | Work sidebar | always | Removes the node from the open list. Its threads keep running. | none |
| Continue in a new thread | Chat header (accent colour from 80 % of the context window) | `running`, `suspended` | Closes this thread and starts a new one on the same node whose agent gets a summary of this one. Writes `wip/sessions/<id>-handoff.md` when the node has a mirror here. | old → `closed`, new → `running` |
| Hand off to another device | Chat header | `running`, `suspended`, with a mirror of the node and the transcript on this device | Ends the run and writes `wip/sessions/<id>-handoff.md` for another machine to continue from. | `running` → `suspended` |
| Continue from handoff | Node's Threads tab, "Handoffs to continue from" | a handoff file synced to this device | Starts a new thread from the file. The source thread is untouched. | new → `running` |
| Rename | Chat header, double-click in the sidebar, Threads-tab row | all but `archived` | Saves the name; summaries no longer rename the thread. | none |

## What the server does on its own

| When | What | Transition |
|---|---|---|
| The run ends without Close thread: the agent finished, a provider error or limit, the process died | Suspends, writes no summary. | `running` → `suspended` |
| No activity for `PORTUNI_RUN_IDLE_MS` (default 30 min) and no turn in flight | Ends the run, suspends. | `running` → `suspended` |
| Startup finds a `running` row whose process is gone (crash, restart, lost host) | Ends the open run rows, suspends. | `running` → `suspended` |
| Startup finds a draft older than 24 hours | Deletes it. | `draft` → deleted |
| Startup of the process that owns the graph db finds a thread closed more than 30 days ago | Archives it. The row, runs, audit and handoff file stay. | `closed` → `archived` |

A thread's own MCP connection dropping never ends a thread the app drives: its row stays `running` and the agent's next connection binds back to it. A session opened by hand from a CLI is different: its connection is the session, so a drop suspends it.
