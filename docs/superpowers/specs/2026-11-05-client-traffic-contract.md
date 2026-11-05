# Client traffic contract

The desktop window and its sync agent each talk to the central server under a
per-token limit of 240 requests per minute (`PORTUNI_RATE_LIMIT_PER_MIN`,
sliding 60 s window, keyed by the exact bearer: the window's session JWT is one
bucket, the sidecar's device token another). The window's idle traffic is about
24 requests per minute; what hits the limit are bursts that UI actions cause.

## The rule

1. An action requests only the data it is missing. Closing, selecting,
   collapsing, switching tabs and focusing the window are not requests.
2. A mutation returns the changed record and the client writes it into state.
   `refetchAll` is for permission and subtree changes, not the default.
3. A change made elsewhere arrives on the live channel and is applied to the
   store. A REST fetch after a frame happens only for a record the store does
   not hold complete.
4. Data shared by the whole window (graph, `/me`, actors, users, runners,
   models, defaults) is fetched once per window and cached with in-flight
   dedupe. A component mount never decides freshness.
5. Polling is a slow recovery mechanism for what is on screen, paused while
   the window is hidden and while the server has answered `429`.
6. The server answers a list in one request; a per-item round trip needs a
   batch route.

A change to any surface comes with a test that pins the request count of the
action it touches (close, open, select, focus, tab switch).

## Where the rule is broken today

Ordered by impact. The step column names the migration step that fixes it.

| # | Trigger | Requests today | Step |
|---|---|---|---|
| 1 | Open-node set changes (open or close one node) | `GET /nodes/:id/sessions` for every open node | 2 |
| 2 | Any `session_state` frame for an open node | the node's whole session list again; Relace tab fetches it a second time; Přehled fetches the whole `/overview` | 2 |
| 3 | Footer MCP status | `/mcp/info` goes to central (not in the device-local list), 12/min, 30/min after any error including `429` | 1 |
| 4 | Two 5 s polls of the selected node (detail, sync-status) | run on every tab and in views where no detail is shown; in a team workspace each detail read adds a mirror lookup | 1 |
| 5 | Window focus | `GET /graph` + graph selection + Práce selection, whichever view is shown | 1 |
| 6 | Any edit in the detail pane | `GET /graph` + 1–2 node details | 4 |
| 7 | Práce → other view → Práce | every mounted chat remounts: runners, instances, models (twice), defaults, events probe, full transcript replay, per chat | 3 |
| 8 | Relace tab | list + one `resume-info` per suspended row on every tab open; the list fetches itself twice | 2 (cache), 5 (batch) |
| 9 | Collapse/expand of the detail aside, closing the editor | DetailPane remounts: sync-status + folder-url + the active tab's data | 3 |
| 10 | Pickers (owner, responsibility, assignee, sharing) | `/actors` or `/auth/users` on every open; `/me` from three places; Settings → Runners fetches `/graph` for the organization list | 3 |
| 11 | Open file | the whole file every 5 s to compare a version | 5 |
| 12 | Sync of one node | `POST sync` + `/sync/pending` + `/graph` + detail | 4 |
| 13 | Sidecar cold start | per-mirror config reads (2 × mirrors); new files registered one by one | 5 |
| 14 | `GET /nodes/:id/sessions` server side | 2 database queries per row | 5 |

Clean today: graph filters and search, switching threads inside Práce, position
saves (batched), `/sync/pending` and `/sync/health` polls (throttled, paused
when hidden). No layer retries a `429`.

## Migration order

1. Contain: route `/mcp/info` to the device, a window-wide `429` cooldown the
   pollers obey, polls only for what is visible, focus refetches only the
   shown view.
2. Session store as the source: open and close without refetch, frames patch
   the store, Relace and Přehled read from the store, resume-info cached per
   suspension.
3. Shared data once per window: graph, `/me`, actors, users, runners, models,
   defaults; detail data cached by node so presentation changes fetch nothing;
   chats keep transcript state across view switches.
4. Mutations return entities; `refetchAll` only for permission and subtree
   changes.
5. Batch routes (resume-info, mirror configs, file registration, responsibility
   reorder), version-only file check, a change channel for graph and files,
   then the remaining polls go.

Steps 1 and 2 are one PR; the plan is
`docs/superpowers/plans/2026-11-05-client-traffic-step-1-2.md`.
