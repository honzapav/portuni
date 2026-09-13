# Showtime handoff: a new deck for a Portuni node

„Nová prezentace" on a node's Files tab starts a new Showtime deck inside the
node's mirror, with the node handed over the way „Otevřít v Showtime" hands
it over for an existing deck. Showtime creates the bundle — design system,
template and name are picked there, as for any new deck — and from the moment
the bundle exists it is the deck of that node: the agent beside it is a
Portuni session on the node, and the mirror watcher registers the file. Two
repositories change: `honzapav/portuni` (sender) and `honzapav/showtime`
(receiver).

Builds on the handoff for an existing deck
(`2026-09-02-showtime-handoff-design.md`), which listed this as out of scope.

## Rules

1. **The deck is created by Showtime, never by Portuni.** Portuni has no
   design system cache and renders no Marp; it only says where the deck goes
   and which node it belongs to. Design system, template and name are chosen
   in Showtime's New Deck screen, unchanged — the step is neither skipped nor
   duplicated in Portuni.
2. **The deck lands in `wip/` of the node's mirror.** No section choice, no
   directory picker: the New Deck screen shows the directory and does not let
   it be changed. A deck outside the mirror would not be the node's deck.
3. **A node needs a mirror on this device.** Showtime writes to disk, so a
   node without a mirror has nowhere to put the deck. The action is visible
   and disabled until the mirror exists.
4. **The node binds to the deck that screen creates, and only to it.**
   Closing the screen without creating drops the context. Nothing is
   remembered: a deck reopened from Finder or the recent list is a plain deck
   (rule 6 of the existing handoff).
5. **From creation on, it is the existing handoff.** Agent cwd is the deck's
   working directory, the mirror is a second working directory, the MCP
   server is connected with the node as home, the session appears under the
   node's Relace. Nothing new is learned.
6. **A failed exchange does not stop the deck.** The New Deck screen opens
   with the directory from the link, the agent starts without context, and
   the Agent tab says so — same as an `open` whose code went stale.
7. **A directory that is not the node's mirror gets no node.** When the
   exchange answers with the node's mirror and the link's directory does not
   lie under it, the context is dropped with a log line: a node is never
   attached to a deck that does not belong to it.
8. **Who the agent beside the deck is, Showtime decides.** Portuni's own
   agent preset (Claude / Codex / Gemini / …) governs Portuni's terminals
   only. Showtime starts its own provider; another provider than Claude Code
   gets the environment and no MCP config or `--add-dir`, as the existing
   handoff already states.
9. **Showtime without Portuni is unchanged.** ⌘N, Open, Finder, the recent
   list: none of them know about any of this.

## Flow

```
Portuni web           Portuni desktop (Rust)      Portuni sidecar        Showtime host          New Deck screen
    |  new_in_showtime      |                          |                      |                      |
    |  {node_id}            |                          |                      |                      |
    |---------------------->| POST /auth/handoff       |                      |                      |
    |                       | {node_id}                |                      |                      |
    |                       |------------------------->| mint code            |                      |
    |                       |<-------------------------| {code, mirror}       |                      |
    |                       | no mirror -> error       |                      |                      |
    |                       | open showtime://new?dir=<mirror>/wip&portuni=<base>&code=<code>        |
    |                       |------------------------------------------------>|                      |
    |                       |                          | exchange {code}      |                      |
    |                       |                          |<---------------------|                      |
    |                       |                          |--------------------->| dir under mirror?    |
    |                       |                          |                      | hold context for dir |
    |                       |                          |                      |--------------------->| dir locked,
    |                       |                          |                      |                      | „Portuni · <node>"
    |                       |                          |                      |<---------------------| deck_create
    |                       |                          |                      | bundle in <dir>,     |
    |                       |                          |                      | context -> that deck,|
    |                       |                          |                      | agent as for `open`  |
    |  watcher registers the bundle; it shows up under Files                   |                      |
```

## Portuni

### Files tab: a split button

„+ Nový soubor" becomes a split button when the Showtime integration is on
(Settings → Integrace) and Showtime.app was found (`showtime_installed`):
the main part is „+ Nový soubor" as today, the chevron opens a menu with
„Nový soubor" and „Nová prezentace". Without the integration or without
Showtime the button is the plain one it is today.

