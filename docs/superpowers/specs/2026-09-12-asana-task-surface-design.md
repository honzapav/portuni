# Asana task surface: the team coordinates in Asana, the run lives in Portuni

A task surface is where people assign, read and discuss work. Asana is the
first one. A node can be linked to an Asana project; a session can carry an
Asana task; an Asana task assigned to the Portuni agent becomes a headless
session on the linked node and answers with comments. Nothing is mirrored
on a timer: every write to Asana is a decision by the agent or a person.

Vision: `docs/vision/portuni-as-workspace.md` (Asana; Úkol a relace;
Co je v core). Step 3 of the runner plan; depends on
`2026-09-12-runner-and-session-design.md` (runtime, events, `question` /
`answer`) and `2026-09-12-remote-hosts-and-task-queue-design.md` (a
headless task needs a host; central dispatches). Central only.

## Rules

1. **Adapter interface first, Asana second.** `TaskSurfaceAdapter` is a
   server-domain interface; `asana.ts` is one implementation, registered
   only when central has an Asana token. The runtime, the MCP tools and
   the API call the interface. An Asana API change is a change in one
   file.
2. **Asana owns the human-facing fields when a node is linked.** Task
   name, description, assignee, completion and comments are read from
   Asana and written to Asana. Portuni stores the link and the run record,
   never a copy of those fields.
3. **No polling sync.** Inbound is webhooks; outbound is a tool call the
   agent chooses or a button a person presses. A dropped webhook is
   recovered by the next event on the same task or by the person
   re-assigning it, not by a sweep.
4. **The bot is a user.** Asana writes come from one Asana account (the
   "Portuni" user, a service account in the workspace) with a personal
   access token on central. Two gestures address it, with different
   roles: **assigning** a task to it hands over responsibility for
   completing the task; **@mentioning** it in a comment asks for a
   reaction on that task and nothing more. Comments say who asked
   (`Za: Jan Páv`) because the bot writes on the requester's behalf.
5. **The requester is the assigner.** A headless session started from
   Asana runs with the rights of the person who assigned the task
   (matched by Asana user email → Portuni user). Unknown assigner → the
   task gets a comment saying so and nothing runs.

## Model

### Links

`task_surface_links` (central):

| column | meaning |
|---|---|
| `node_id` | PK together with `surface` |
| `surface` | `asana` |
| `external_id` | Asana project gid |
| `external_url` | the permalink, for the UI |
| `created_by`, `created_at` | |

The only link is node ↔ Asana project (project, process or area nodes).
Organizations are not linked to Asana teams; a team is chosen at creation
time and not remembered. A node has at most one link per surface. The
`tools` row a node already carries ("Asana board for X",
`external_link`) stays as the human-visible pointer; the link table is
the machine-readable one. `POST /nodes/:id/task-surface` with an Asana
URL also creates the `tools` row when none points at that project.

`sessions` gains `task_ref TEXT NULL` (`asana:<task gid>`; the same
prefix vocabulary `events.task_ref` uses) and `task_url TEXT NULL`.

### Adapter

```ts
interface TaskSurfaceAdapter {
  id: "asana";
  resolveLink(url: string): Promise<{ kind: "project" | "task"; external_id: string; url: string } | null>;
  listTeams(): Promise<{ id: string; name: string }[]>;   // teams the bot user belongs to
  createProject(teamId: string, name: string, notes: string): Promise<{ external_id: string; url: string }>;
  getTask(taskId: string): Promise<SurfaceTask>;         // name, notes, assignee_email, completed, project_ids, url
  comment(taskId: string, text: string, opts: { on_behalf_of: string }): Promise<{ external_id: string }>;
  setCompleted(taskId: string, completed: boolean): Promise<void>;
  subscribe(resourceId: string, callbackUrl: string): Promise<{ subscription_id: string }>;
  unsubscribe(subscriptionId: string): Promise<void>;
  parseWebhook(headers, body): { handshake: string } | { events: SurfaceEvent[] } | { invalid: true };
}
type SurfaceEvent =
  | { kind: "assigned"; task_id: string; assignee_email: string | null; by_email: string | null }
  | { kind: "comment"; task_id: string; text: string; by_email: string | null; external_id: string; mentions_bot: boolean }
  | { kind: "completed" | "reopened"; task_id: string; by_email: string | null };
```

Asana implementation: REST v1, PAT from `PORTUNI_ASANA_TOKEN`
(central env; Bitwarden "Portuni Asana bot"), bot user gid resolved at boot
(`GET /users/me`). Webhooks per linked project (`POST /webhooks` with
filters `task.assignee changed`, `story.added comment`, `task.completed
changed`); `mentions_bot` is derived from the story text carrying the
bot user's profile link, which is how Asana renders an @mention;
handshake `X-Hook-Secret` echoed, every delivery verified with
`X-Hook-Signature` (HMAC-SHA256 of the body with the stored secret).
Stories from the bot user are ignored on the way in.

