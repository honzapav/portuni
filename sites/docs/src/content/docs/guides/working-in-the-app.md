---
title: Working in the Desktop App
description: Daily-driver workflows in Portuni.app — graph navigation, the workspace layout, the task chat, and the settings surface.
---

This guide covers what you actually do in `Portuni.app` once it's installed. For installation and first-run setup, see [Desktop App](/clients/desktop-app/).

The app has four views, switched from the left sidebar:

- **Overview (Přehled)** — a read-only, workspace-wide dashboard. Default landing view.
- **Graph** — the Cytoscape force-directed visualisation.
- **Workspace (Práce)** — the node list on the left and, in the centre, the selected node's detail or its task chat. Where most daily work happens.
- **Settings** — workspaces, account, runners, sync, MCP server section, and actors management.

The currently selected node lives in the URL as `?node=<id>`, so deep-linking and copy-pasted URLs work across views.

## Overview (Přehled)

The default landing view: one aggregate, permission-filtered snapshot of the whole workspace (`GET /overview`), composed deterministically — no LLM involved. A strip of four counters on top — Čeká na mě, Běží, Vyžaduje pozornost, Nesynchronizováno — each a shortcut to the place it counts (Práce, Graf, the Nesynchronizováno dialog). Under it, four cards; each shows at most eight rows and a "Zobrazit všech N" link for the rest:

- **Relace** — your own inbox: running/suspended threads you started, ordered "Čeká na mě" (an open question) first, then running, then suspended. A thread is its owner's: `GET /overview` returns your threads and nobody else's, so the card and the counters above it never carry a teammate's work, whatever your scope. Sessions opened by hand from a CLI are not rows here; the card's footer says how many there are and how many run, and the node's Relace tab lists them. Plus a headless review queue: nodes a `headless` session reached only via search with no edge path (`session_scope.added_via = 'disconnected'`) — see [Scope Enforcement](/concepts/scope-enforcement/).
- **Vyžaduje pozornost** — processes in `at_risk`/`broken`, areas in `needs_attention`, projects with `health != on_track` (see [Lifecycle States](/concepts/lifecycle-states/#project-health)), plus pending access requests (visible to `manage` scope and above only) and stuck sync operations (`pending_file_ops` rows with a recorded `last_error` — the closest server-visible signal to a sync issue; true file-conflict state is computed on-device and is not aggregated server-side).
- **Poslední aktivita** — recent events and recent session writes (nodes added to a session's write scope), interleaved by timestamp.
- **Nové nody** — recently created nodes, human- and agent-created alike.

Every row is a link: clicking a node reference switches to Graph and selects it; clicking a session reference opens its node in Workspace and focuses that session. Nothing here is fetched automatically on an interval — use "Obnovit" to refresh.

## Graph view

The cytoscape view uses the `fcose` force-directed layout. Pan with the trackpad, zoom with pinch or scroll, click a node to focus it.

The sidebar carries four filter groups:

- **Type** — `organization`, `project`, `process`, `area`, `principle`
- **Status** — `active`, `completed`, `archived` (archived is hidden by default)
- **Relation** — `belongs_to`, `related_to`, `applies`, `informed_by`
- **Organization** — toggle each org on/off

There's also a search box that filters by name (diacritics-folded). Hide everything except one org + one type to find a needle in a large graph.

When a node is selected, the detail pane on the right shows the same payload `portuni_get_node` returns — owner, responsibilities, data sources, tools, edges, recent events, files, local mirror path.

## Workspace view

```
┌──────────────┬──────────────────────────────┬──────────────┐
│ Node list    │  Task chat                   │ Node detail  │
│ (300 px)     │  (the node's open session)   │ (collapsible)│
│              │                              │              │
│ Sessions     │  — or, with no session, the  │              │
│ under each   │    node detail centre-stage  │              │
│ node, [+]    │    and no right column       │              │
└──────────────┴──────────────────────────────┴──────────────┘
```

- **Sidebar header** (every tab) — the workspace switcher under the brand, the Přehled / Graf / Práce toggle, "Hledat uzel…" (also `⌘K` / `Ctrl+K`) opening a command palette that filters nodes by name, description and type (a longer result list is grouped by node type — Organizace, Oblast, Projekt, Proces, Princip — a short one shows the type beside each name; ↑↓ / Enter / Esc hints sit in the footer), and "Nový uzel". The block is identical on every tab; in Graf a pick selects the node in the graph, in Práce it opens the node.
- **Node list** (left, "Otevřené") — two arrangements, switched by the Uzly | Stav toggle (remembered per workspace). **Uzly**: every open node in the order you opened them, with a node-type dot and at most one activity dot (waiting on an answer or running, from live `session_state` frames — a suspended or new thread shows none); its threads (including an empty, just-opened draft — your own drafts follow you into another window of the same account as soon as that window refreshes the node's threads; nobody else ever sees them) sit as sub-rows under the node name, the state in the tooltip — click one to jump straight to the chat, double-click to rename inline, and the `×` revealed on hover closes it (a draft is deleted outright; anything else asks first). Sessions opened by hand from a CLI are not threads; they stay on the node's Relace tab. Exactly one row is marked: the thread the centre column is showing, or, when it shows the node itself, the node. A thread started anywhere else — the detail pane's "Nový úkol", the Relace tab's "Navázat", another window — appears here as soon as its first `session_state` frame arrives, without reopening the node. Hovering a node itself shows `+` (opens a new, empty thread on that node — the same one-click action as the detail pane's "Nový úkol") and `×` (close the node — its sessions keep running on the sidecar). **Stav**: tasks only, grouped Vyžadují pozornost / Pracují / Pozastavené / Nové / Hotové, each with its node's name underneath; a new, running or suspended task has the same hover `×` as in Uzly.
- **Centre** — [the task chat](#task-chat-práce) when the selected node has an open (running/suspended/draft) session; otherwise the same `DetailPane` the graph view uses, in "embedded" mode.
- **Node detail** (right) — shown only while a chat occupies the centre, so the node stays visible next to its thread. The chevron at the top collapses it; the state persists in `localStorage` under `portuni:workspace.detailVisible`. A file opened from the Files tab replaces the detail with the editor in the same column.

Tasks run in the sidecar, not in this window: closing the window or the app never stops a run.

## Detail pane interactions

The detail pane on the right is editable in both Graph and Workspace views:

- **Identity row** (under the name) — the node id (click to copy) and, for every node but an organization, either the local mirror's path (left-truncated so the leaf folder stays readable, full path in the tooltip, click to copy) with a Finder button next to it, or — when this device has no mirror for the node yet — a button to create one. A remote-folder action follows either way: a Google Drive icon (or a generic link icon for a non-Drive remote) to copy its sharing link, plus a button to open it. There is no lifecycle/status badge here any more; project health still shows in its own place (see [Lifecycle States](/concepts/lifecycle-states/#project-health)).
- **Edit fields** — name, description and goal have their own `Pencil` toggle and commit on `Save`; lifecycle state and owner save immediately on selection.
- **Sharing (Sdílení)** — the visibility selector (Všichni / Soukromé / Skupina). A node that inherits a group ACL from its organization (or nearest restricted ancestor) shows a single read-only summary ("Přebírá sdílení z ...", the effective mode, the inherited recipients) with one action, "Nastavit vlastní sdílení pro tento uzel"; that opens a card prefilled from the inherited list, and nothing is sent to the server until "Uložit" ("Zrušit" discards it). Once a node has its own list — its own override, or a group set directly on a node with no restricted ancestor — the same card autosaves every change immediately, with a brief "Uloženo" readout, plus a "Zrušit vlastní sdílení a přebírat z organizace" action to drop the override. The two destructive cases — switching away from a group with existing grants, or removing its last recipient — ask for an inline confirmation first. A group with no recipients yet is the only unsaved autosave state; it persists once the first recipient is added.
- **Responsibilities** — add, edit, reorder (drag), delete; assign actors per row.
- **Data sources & tools** — add/remove with name + optional URL.
- **Edges** — outgoing and incoming, with a `→` / `←` indicator. Click an edge target to navigate to it (updates `?node=`).
- **Files** — list of tracked files with `remote_path` and the derived `local_path` for this device, plus a sync button (team workspaces only — a personal workspace has no remote at all, see [Files: the two sync planes](/concepts/data-modes/)) that mounts as soon as the node has a mirror, even with nothing tracked yet. It's never disabled: with something to push/pull it reads "Synchronizovat (N…)"; once nothing is locally pending it reads "Zkontrolovat remote" instead of claiming the node is done — a run's remote sweep is the only way to notice a file that showed up on Drive out of band, so a freshly created, still-empty mirror needs the same button as a busy one. Open in Finder, copy path, or delete (confirm-first). The tree groups the files under three sections — `wip` („rozpracované“), `outputs` („výstupy“) and `resources` („podklady“). A section is a group heading, not a folder: it shows the count and its one-word description, carries the sync dot of everything inside it, collapses with its chevron and has no actions of its own — it cannot be renamed or moved. Folders under a section are ordinary rows in the same face and size as the file rows (chevron, folder icon, name, count, sync dot, and a hover action strip with „Přejmenovat" and „Nová podsložka" at the right), with a guide line down the left of their children; a top-level folder outside the three sections renders as such a row too. Opening a file swaps the editor into this same right column in place of the node detail — a "← zpět" button returns to it. Every file but a Showtime deck offers a Náhled | Editace toggle: Markdown and HTML open in Náhled (rendered preview) by default, anything else opens in Editace (source editor); switch either way any time. "Uložit" (Cmd/Ctrl+S) shows up only in Editace, and only once the file is dirty, sitting left of the toggle so its appearing/disappearing never shifts the other buttons. A ⤢ next to it expands the editor to a fullscreen overlay with the same controls (mode toggle, Uložit, plus ⤡ to collapse back and × to close). A `.showtime` deck (a [Showtime](https://github.com/honzapav/showtime) bundle) opens as the rendered preview the bundle carries once the Showtime integration is on (Settings → Integrace); the preview is read-only and offers „Otevřít v Showtime" when Showtime.app is installed. That button hands Showtime the deck **and** the node: the agent Showtime starts beside the deck connects to the Portuni MCP server with this node as its home (so it appears under the node's Relace like a task started from Portuni) and gets the node's mirror as a second working directory. The bearer never travels in the link; Portuni mints a one-time code and Showtime exchanges it over loopback. A refused handoff shows its reason in the preview bar and opens nothing; a Showtime without the `showtime://` deep link asks you to update Showtime. With the integration on and Showtime.app found, „+ Nový soubor" is a split button: the chevron offers „Nový soubor" and „Nová prezentace". The latter hands Showtime the node's `wip/` and a one-time code (`showtime://new`); Showtime's New Deck screen opens with that folder fixed and the node named, you pick the design system, template and name there, and the bundle it writes shows up under Files through the mirror watcher — the agent beside it is a session on this node, as for „Otevřít v Showtime". Disabled (with the reason) on a node without a mirror on this device: Showtime writes to disk, so there is nowhere to put the deck. Which agent runs beside the deck is Showtime's own setting, not Portuni's agent preset. A bundle saved by a Showtime older than the bundled preview says so instead of rendering.
- **Events** — recent timeline; resolve / supersede inline.
- **Relace (Sessions)** — persistent sessions anchored to this node (`GET /nodes/:id/sessions`), newest-active first: state (running/suspended/closed/archived, archived hidden behind a "Zobrazit archivované" filter), last activity, CLI + instance (CLI is read from the MCP handshake itself, not a header — populated for Claude Code, Codex and Mistral Vibe alike), the host that ran it (the machine whose sidecar started the latest run — its label on the machine you are asking from, its id when the task ran on a teammate's device; omitted when no run claimed one), the `runner` when the session was started as a task, `waiting_since` when its run is blocked on a question, and write count (size of the session's write scope, which always includes the session's own home node — a session that only ever wrote there still reports 1, not 0). Name defaults to `<node> · <date> <time>` (the time component keeps two same-day sessions on the same node distinguishable) and is enriched from the handoff's title at suspend, but is always renamable inline. A `sessions` row is only ever created once a connection completes its MCP handshake — a client's protocol probe, an aborted connection, or any other non-`initialize` first request never leaves a row behind. A `running` row is never simply dropped: a run that ends for any reason other than Uzavřít — `PORTUNI_RUN_IDLE_MS` (default 30 min) of inactivity with no turn in flight, a provider limit (the runner's own spend/rate limit, whose message lands in the transcript as a provider error), an error, or a startup sweep finding a row from a process that no longer exists (crash, restart) — *suspends* it instead, with a mechanical summary **the device** writes from its own copy of the event log (last messages, files changed, any open question, the write set) — the transcript is on the machine that ran the thread, so that machine is the only one that can write the summary; the central server never writes one — `closed` is reached only by explicitly clicking Uzavřít or by the auto-archive sweep of old closed sessions. The thread's own MCP connection closing is not one of those reasons: an agent that spends half an hour on files without calling a single Portuni tool — or whose connection simply drops — keeps its thread, its run and its transcript, and its next connection binds back to the same thread. A dropped connection does still suspend a **hand-opened CLI**, whose session was that connection and nothing else. Such a row shows "pozastaveno serverem" with the reason (odpojení, nečinnost, restart serveru, proces osiřel po restartu) so it reads differently from a handoff a hand-opened CLI's own agent wrote on purpose via `portuni_session_suspend`. A suspended row shows whether the underlying CLI conversation is still resumable or will fall back to the summary, and links to the handoff file when one exists (or, when this device has no local mirror for the node, the handoff text is still resumable from — it was simply never written to a file here) — this is informational only now: there is no separate resume action, sending the next message into the thread is what resumes it, `--resume` on the last run when still valid, from the summary otherwise. Each row's status dot doubles as a chip (Běží / Čeká na mě / Pozastaveno / Hotovo / Archiv, "Čeká na mě" overriding "Běží" while a question is open). A row names the thread and never quotes it: what was said is content, and content is not on the central server to be listed. The tab lists **your** threads on this node and nobody else's — a thread is its owner's, so seeing the node (or holding `manage`) says nothing about the work other people started on it, and there is no owner column to show. "Otevřít chat" jumps to [the task chat](#task-chat-práce); a closed row shows a single "Navázat" button — `POST /sessions/:id/continue`, which starts a fresh, running session on the same node seeded with this one's summary and switches Práce to it. Every action here is offered on state alone, because every row is yours. Above the rows the tab lists the node's **předání k navázání**: every `wip/sessions/<id>-handoff.md` file tracked on the node, whoever wrote it — including one that arrived here by sync from another machine. Such a file names the thread it came from (the thread's name, its device and its last activity when that thread is one of yours; otherwise just the file name, because a thread is its owner's and a file says nothing about who may see the record), opens in the editor like any other file, and offers **Navázat na handoff**: `POST /sessions` with the file's path, which starts a new thread here from what the file says and switches Práce to it. The file has to be on this device already — a handoff that has not synced here yet is refused („Soubor handoffu ještě není na tomto zařízení") and nothing is created.

**Uspořádání souborů v panelu Files.** Soubory se mezi složkami a sekcemi
uzlu přetahují myší, ale žádný tah se neprovede hned: skládá se **plán**,
který se použije až tlačítkem „Použít". Táhnout jde zaregistrovaný soubor
uvnitř sekcí `wip`, `outputs` a `resources` a celá složka (přetáhne se s ní
každý soubor uvnitř). Řádek, který táhnout nejde, říká v titulku proč —
soubor ještě není zaregistrovaný (zaregistruje ho hlídač během chvíle),
leží mimo tři sekce, nebo uzel nemá na tomhle počítači mirror. Cílem je
složka, sekce, nebo řádek souboru (pak se míří do složky, ve které soubor
leží); sbalená složka se po chvíli držení kurzoru sama rozbalí. Cíl, kde už
soubor téhož jména je, a složka přetažená sama do sebe se odmítnou hned při
puštění, s důvodem v titulku.

Naplánovaný soubor má u levého okraje řádku accentový proužek, přeškrtnutou
původní složku a štítek „PŘESUN"; nad stromem se objeví lišta „N změn čeká
na použití" s tlačítky „Zahodit" a „Použít". Lišta je nahoře, kdykoli plán
něco drží — mezi změny se počítá naplánovaný přesun i nová (virtuální)
složka, takže i plán, ve kterém je jen nová složka, jde „Zahodit".
„Zahodit" plán zahodí celý, i s novými složkami, a nikde se nic nestane.
„Použít" projde naplánované přesuny po jednom — v plánu bez jediného
přesunu není co použít a tlačítko je zakázané: soubor, který už je na
remote, se na Disku jen přejmenuje (obsah se znovu nenahrává), soubor,
který se ještě nikdy nepushoval, změní jen svůj záznam a kopii v mirroru
a zůstává ve stavu `push` na nové cestě. Když některý přesun selže, dávka
se zastaví — hotové zůstává hotové, chybný řádek ukáže důvod a zbytek změn
zůstane v plánu pro „Použít znovu". Plán patří uzlu na tomhle počítači,
přežije odchod z uzlu i restart aplikace a nikam se neodesílá.

**Složky v panelu Files.** Vedle „Nový soubor" je „Nová složka": otevře
formulář s cestou předvyplněnou sekcí (`wip/`), Enter nebo „Vytvořit"
složku založí, Escape nebo „Zrušit" formulář zavře. Neplatná cesta (mimo tři
sekce, s `..`, s prázdným segmentem nebo s mezerou na kraji) i cesta, kterou
už má jiná složka — skutečná nebo naplánovaná — se odmítne s důvodem pod
formulářem. Na uzlu bez mirroru na tomhle počítači je tlačítko zakázané,
s důvodem v titulku. Řádek složky má po najetí stejný formulář pod akcí
„Nová podsložka" (cesta je předvyplněná tou složkou) a akci „Přejmenovat":
inline vstup s aktuálním názvem, Enter přejmenování naplánuje, Escape ho
zruší, odmítnutí se ukáže pod řádkem. Sekce `wip`, `outputs` a `resources`
takové akce nemají — jsou to nadpisy skupin, ne složky.

Nová složka je do „Použít" jen **virtuální**: řádek ve stromu s přerušovanou
ikonou, nulovým počtem a štítkem „nová", nikde na disku ani na remote nic
nevzniklo. Skutečnou se stane až tím, že v ní po použití plánu skončí první
soubor; když z ní před použitím poslední naplánovaný soubor zase odejde,
zmizí i z plánu. Přejmenovat skutečnou složku znamená naplánovat přesun
každého souboru uvnitř (složka sama žádný záznam nemá) — všechny dostanou
štítek „PŘESUN", složka se ve stromu ukáže pod novým názvem a stará zmizí;
u virtuální složky se jen přepíše její řádek. Složku, ve které leží
nezaregistrovaný soubor, přejmenovat nejde, aby nezůstala přesunutá jen
zpola; hlídač soubor zaregistruje během chvíle.

The action bar below the pane (non-organization nodes) is "Nový úkol" — see [Task chat (Práce)](#task-chat-práce).

Every mutating action calls back through `onMutate` which refetches the graph and the node detail, so the rest of the UI stays consistent.

### Task chat (Práce)

"Nový úkol" on a node's detail pane (or the "+" on its sub-row in the
left column) opens a thread immediately — one click, no dialog: `POST
/sessions` with just `{ node_id }` creates a `draft` session (a name,
a node, an owner, nothing else yet) and Práce's centre column switches to
`SessionChat` for it right away, composer focused. There is no runner or
instance to pick up front. The first message you send
(`POST /sessions/:id/messages`) is what promotes the draft to `running`
and starts its first run: the server picks the first installed &&
logged-in runner (`GET /runners`) and, when the node's organization has a
default instance registered for it (Settings → Runnery), that instance —
the same rule a manual picker used to apply, just resolved server-side
instead of asked up front. The thread's name comes from that same first
message (first line, trimmed, cut at ~60 characters), not from the node
and date the way an ownerless chat session still defaults to. A draft
closed before a first message is sent is deleted outright, with no
question, from any of the places that close a thread: the `×` in either
sidebar arrangement, Uzavřít in the chat header, or Uzavřít on its row in
the node's Relace tab; and one left
open longer than 24 hours is pruned by the same server sweep that resolves
a `running` row orphaned by a crashed process.

Starting a run takes a moment — the runner's process has to come up — and
anything you do in that moment waits for it rather than racing it. A second
message sent while the thread is still starting is delivered to the run
that start produces, as an ordinary next message; the same holds for a
message sent into a thread you have just woken up by writing into it.
**Uzavřít** and **Předat** wait for the start too and then act on the run
it produced, so a thread can never end up with two runners' processes on
it, and closing one never leaves a process behind on a closed thread.

A message written at the moment a run is ending is not lost either. A run
can end while you are typing — the runner hit its spend or rate limit, it
errored, the thread had been idle long enough to be suspended, or you
pressed Předat. The message still lands in the transcript, and Portuni
delivers it: it waits for that run to finish ending and for the thread to
be suspended, then wakes the thread with that message as the
first message of the next run. You see it once, the agent answers it, and
nothing has to be typed again.

When the model's API fails (the model is unavailable, overloaded, the
prompt is too long, or a limit was hit), the error shows in the chat once,
as an error and never also as the agent's reply, and the context ring keeps
the last size the conversation really had.

The inactivity timeout never catches a thread you have just gone back to.
It looks over all your live threads at once, but suspending one takes a
few seconds, and each remaining thread is checked again the moment before
it is suspended: one you wrote into, answered a question in, or that the
agent started working in again in the meantime keeps running and waits
for the next round.

Every thread you have open in the window stays live while you look at
another one: each one keeps its own chat, and switching is only a change
of which one is on screen. You come back to the same scroll position in
the transcript, the same half-written message in the composer, and a
transcript that kept streaming while you were away — nothing is fetched
or replayed again. A thread's chat is dropped only when you close the
thread or close its node in the left column.

`SessionChat`'s header shows the session name, a status chip derived from
`state` and `waiting_since` ("Běží", "Čeká na mě" when a question is
open, "Pozastaveno", "Uzavřeno", "Archivováno"), and the runner/instance.
Stopping a turn is not a header action any more: the composer's own
submit button doubles as a stop control (a stop square) while a turn is
in flight, and Esc does the same — both just call `interrupt()`, which
cancels whatever the model is doing right now without ending the run, so
you can keep typing straight after. A stop while the agent waits on your
approval closes that question too: the thread stops waiting on you and the
agent's next question shows straight away. Once a turn has stopped, nothing
in the transcript still looks like it is working, and a half-written answer
is dropped rather than prepended to the next one. A message you write while the agent
is still working queues behind the turn in flight and counts as work of
its own: the stop control, the working row and the idle countdown all go
by how many of the messages you sent are still unanswered, not by the
first "turn finished" that comes back. Once the agent has answered
everything you sent, the run stays alive only to take your next message:
the button is a plain send again and nothing is shown as working. The remaining header actions are
**Předat** (see below), **Pokračovat v nové session** (offered any time
there's an open thread — `POST /sessions/:id/continue`, which closes this
session, writes its summary to `wip/sessions/<id>-handoff.md` in the node's
mirror when this device has one, seeds a new one with that summary, and
switches Práce to it) and
**Uzavřít**, which asks for confirmation first (the only irreversible
action here) before doing the same close `interrupt` never does. All
follow the access table below; a refused action surfaces the server's own
error, there is no client-side prediction of who may do what.

Where a thread lives: the **central server holds the record** — that the
thread exists, on which node, whose it is, its state, runner, model, its
runs and its write scope — and the **device that ran it holds the
content**: the first message, every event of the transcript, the inline
handoff summary. Content is never sent to the central server, so nothing
you say in a thread is stored outside the machine you said it on, and
there is **no backup of transcripts**: losing a device's database loses
its conversations, while the records on the central server and the handoff
files synced into the nodes remain.

The consequence you see: open one of your threads on a **second device**
and the header, the state and the actions are all there, but the
conversation is not. The chat says **„Transkript je na zařízení X"** with
the name of the machine that has it, the composer is disabled, and the way
to pick the work up here is the round trip below — **Předat** on X, then
**Navázat na handoff** here. Předat itself is hidden on such a thread: the
summary is written from the transcript, and this machine holds none of it.

**Předat** hands the thread to another machine. It is offered on a running
or a suspended thread, in the chat header and on the thread's row in the
Práce sidebar. On a running thread it ends the turn and the run, and the
device writes the thread's summary to `wip/sessions/<id>-handoff.md` in the
node's mirror — a tracked file of the node like any other, so the next sync
carries it — and the thread goes to "Pozastaveno"; the chat then names the
file it wrote. Pressing it again on the same thread changes nothing and
answers the same path. A thread that was suspended on its own (idle, an
error or a limit, the app quitting or restarting) has no file: Portuni
writes a handoff file only when you ask for one, with Předat or
Pokračovat v nové session, and the chat shows „Shrnutí uloženo" only
then. On such a suspended thread Předat writes the file now, from the
transcript this device holds. Předat refuses, and says why, before
it touches anything: on a draft (nothing to summarise) or a closed thread,
on a node that has no mirror on this device (there is nowhere to write the
file; the running thread keeps running), on a thread whose run is live on
another device, and on a thread whose transcript is on another device —
those two name the device, and that is where to press it. The transcript
never travels — only the summary file does — so the other machine
continues from what the file says, not from the conversation.

**Navázat na handoff** is how the other machine picks it up. The node's
Relace tab there lists the node's handoff files as soon as the sync has
carried them; choosing one starts a **new** thread on that machine — a new
name (the summary's own title), this machine's runner and device, and a
first run that reads the summary as its orientation. Nothing is imported
from the old thread: its transcript stays on the machine that wrote it, its
record keeps its own state, and the new thread's conversation starts empty.
So the round trip is: **Předat** here, sync, **Navázat na handoff** there —
and the same in reverse when the work comes back.

The event list renders the session's canonical log, delivered entirely
over the live WebSocket below (a subscribe replays the persisted log,
then streams what follows): user and assistant messages as chat bubbles,
reasoning as a collapsible aside, `tool_call` collapsed from its `started`
and `completed`/`failed` pair into one row showing the title (click it to
expand the input summary and output excerpt), `file_change` linking into
the Files tab, and `compaction`, `handoff`, `state_changed` and
`run_ended` as centered system markers. Both assistant text and reasoning
stream in from `delta` frames — a `channel: "text"` delta builds up
towards the next `assistant_message` event, a `channel: "reasoning"` one
towards the next `reasoning` event — and each buffer clears once its own
matching event lands; the reasoning aside stays open while its deltas are
still arriving and collapses once the batched event replaces it. A
question panel appears above the composer while
`waiting_since` is set — option buttons for an approval, a text field for
free-form input; an agent's question with a choice (AskUserQuestion) shows
each question's options as buttons above that field, one question under
another when it asks several. A single one-choice question answers on the
click; otherwise pick an option for each (a multi-select question takes
several) and send with Odeslat, where whatever you type answers the
questions you left without a pick. An empty field sends nothing, and the
answer goes out once however often you click — also for a confirmation dialog an MCP server raises
mid-tool-call, such as Portuni's scope expansion or write access (Ano
accepts, Ne declines; a dialog asking for more than a yes/no is declined).
The run uses only its own Portuni connection: a claude.ai connector its
profile inherits that points at this Portuni's server (recognised by its
URL, whatever it is named) is switched off for the run, because that
one's dialogs would go to claude.ai. The composer itself disables while closed or
archived, or when you are not the session's owner (messages and answers
are owner-only; anyone who can see the node can read along). Unlike
before, it does **not** disable while suspended: a suspended thread shows
a dismissible notice above the composer instead ("the process was ended;
the next message replays the whole conversation into the model") and
stays fully usable — sending is exactly what resumes it, `--resume` on
the last run's conversation while that's still valid, otherwise from a
summary: the handoff file Předat wrote, or else one built from this
device's transcript at that moment; the server decides, there is no mode
picker any more.
Dismissing the notice only hides that one instance; the next time the
thread ends up here (a new run starts, then also ends other than by
Uzavřít) shows a fresh one. The header names the runner, instance and
host — the machine whose sidecar last ran the thread, shown by its label
when Portuni can name it and by its id otherwise, and left out entirely for
a session no run ever claimed — plus the thread's own model/reasoning-effort
override when it has one (see
[Runners: model and reasoning effort](/reference/runners/#model-and-reasoning-effort)).
The composer has two rows under the text. The first holds the model
selector (`GET /runners/:runner/models` — documented aliases until this
device has run a task, the real list after) and, only when the chosen
model supports it, a reasoning-effort selector labelled as applying from
the next run, not the current one. The second, dimmer row says where the
thread runs: runner and instance, chosen from a list of every logged-in
runner and its instances while the thread is still new (the organisation's
default is preselected and marked "(výchozí)"; the choice is fixed once
the first message goes out), and the host. The header shows the name, the
state and, once the run has reported, a context ring with the share of the
model's window in use (the main agent's context only: a subagent the
agent starts has a window of its own and never moves the ring); from 80 % it turns amber and "Pokračovat v nové
session" becomes the primary button. While the agent works on a turn,
the transcript always shows what is happening: streaming text, the tool
that is running, or a "Spouštím… / Přemýšlím… / Pokračuji…" line with a
counter; between turns it shows nothing. A subagent's own messages and
tools stay out of the transcript; the agent's call that started it shows as
one tool call. Tool calls and reasoning fold into one line per turn ("Přečteno
3 soubory · 2 příkazy"); expand it to see each call. While a run
is live the header also shows the restart indicator (run age, write/read-set
size, scope expansions since the run started) as plain information — no
action of its own; **Pokračovat v nové session** above is what carries the
work into a fresh context when it's needed.

A session can also be driven directly over REST, ahead of or instead of
the chat UI above: the same `POST /sessions` plus `POST
/sessions/:id/messages` (send a chat message — starts a fresh run first
if the last one ended other than by Uzavřít, `--resume` or from the
summary, the server's own choice), `POST
/sessions/:id/questions/:request_id` (answer an open question), `POST
/sessions/:id/interrupt` (cancels the current turn only — the run stays
live), `POST /sessions/:id/continue` (closes this session, writes its
summary as its handoff file when the node has a mirror here, seeds a new
one on the same node from it, returns `{ session, run }` for the new one), `POST /sessions/:id/close`, `GET /sessions/:id/signals`,
`GET /sessions/:id/scope` (the session's read and write set by node id,
the same two sets the written summary lists), and
`GET /sessions/:id/events?after&limit` for the canonical event log the
chat view above renders from. `POST /sessions/:id/suspend` and `POST
/sessions/:id/resume` are gone — there is no separate suspend handshake
any more, and resuming is just sending a message.

Who may call what follows one access table across every task route: **read**
(`GET /sessions/:id/events`) is anyone who can see the session's anchor
node; **message** (send a message, answer a question, rename) and
**resume** (`continue`) are the owner only; **stop** (interrupt/close) is
the owner or anyone with `manage` scope. A session anchored to a node you
cannot see reads as a plain 404, same as the node itself being invisible;
a node-less session (a plain interactive chat, not a task) is 404 for
everyone but the owner. An interrupt/close by someone other than
the owner is recorded in the event log with who did it.

A task's own MCP connection (the one the runner spawns to talk back to
Portuni) binds to the session `POST /sessions` already created instead of
minting a second row — this is why a task's Relace row appears the moment
you start it, not only once its first tool call lands.
It authenticates with the same token the sidecar's front door checks
(`PORTUNI_AUTH_TOKEN`, which the app gives every workspace's sidecar), in a
personal and a team workspace alike, so the chat has Portuni's tools
(`mcp__portuni__*`) from its first turn. A sidecar without that token
refuses to start the run with a clear error instead of connecting with an
empty bearer.

### Live channel: `GET /sessions/ws`

The REST task routes above are for scripts and tests; the desktop window
itself talks to one WebSocket, `GET /sessions/ws` (upgrade, same bearer/
JWT auth as every other route — an upgrade that fails auth is refused with
401 and the socket is closed; a plain `GET` without an `Upgrade` header
answers 426). The socket is mounted in both kinds of workspace: on the standalone
/ local sidecar over its own database, and on the sync agent
over the same runtime its REST task routes drive, so the window's
connection always targets its own sidecar. Opening the socket needs
`read` scope; `message`, `answer`, `interrupt`, `continue` and `close`
frames need `write` scope (`FORBIDDEN` otherwise) and, in the packaged
app, an upgrade that carried the webview-proxy proof described above
(`WEBVIEW_PROXY_REQUIRED` otherwise) — a `subscribe` works either way. Every frame is JSON `{ id?, type, payload }`; a frame
carrying `id` gets `{ id, type: "reply", payload }` on success or
`{ id, type: "error", payload: { code, message } }` on failure — the same
codes the REST routes answer with (`SESSION_NOT_FOUND`, `NO_LIVE_RUN`, `NO_PENDING_QUESTION`, …). A refused
action is always an error frame, never a closed socket.

Client → server: `subscribe { session_id, after }` (replays the persisted
event log after `after`, then streams live), `unsubscribe { session_id }`,
`message { session_id, text }`, `answer { session_id, request_id, decision }`,
`interrupt | close { session_id }`, `continue { session_id }` (replies with
`{ session, run }` for the new session so the client can switch to it
without a second round trip) — each mapped to the same runtime call and
access tier the REST route uses.

Server → client: `event { session_id, event }` — a persisted canonical
event, carrying the `seq` the store assigned it; `events { session_id,
events }` — a page of up to 200 of them, in `seq` order, which is how a
subscribe replays the log; `delta { session_id,
run_id, channel, text }` — streamed text, never persisted, never replayed,
`channel` one of `"text" | "reasoning"` saying which persisted event this
delta is a live preview of; and
`session_states { sessions: [...] }` — one frame the moment you connect,
listing every running or suspended session you can see (newest activity
first, at most 500); and `session_state { session_id, state, waiting_since,
node_id }` — one session, sent on every `state_changed`, `question` or
`run_ended` anywhere, with no subscription needed. A thread the runtime
suspends on its own (idle, an error or limit, the process ending) sends one
more `state_changed` once it is suspended, so the last frame always says
`suspended`. This is what lets the Relace tab, the Práce sidebar and Přehled
update live instead of polling. A frame for a node open in Práce also refetches that node's thread
list (`GET /nodes/:id/sessions`), which is how a thread started outside the sidebar shows up there;
the refetch is coalesced per node, so a burst of frames costs at most two round trips.

Reconnect rule: a client that drops and reconnects re-subscribes to each
session it cares about with the last `seq` it actually saw — nothing is
lost, because events are the durable record and deltas were always
disposable.

## Settings

Sections worth highlighting:

- **Theme** — light / dark; the choice persists in `localStorage` and is reapplied on launch.
- **MCP server** — shows the sidecar's URL (typically `http://localhost:4011/mcp`), port, and whether an auth token is set. The bearer token itself lives in macOS Keychain (Tauri-only); reveal it on demand or rotate with one click. The install buttons write the URL + token into `~/.claude.json`, `~/.codex/config.toml`, and `~/.vibe/config.toml` so external clients can talk to the app's sidecar without manual config editing.
- **Synchronizace** — informational: the server URL plus the remote watcher's and the mirror watcher's current state. See below.
- **Integrace → Showtime** — off by default, stored in `localStorage` like the other settings. On, a `.showtime` deck in a node's files opens as a rendered preview (the `preview.html` Showtime packs into the bundle at every save; `GET /nodes/:id/file` returns that entry as `text/html` for a `.showtime` path) and the preview offers „Otevřít v Showtime" when Showtime.app is installed — the section shows whether Showtime.app was found (`/Applications` or `~/Applications`) and what the button hands over: the node's Portuni connection for the agent and the node's mirror as a working directory. It also puts „Nová prezentace" behind „+ Nový soubor" on the Files tab (see Files above). Off, the bundle is a binary file like any other.

## Synchronizace

Collaboration in Portuni is team workspace — a **local** (single-machine)
workspace has no remote to connect at all, so Settings → Synchronizace has
nothing to configure there: stored files always sit in the local mirror
only, and a node's Soubory pane shows a "soubory se ukládají jen lokálně"
banner. A **central** workspace shows the server URL that manages file sync
— nothing to configure client-side either. Configuring the actual Google
Drive remote (a Service Account on the central server) is an MCP-only,
one-time admin task; see [Setting Up Remotes](/guides/setting-up-remotes/).

The tab does report one live thing, though: a **remote watcher** line per
remote. „Sledován" means the central server is polling Drive's change feed
about once a minute, so a file a teammate adds, renames or deletes on Drive
shows up as a pending pull within a minute instead of waiting for the next
full check. A line reading „sledování hlásí chybu" (optionally with „další
pokus za …", the watcher's `backoff_until`) means that polling is currently
failing — Drive changes are **not** being applied live, and the fallback is
the periodic full sweep every 6 hours. „Sledován, … ; pravidelná kontrola
hlásí chybu" is the other way round: live changes still land, but the
periodic full sweep failed on some node (its error is quoted) and is
waiting for its own „další pokus za …" — files that only the sweep can pick
up wait with it. „Bez sledování změn, jen pravidelná kontrola" is not an
error: that backend has no change feed at all, so the 6-hour sweep is all
there is for it. Mirror-watcher errors (the local half — the disk watcher
on this device) are listed in the same tab.

## Recommended daily flow

1. Open `Portuni.app`. Workspace view.
2. Pick the node you're working on from the left list (or jump from the graph view).
3. "Nový úkol": opens an empty thread right away with the organisation's default runner and instance preselected in the composer; change them there if you want to. Write the first message and the run starts.
4. Work. The agent uses Portuni MCP tools (`get_node`, `get_context`, `log`, `store`, etc.) via the embedded sidecar — same surface external clients see.
5. When done, `portuni_status` (or rely on the agent to call it) before ending the session so disk / DB / remote stay consistent — this rule is enforced by the server-level instructions.

## See also

- [Desktop App](/clients/desktop-app/) — install, first run, update flow
- [Symbiotic Workflows](/guides/symbiotic-workflows/) — how the agent and the human share the graph
- [Local Mirrors](/concepts/mirrors/) — the per-device mirror model the workspace view surfaces
