# Showtime handoff: open a deck with its Portuni context

„Otevřít v Showtime" on a `.showtime` deck in a node's files opens the deck
in Showtime.app and hands over the node the deck belongs to. The agent
Showtime starts beside the deck is then a Portuni session on that node: it
talks to the Portuni MCP server with the node as its home, and it reads and
edits the node's mirror as a second working directory. Two repositories
change: `honzapav/portuni` (sender) and `honzapav/showtime` (receiver).

Builds on Portuni PR #235 (preview + button) and showtime#57 (`preview.html`
in the bundle).

## Rules

1. **The deck stays where it is.** Showtime opens the `.showtime` at its
   path inside the mirror and saves back to it. Portuni's mirror watcher
   picks the save up like any other edit; no copy, no import.
2. **The agent's cwd is the deck's working directory**, as today. Showtime's
   guard (`.claude/settings.json` + hook), `deck-changed`, history and the
   unsaved-work check all key on that directory and stay untouched.
3. **The mirror is a second working directory of the agent**, passed as
   `claude --add-dir <mirror>`. Claude Code then reads and edits files under
   the mirror without permission prompts and loads the mirror's `CLAUDE.md`
   (the Portuni marker block included).
4. **The Portuni MCP server is connected with the node as home.** The agent
   gets an MCP config whose `portuni` server URL carries
   `?home_node_id=<node>` and whose bearer header is expanded from
   `PORTUNI_MCP_TOKEN` in the agent's environment. Connecting auto-seeds the
   session scope, so the session shows up under the node's Relace like a
   terminal spawned from Portuni.
5. **No bearer in a URL, in argv, or on disk.** Portuni hands Showtime a
   one-time handoff code; Showtime exchanges it over loopback for the token
   and keeps the token in the host process only. It reaches the agent as an
   environment variable of the PTY, the same channel Portuni's own
   terminals use.
6. **The context lives as long as the deck is open.** Closing the deck drops
   it. A deck reopened from Showtime's recent list has no Portuni context.
   Persisting the link in the bundle is out of scope.
7. **Showtime without Portuni is unchanged.** A deck opened from Finder, the
   recent list or `showtime://open` without a handoff behaves exactly as
   today. Nothing in Showtime depends on Portuni being installed.

## Flow

```
Portuni web        Portuni desktop (Rust)     Portuni sidecar          Showtime host             Showtime agent
    |  open_in_showtime     |                       |                        |                        |
    |  {node_id, path}      |                       |                        |                        |
    |---------------------->| POST /auth/handoff    |                        |                        |
    |                       | Bearer <terminal tok> |                        |                        |
    |                       | {node_id}             |                        |                        |
    |                       |---------------------->| mint code, 60 s,       |                        |
    |                       |<----------------------| bound to {token,node}  |                        |
    |                       | {code}                |                        |                        |
    |                       | open showtime://open?deck=<path>&portuni=<sidecar base>&code=<code>     |
    |                       |------------------------------------------------>|                       |
    |                       |                       | POST /auth/handoff/exchange {code}              |
    |                       |                       |<-----------------------|                        |
    |                       |                       |----------------------->| {token, mcp_url,       |
    |                       |                       |                        |  home_node_id, mirror, |
    |                       |                       |                        |  node_name}            |
    |                       |                       |                        | open deck at <path>    |
    |                       |                       |                        | spawn agent: cwd=workdir,
    |                       |                       |                        |  claude --add-dir <mirror> --mcp-config <file>
    |                       |                       |                        |  env PORTUNI_MCP_TOKEN, PORTUNI_MIRROR, ...
    |                       |                       |                        |----------------------->|
    |                       |                       |<------------------- MCP connect ?home_node_id --|
```

## Portuni

### Sidecar: handoff endpoints (`apps/server/api/auth.ts`)

`POST /auth/handoff` — authenticated (the desktop's terminal token, scope
tier `write`). Body `{ node_id }`. The caller must have access to the node.
Response `{ code, expires_in: 60 }`. The code is 32 random bytes,
base64url. The sidecar keeps `{ code, token, node_id, user_id, expires_at }`
in memory (`domain/handoff.ts`); one map per process, swept on every mint.