„Nová prezentace" is disabled while the node has no mirror on this device,
with the reason as its title („Nejdřív vytvoř mirror uzlu"). With a mirror
it calls `newInShowtime(nodeId)`; a failure shows inline under the toolbar,
where `NewFileForm` shows its own error, never in a tab-level box. Nothing
else happens in Portuni: the bundle Showtime writes into `wip/` is
registered by the mirror watcher and appears in the tree like any new file.

### Sidecar: `POST /auth/handoff` answers with the mirror

The mint response gains `mirror: string | null` — the same
`getMirrorPath(userId, nodeId)` the exchange already answers with. Nothing
else changes; the exchange is untouched.

### Desktop: `new_in_showtime` command

`new_in_showtime { node_id }`, a sibling of `open_in_showtime`: resolves the
window's workspace (`ws_of`), mints the code with the terminal token the
host already holds, and refuses with „Uzel nemá na tomto počítači mirror"
when the mint answers `mirror: null`. Otherwise it opens

```
showtime://new?dir=<mirror>/wip&portuni=<sidecar base URL>&code=<code>
```

with each value percent-encoded. `<mirror>/wip` must lie inside the
workspace root and exist as a directory (a mirror is created with `wip/`,
`outputs/`, `resources/`), checked the way `showtime_deck_path` checks a
deck. The bearer never enters the URL.

## Showtime

### The link

`showtime://new?dir=<path>[&portuni=<base>&code=<code>]` is the second
action beside `open`. `dir` must be an absolute path to an existing
directory; otherwise the request is logged and dropped, as a bad `deck` is
today. The loopback check on `portuni` and the half-a-handoff rule are the
same as for `open`.

### The host

The host exchanges the code before any window is touched, so the screen
knows the node's name from the start. When the exchange answers with a
mirror and `dir` is not under it, the context is dropped (rule 7) and the
screen opens without a node.

The window is chosen as for `open`: the empty window if there is one,
otherwise a new one. It is told to open the New Deck screen with the
directory, and the node when there is one — through the same seam ⌘N uses,
so a window that has not loaded yet reads it when it does.

The context is held for the directory rather than for a deck path (there is
no deck yet). `deck_create` in that directory takes it and binds it to the
deck it just wrote; from there everything is the existing handoff
(`deck_agent_launch`, the environment, the MCP config file, the Agent tab
header). Leaving the screen without creating, opening another deck, or
closing the window drops it.

### The New Deck screen

Opened from the link, the screen shows the directory as a fixed line —
„Portuni · <node name> → wip/" with a node, the plain path plus „Portuni
context unavailable" without one — and offers no directory picker. Design
system, template and name are chosen as today. A missing design system
behaves as today (the way to Settings); the held context survives until the
screen is left.

### Docs

`docs/spec.md`: the `new` action under the deep link, the New Deck screen
opened from Portuni, the context held for a directory. Portuni side:
`sites/docs/src/content/docs/guides/working-in-the-app.md` (Files: the
split button and what „Nová prezentace" does; Integrace: the mirror
condition) and the CLAUDE.md gotcha under the Showtime entry in both
repositories.

## Errors

| Case | Behaviour |
|---|---|
| Showtime not installed or integration off | plain „+ Nový soubor", no split |
| node without a mirror on this device | „Nová prezentace" disabled, reason in its title |
| sidecar refuses `/auth/handoff` | Portuni shows the error inline under the toolbar |
| installed Showtime predates the `showtime://` scheme entirely | `open::that` fails; „Showtime neumí přijmout deck z Portuni, aktualizujte Showtime" |
| installed Showtime has `open` but not `new` | the launch is accepted and Showtime drops it with a log line; nothing visible in either app — update Showtime first (Release order) |
| code expired or sidecar not answering at exchange | New Deck opens with the directory, without context; Agent tab says so |
| `dir` not under the exchanged mirror | context dropped with a log line; New Deck opens without it |
| deck name already in `wip/` | Showtime refuses as today; the user picks another name |
| New Deck screen left without creating | nothing is written; context dropped |

## Testing

Portuni server: mint answers `mirror` (registered path, and null without
one). Desktop (Rust): `new` URL composition and percent-encoding; refusal
without a mirror; `dir` inside-root check. Web: the split appears only with
the integration on and Showtime found; „Nová prezentace" disabled without a
mirror; error rendering.

Showtime (Rust): link parsing for `new` (valid; missing, relative or absent
directory; non-loopback base; half a handoff); context held for a directory
is taken by a `deck_create` in that directory and by nothing else; dropped
when the screen is left or another deck opens; `dir` outside the exchanged
mirror drops the context. Web: New Deck with a fixed directory, with and
without a node.

Live on macOS (human): click „Nová prezentace" with Showtime running and
not running; the New Deck screen shows the node and the locked directory;
create; the bundle appears under the node's Files within seconds; the agent
in Showtime calls `portuni_get_context` unprompted; the session appears
under the node's Relace; with a Showtime that has `open` but not `new`, the
click does nothing visible.

## Release order

Showtime first (it must understand `new`), Portuni second. An old Showtime
with a new Portuni shows nothing (it drops the unknown action), which is why
Showtime ships first; a new Showtime with an old Portuni simply has no split
button.

## Out of scope

- Choosing the section (`outputs/`) or the name in Portuni.
- Hiding or disabling „+ Nový soubor" without a mirror.
- Codex / Vibe providers in Showtime.
- Persisting the node in the bundle or Showtime's recent list.