## Bot account

What the Asana side needs, and who provides it:

| requirement | how it is met |
|---|---|
| An Asana user "Portuni" in the workspace: a **guest** by default (an e-mail outside the organization's domain; free, can be assigned, comment, hold a PAT, sees only projects it is added to), a member seat or an Enterprise service account when project creation is wanted | created by a workspace admin once; e-mail and PAT stored in Bitwarden "Portuni Asana bot"; PAT into central's `PORTUNI_ASANA_TOKEN`. One account for the whole workspace regardless of how many hosts run tasks; hosts never talk to Asana |
| Membership in every linked project (private projects are invisible to non-members; webhooks and comments need access) | the bot cannot add itself. **Napojit** verifies access with the bot token first (`GET /projects/:gid`); on 403 the dialog shows "Přidej uživatele Portuni (<e-mail>) do projektu" and refuses the link until access works. The same check runs on every webhook error and marks the link `access_lost` |
| Membership in a team to create a project there | `listTeams()` returns only teams the bot belongs to; a team the bot is not in cannot be picked. A guest cannot create projects in teams at all: **Založit** is shown only when `GET /users/me` reports a workspace member (`is_guest` false, checked at boot and on the settings page); a guest bot offers **Napojit** only. Exact guest rights on the current plan: verify at implementation |
| Assigners resolvable to Portuni users | matched by e-mail (`SurfaceEvent.by_email` against `users.email`); an unknown assigner gets a comment and no session |
| A public HTTPS endpoint for webhooks | central's `POST /integrations/asana/webhook`; local mode has none |

`task_surface_links` gains `access_state` (`ok \| access_lost`) and
`access_checked_at`; `task_surface_subscriptions` records `last_delivery_at`
and `last_error`.

### Nastavení › Integrace › Asana (central, admin)

- Bot identity from `GET /users/me` with the token (name, e-mail,
  workspace), token status (present, valid, last checked); the token
  itself is never shown or entered here, it is central env.
- Linked projects: node, project, `access_state`, subscription health
  (last delivery, last error), "Ověřit přístup" and "Obnovit webhook"
  per row.
- Defaults for tasks from Asana: runner and host per organization
  (reuses `org_defaults` from the instances registry and the requester's
  default host; shown here read-only with a link to where they are set).
- Recent inbound events (last 50) with what they resolved to (session id
  or the reason nothing ran).

## Flows

### Link a node

- **Napojit**: paste an Asana project URL. `resolveLink` checks it is a
  project; the link row is written; a webhook subscription is created and
  its id + secret stored in `task_surface_subscriptions`.
- **Založit**: pick a team from `listTeams()` (the bot user must be a
  member of it), `createProject(team, node name, node description)`, then
  the same as Napojit. The team is not stored.
- **Odpojit**: unsubscribe, delete the link row; the `tools` row stays.
- MCP: `portuni_task_surface_link { node_id, url }`,
  `portuni_task_surface_create { node_id }`, `portuni_task_surface_unlink
  { node_id }` (write scope for link, `manage` for create/unlink).

### Task from Portuni

- **Nový úkol** in the node detail takes an optional Asana task URL.
  `resolveLink` gives `kind: "task"`; the session stores `task_ref` and
  `task_url`; the brief defaults to the task's name and notes, editable.
- Nothing is written to Asana at start. The agent has two tools while a
  session carries a `task_ref`: `portuni_task_comment { text }` (a
  comment on the linked task, prefixed `Za: <requester>`) and
  `portuni_task_complete {}`. Both are write-scope, both are audited, both
  are the agent's decision, as the vision says.

### Task from Asana (headless)

Two triggers, two roles:

| trigger | role | session | ends with | may complete the task |
|---|---|---|---|---|
| task assigned to the bot | responsible for the task | `headless`, `origin: "asana_assigned"`, brief = task name + notes | closing comment: last assistant message + handoff link | yes, through `portuni_task_complete` |
| bot @mentioned in a comment | react to that comment | `headless`, `origin: "asana_mentioned"`, brief = the comment + task name + notes, `policy: "auto"` | one reply comment | no; assignee and completion untouched |

Assignment:

1. Webhook `assigned` to the bot user on a task in a linked project.
2. Central resolves the node from the project link, the requester from
   `by_email` (the person who assigned; they must have write access to
   the node), and the host: the organization's team default host, else
   the requester's own default, else any shared online host with a
   logged-in runner. No host → comment "Portuni nemá kde úkol spustit"
   and stop.
3. `startTask` with `session_type: "headless"`, `brief` = task name +
   notes, `runner` = the organization's default runner (`org_defaults` in
   the instances registry), `policy: "auto"` (no approvals; the scope
   floor from `mcp/scope.ts` for headless sessions still refuses
   scope-sensitive nodes), `task_ref` set.