`POST /auth/handoff/exchange` — public (listed in `AUTH_PUBLIC_PATHS`, like
`GET /auth/desktop-config`), accepted only from a loopback peer address.
Body `{ code }`. A code that is unknown, expired, or already used answers
`404 HANDOFF_INVALID`; a valid one is deleted before the response is sent.
Response:

```json
{
  "token": "<the bearer that minted the code>",
  "mcp_url": "http://127.0.0.1:<port>/mcp?home_node_id=<node_id>",
  "home_node_id": "<node_id>",
  "node_name": "<node title>",
  "mirror": "<absolute mirror root of the node on this device>"
}
```

`mcp_url` comes from `resolvePortuniMcpUrl()` + `appendHomeNodeIdToUrl()`
(`domain/write-scope.ts`); `mirror` from `getMirrorPath(userId, nodeId)`
(`domain/sync/mirror-registry.ts`). A node with no mirror on this device
still answers, with `mirror: null` — Showtime then omits `--add-dir` and the
agent works through MCP alone.

The token handed back is the one that minted the code: in local mode the
sidecar's per-launch token, in agent mode the same local token Portuni's
terminals get (`workspace::terminal_mcp_token`). Nothing new is minted, so
revocation and rotation stay as they are.

### Desktop: `open_in_showtime` command (`apps/desktop/src/lib.rs`)

`open_in_showtime { node_id, path }` replaces `open_path_external` for the
Showtime button:

1. `path` must be inside the workspace root and end in `.showtime`
   (`is_showtime_ext`), as `open_path_external` checks today.
2. `POST /auth/handoff` on the active workspace's sidecar with the terminal
   token the Rust side already holds for `pty_spawn` (never through the
   webview).
3. `open::that("showtime://open?deck=<path>&portuni=<sidecar base URL>&code=<code>")`,
   each value percent-encoded.

`showtime_installed` stays as the gate for showing the button.
`open_path_external` no longer accepts `.showtime`; `.html/.htm` are
unchanged.

### Web (`apps/web`)

- `HtmlPreview` (kind `showtime`) gets the node id and calls
  `openInShowtime(nodeId, localPath)` (`lib/showtime.ts`) instead of
  `openPathExternal`. A failed handoff shows the error inline in the preview
  bar, like other file-action errors.
- Settings → Integrace → Showtime: the toggle stays. The section shows
  whether Showtime.app was found (`showtime_installed`) and the description
  says what „Otevřít v Showtime" hands over: the node's Portuni connection
  for the agent and the node's mirror as a working directory.

### Docs

- `sites/docs/src/content/docs/guides/working-in-the-app.md`: Files
  (what the button hands over) and Settings → Integrace (the status line).
- `CLAUDE.md` gotcha under the Showtime entry: the handoff endpoints, the
  rule that the bearer never enters the URL, and that the session shows up
  under the node's Relace.

## Showtime

### Receiving a deck (`apps/desktop`)

- `tauri-plugin-deep-link` registers the `showtime` scheme;
  `tauri-plugin-single-instance` forwards a second launch's arguments to the
  running instance. `tauri.conf.json` also declares the `.showtime` file
  association, so Finder double-click and `open -a Showtime x.showtime`
  reach the same handler (`RunEvent::Opened` / the plugin's `on_open_url`).
- `showtime://open?deck=<path>[&portuni=<base>&code=<code>]`. `deck` must be
  an absolute path to an existing `.showtime`; otherwise the request is
  logged and dropped. With `portuni` + `code`, the host exchanges the code
  (`POST <base>/auth/handoff/exchange`, loopback only: the host refuses a
  `portuni` base whose host is not `127.0.0.1`/`localhost`) before opening
  the deck. An exchange that fails opens the deck anyway, without context,
  and logs the reason; the window shows one line („Portuni context
  unavailable") in the Agent tab.
- The host emits `open-deck-request { path }` to the window; the window
  runs its normal open flow (`deck_open`, including the unsaved-work
  question). A deck already open is closed first through the existing
  unsaved-changes prompt; cancelling the prompt cancels the request.

### Holding the context (`apps/desktop/src/deck.rs`)

`DeckState` carries an optional `PortuniContext { token, mcp_url,
home_node_id, node_name, mirror }` next to the open deck. Set by the handoff
before `deck_open`, cleared by `deck_close` and by any open that did not
come through a handoff. Never serialized; `deck_read_meta`/`DeckInfo` expose
only `portuni: { node_name, mirror } | null` — no token reaches the webview.

### The agent's launch

`deck_agent_launch` (host command, replaces the webview reading
`deck_agent_env` + composing `claude` itself) returns `{ command, env }`:

- `command`: the provider's command, plus, with a Portuni context,
  `--add-dir '<mirror>'` (when `mirror` is set) and
  `--mcp-config '<app data>/portuni-mcp/<deck hash>.json'`. Paths are
  single-quoted with the existing `shell_single_quote`.
- The MCP config file holds only the URL and an env reference, written
  0600, removed on `deck_close`:

  ```json
  { "mcpServers": { "portuni": { "type": "http", "url": "<mcp_url>",
    "headers": { "Authorization": "Bearer ${PORTUNI_MCP_TOKEN}" } } } }
  ```

- `env`: today's `SHOWTIME_*` plus, with a Portuni context:

  | Variable | Value |
  |---|---|
  | `PORTUNI_MCP_TOKEN` | the exchanged bearer |
  | `PORTUNI_HOME_NODE_ID` | the node id |
  | `PORTUNI_MIRROR` | the mirror root, when there is one |
  | `SHOWTIME_PORTUNI` | text for the agent: this deck belongs to Portuni node `<node_name>`; the node's files are under `<mirror>` (`resources/` holds source material, `wip/` and `outputs/` the node's work); read `<mirror>/PORTUNI_SCOPE.md` first; the Portuni MCP server is connected with this node as home |

  `SHOWTIME_PORTUNI` is composed in `packages/core` like `SLIDE_ID_GUIDE`,
  so the wording is one string with tests.

The provider abstraction is unchanged: `--add-dir`/`--mcp-config` are
appended only for the `claude-code` provider; another provider gets the env
and nothing else.

### UI

Agent tab header: „Portuni · <node_name>" while a context is held. Nothing
else changes on screen.

### Docs

`docs/spec.md`: §Host commands (`deck_agent_launch`, the deep link, the
file association), §The agent's environment (the Portuni rows and
`--add-dir`), a new §Opening from Portuni describing the handoff and rule 5.

## Errors

| Case | Behaviour |
|---|---|
| Showtime.app not installed | button hidden (unchanged) |
| sidecar refuses `/auth/handoff` (node access, 5xx) | Portuni shows the error in the preview bar, nothing opens |
| Showtime not registered for `showtime://` (old build) | `open::that` fails; Portuni shows „Showtime neumí přijmout deck z Portuni, aktualizujte Showtime" |
| code expired/used at exchange | Showtime opens the deck without context, logs, shows the Agent-tab line |
| node without a mirror on this device | context without `--add-dir`; MCP only |
| deck path outside the workspace root | Portuni refuses before any request |

## Testing

Portuni server: mint → exchange round trip; second exchange 404; expired
code 404; exchange from a non-loopback peer refused; mint without node
access refused; response carries `mcp_url` with `home_node_id` and the
registered mirror path. Desktop (Rust): URL composition and percent-encoding;
`.showtime`-only and in-root checks. Web: button calls `openInShowtime`
with node id; error rendering.

Showtime host (Rust): deep-link parsing (valid, missing deck, relative
path, non-loopback `portuni`); `PortuniContext` cleared on close and on a
plain open; `deck_agent_launch` command and env with and without context,
with and without mirror; MCP config file content and removal.
`packages/core`: `SHOWTIME_PORTUNI` text. Live check on macOS (human):
click the button with Showtime running and not running, the agent lists
node files from the mirror and calls `portuni_get_context` without a prompt,
the session appears under the node's Relace.

## Out of scope

- Persisting the Portuni link in the bundle or Showtime's recent list.
- Codex / Vibe providers in Showtime.
- Creating a new deck from a Portuni node (only opening an existing one).
- Any Showtime-side awareness of Portuni beyond the handoff (no Portuni
  client in Showtime, no sync).