4. The run's `question` events become a comment on the task
   (`Portuni se ptá: …`) and the session goes `waiting`. A comment from a
   person on that task while the session is waiting is the `answer`
   (its text; the first line if it starts with a number for an options
   question). A comment while the session is running but not waiting is
   `sendMessage`.
5. `run_ended`: the runtime posts a closing comment with the last
   assistant message (first 2 000 characters) and the handoff link when
   one exists. The task is not completed by Portuni unless the agent
   called `portuni_task_complete`.
6. `completed` webhook while the session is running: `closeSession`.
   Re-assigning to the bot while a session for that task is `suspended`:
   `resume { mode: "handoff" }`; while `closed`: a new session.
   Assignee changed away from the bot while running: `suspend` (the
   person took the task back; the handoff is theirs to read).

Mention:

1. Webhook `comment` with `mentions_bot` (the story text carries the bot
   user's mention link) from a person, on a task in a linked project.
2. If a session with that `task_ref` is `running` or `waiting`, the
   comment is delivered to it (`answer` when waiting, else
   `sendMessage`); no new session. Otherwise a new `headless` session
   with `origin: "asana_mentioned"` and the mentioner as requester, same
   host and runner resolution as above.
3. The agent has `portuni_task_comment` only; `portuni_task_complete` is
   not registered for a mention session. The run's last assistant message
   is posted as the reply comment at `run_ended`; a `question` event
   is posted as a comment and the session waits, as for assignment.
4. A mention session closes after its reply; a further mention starts a
   fresh one with the previous handoff in its orientation, so a thread of
   reactions keeps context without holding a session open.

Interactive sessions never post automatically; only the headless flows
have the closing comment and the question-as-comment rule, because there
is no chat surface for those sessions anywhere else.

### Visibility

- The Relace tab and Přehled show the task link (`task_url`) on a row and
  a "z Asany" badge on headless sessions started by the webhook.
- The node detail header shows the Asana project link next to the mirror
  path when linked.

## API

Central:

- `GET|POST|DELETE /nodes/:id/task-surface` (`{ url }` on POST; `manage`
  to delete), `POST /nodes/:id/task-surface/create` `{ team_id }`,
  `GET /integrations/asana/teams`.
- `POST /integrations/asana/webhook` (public in `AUTH_PUBLIC_PATHS`,
  signature-verified, idempotent on Asana's event ids).
- `POST /sessions` gains `task_url?`; `GET /nodes/:id/sessions` and
  `/overview` rows carry `task_ref`, `task_url`, `origin: "portuni" |
  "asana_assigned" | "asana_mentioned"`.
- `GET /integrations/asana/status` (admin): bot user, token status,
  links with `access_state`, subscriptions with last delivery and error,
  recent inbound events; `POST /nodes/:id/task-surface/verify` and
  `POST /nodes/:id/task-surface/resubscribe`.

Local mode: no adapter registered; the routes answer `409
SURFACE_UNAVAILABLE`, the tools are not registered, the UI hides the
Asana affordances (`GET /integrations` lists what central has).

## Web

- **Node detail › Přehled**: "Asana" row with Napojit / Založit (team
  picker) / Odpojit and the project link.
- **Nový úkol**: "Odkaz na Asana task" field.
- **SessionChat header**: task link when present.
- **Nastavení › Integrace › Asana** (central admin): the page described
  under Bot account, fed by `/integrations/asana/status`.

## Testing

- Adapter against a fake Asana (`node:http`): link resolution for
  project/task URLs (a team URL is refused), team listing, project
  creation in a chosen team, webhook handshake,
  signature verification (valid, wrong secret, replayed event id), story
  filtering of the bot's own comments.
- Headless flows with the fake adapter and the fake runner: assignment →
  session with the requester's identity; question → comment + waiting;
  human comment → answer; completion webhook → close; assignee moved
  away → suspend; unknown assigner → comment, no session; no host →
  comment, no session. Mention → reply-only session without
  `portuni_task_complete`; mention while a session is live → delivered
  to it, no new session; second mention → new session with the previous
  handoff in orientation.
- Tools: `portuni_task_comment` prefixes the requester, refuses without a
  `task_ref`.
- Human: a real Asana workspace with the bot user, one task each way.

## Phases

1. **Interface + link**: `TaskSurfaceAdapter`, Asana implementation
   without webhooks, link table, routes, node detail UI, `task_ref` on
   sessions, the two agent tools.
2. **Inbound**: webhooks, headless flow, comments for questions and
   endings, Přehled/Relace badges.
3. **Docs**: `sites/docs` guide "Asana" and the concepts page for task
   surfaces.

## Open decisions

- Whether the closing comment should include the handoff text inline
  (readable in Asana, but long) or only the link. Default: link plus the
  last assistant message.
