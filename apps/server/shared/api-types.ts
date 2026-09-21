// src/api-types.ts -- Shared REST response shapes used by both the
// backend (src/server.ts loadGraph / loadNodeDetail) and the frontend
// (app/src/types.ts re-exports these).
//
// This file is deliberately pure type definitions and has no runtime
// dependencies, so it can be imported across the project boundary the
// same way src/popp.ts is.
//
// Changing any shape here is an API contract change: both the server
// handlers and the frontend consumers must be updated.

import type { NodeType, EdgeRelation } from "./popp.js";
import type { GlobalScope } from "../auth/roles.js";

// -- Graph (list) endpoint --------------------------------------------

export type GraphNodeOwner = {
  id: string;
  name: string;
};

export type GraphNode = {
  id: string;
  type: NodeType | string; // NodeType at runtime, widened for safety
  name: string;
  description: string | null;
  status: string;
  lifecycle_state: string | null;
  // "on_track" | "at_risk" | "off_track" -- see HEALTH_STATES in popp.ts.
  // Meaningful for type='project' only; other types always carry the
  // default 'on_track' and it is not shown for them.
  health: string;
  // "team" | "private" | "group" -- see NODE_VISIBILITIES in popp.ts. The
  // graph uses this to draw a dashed border on nodes restricted to a
  // group ACL, so sharing state is visible at a glance without opening
  // the detail pane.
  visibility: string;
  // Owner is rendered as a small initials pip on the node disc. Joined
  // from the actors table via nodes.owner_id; null when the node has no
  // assigned owner.
  owner: GraphNodeOwner | null;
  // Persisted layout. Null means "no saved position yet" -- the frontend
  // will compute one on first layout and POST it back via /positions.
  // Only leaf (non-organization) nodes actually persist here; org
  // positions are derived by cytoscape from their children's bounding
  // box, so there's nothing to store for them.
  pos_x: number | null;
  pos_y: number | null;
  // Used by the empty-workspace node picker to rank "recently touched"
  // nodes without a query -- newest updated_at (falling back to
  // created_at) first. Not shown in the UI otherwise.
  //
  // Optional, not just possibly-empty: a central server older than the
  // local app (teammate mirrors, independent deploys) can omit both
  // fields entirely from the graph payload. Any unconditional use is a
  // bug -- see #176.
  created_at?: string;
  updated_at?: string;
  // True when this node (visible to the caller) is currently under a
  // node_access ACL -- its own rows, or an inherited ancestor's. Absent
  // (not false) for an unrestricted node, mirroring the DetailEdge
  // peer_restricted convention. Present for admins too (they see every
  // node, but the ACL itself is still real) -- see apps/server/api/graph.ts.
  restricted?: true;
};

export type GraphEdge = {
  id: string;
  source_id: string;
  target_id: string;
  relation: EdgeRelation | string;
};

export type GraphPayload = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

// -- Node detail endpoint ---------------------------------------------

export type DetailEdge = {
  // "" (not the real ULID) when peer_restricted is true -- the locked chip
  // is non-navigable and has no legitimate use for the edge id (it cannot
  // be edited or removed), so it is withheld.
  id: string;
  relation: EdgeRelation | string;
  direction: "outgoing" | "incoming";
  // The peer's real ULID even when peer_restricted is true: the locked chip
  // needs it to POST /nodes/:id/access/request. A request-mode node is
  // discoverable by name by design, and every other endpoint still 404s
  // the id for a non-member, so exposing it here enables the request flow
  // without widening what the caller can read.
  peer_id: string;
  peer_name: string;
  peer_type: NodeType | string;
  // True when the peer is a mode='request' restricted node the caller
  // cannot otherwise see: it renders as a locked chip (name + type, no
  // access) instead of being dropped like a mode='private' peer is.
  // Absent (not false) for a plainly-visible peer or for admins, who see
  // every peer without the flag. Spec: "Zamcene polozky v Propojeni"
  // (docs/archive/specs/2026-07-04-node-sharing-design.md §4).
  peer_restricted?: true;
};

export type DetailFile = {
  id: string;
  filename: string;
  status: string;
  // Derived field. The `files` table no longer stores a local path
  // (migration 012). The server resolves this on read by combining the
  // per-device mirror root with the file's remote_path + node sync_key.
  // Null when the node has no mirror on this device or remote_path is
  // unset (e.g. legacy file rows that pre-date the file-sync foundation).
  local_path: string | null;
  // Path within the node mirror, with section as the first segment
  // (e.g. "wip/docs/plans/x.md"). Used by the UI to lay files out as a
  // tree. Null when no local_path could be derived.
  relative_path: string | null;
  mime_type: string | null;
};

// A file present on disk in the node mirror but not yet registered in the
// `files` table. Surfaced so the UI tree reflects disk truth; adopted by the
// sync run. No file_id (it isn't tracked yet).
export type UntrackedFile = {
  relative_path: string; // "wip/docs/x.md" -- same shape as DetailFile.relative_path
  section: string; // wip | outputs | resources
  subpath: string | null;
  filename: string;
  local_path: string;
  mime_type: string | null;
};

// Response of GET /nodes/:nodeId/file?path=<rel>.
export type FileContentResponse = {
  content: string;
  version: string; // sha256 of the on-disk bytes; pass back as baseVersion on save
  filename: string;
  mime_type: string | null;
  // Absolute filesystem path when read from a local mirror; null when read
  // remotely (central / no mirror). Used by the desktop HTML preview to
  // build its protocol URL. Desktop-only affordance: this is a server-side
  // path, so in a hosted-web deployment it would expose server paths to the
  // client -- it is null there (no local mirror) and unused by the web UI.
  local_path: string | null;
};

// Per-file sync state classified by the engine's statusScan. Untracked
// discovery results (new_local / new_remote) are intentionally omitted
// here -- the UI tab listing is built from tracked `files` rows, so a
// flat lookup keyed by file_id is what the frontend needs.
export type SyncClass =
  | "clean"
  | "push"
  | "pull"
  | "conflict"
  // Record exists, remote object does not: registered elsewhere and never
  // pushed, or gone from the remote and awaiting the next sync run's sweep.
  | "remote_missing"
  // Remote stat failed (network/auth). Transient; skipped by the sync run.
  | "remote_error"
  | "native"
  | "deleted_local";

export type SyncStatusFile = {
  file_id: string;
  sync_class: SyncClass;
  local_hash: string | null;
  remote_hash: string | null;
  last_synced_hash: string | null;
  local_path: string | null;
  remote_name: string | null;
  remote_path: string | null;
};

// A recent mirror-watcher failure to register/reconcile a file (#202): the
// watcher used to only log these, so a misconfiguration (e.g. a local-only
// workspace before #201, an unreadable file, a moved-away mirror) read as
// "files are not there" with nothing to diagnose it from short of opening
// the sidecar log. One entry per (node_id, path) -- a repeated failure for
// the same path refreshes `at` rather than growing the buffer; a later
// successful reconcile of that path clears it.
export type WatcherErrorEntry = {
  node_id: string;
  path: string;
  message: string;
  at: string;
};

export type SyncStatusResponse = {
  files: SyncStatusFile[];
  untracked: UntrackedFile[];
  // Present (possibly empty) only when this node has ever had a watcher
  // error tracked; omitted entirely for a node with none, so existing
  // callers that don't care about it see no shape change.
  watcher_errors?: WatcherErrorEntry[];
};

// GET /sync/health -- workspace-wide, every currently-tracked watcher error
// across all nodes on this device (#202). Used by the Settings ->
// Synchronizace banner; the per-node view is the `watcher_errors` field on
// SyncStatusResponse above.
export type SyncHealthResponse = {
  errors: WatcherErrorEntry[];
};

// GET /sync/watch (#339) -- what the remote watcher (#338) is doing, one
// entry per remote it knows about. Central only: the loop runs nowhere else
// (spec rule 5), so a local workspace answers `{remotes: []}` and the UI
// renders no watcher line at all.
export type RemoteWatchStatus = {
  remote_name: string;
  // false for a backend with no change feed (fs/OpenDAL), or while the
  // remote is failing -- the periodic full sweep is then all there is.
  watching: boolean;
  // When the change-feed cursor was last persisted, i.e. when a batch of
  // remote changes was last applied end to end. Its age is what the UI
  // renders as "poslední změna před N min".
  cursor_updated_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  // Set while the remote is backing off after a failed tick; null once the
  // next attempt is due.
  backoff_until: string | null;
  last_full_sweep_at: string | null;
  // The catch-up sweep's own failure, kept apart from the feed's: a node the
  // sweep cannot list leaves the change feed healthy and `watching` true,
  // and only the periodic sweep backs off (#422).
  sweep_error: string | null;
  sweep_backoff_until: string | null;
};
export type SyncWatchResponse = {
  remotes: RemoteWatchStatus[];
};

// Result of triggering a node-wide sync. The endpoint runs storeFile for
// every push candidate and pullFile for every pull candidate; conflicts
// and other classes are reported but not auto-resolved (Portuni never
// auto-merges).
export type SyncRunFile = {
  file_id: string;
  filename: string;
};

// `sync_class` is the class the file carried when the run tried to act on
// it, so a caller can tell a failed pull from a failed push (#420): the
// web's residual-pending accounting counts the two into different buckets,
// and an error reported as a push would hide an incoming pull entirely.
// Anything that is neither a push nor a pull candidate (a tombstone cleanup
// that could not remove the stale local copy, an untracked file that failed
// to adopt) is reported as "push": the next scan sees local work.
export type SyncRunErrorFile = SyncRunFile & { error: string; sync_class: SyncClass };

export type SyncRunSkippedFile = SyncRunFile & { sync_class: SyncClass };

export type SyncRunResponse = {
  pushed: SyncRunFile[];
  pulled: SyncRunFile[];
  adopted: SyncRunFile[];
  // Records created for files that appeared on the remote (remote sweep);
  // they are pulled in the same run.
  adopted_remote: SyncRunFile[];
  conflicts: SyncRunFile[];
  // Locally deleted but still tracked + on the remote. Reported, never
  // auto-restored: the deletion may be intentional, and resurrecting it
  // on every sync makes the mirror impossible to clean up. Restore via
  // portuni_pull { file_id }, or remove via portuni_delete_file.
  deleted_local: SyncRunFile[];
  // Local copies removed because their record was deliberately deleted
  // elsewhere (tombstone match, byte-identical to the last synced state).
  deleted_remote: SyncRunFile[];
  // Records removed because their remote object is gone (remote sweep).
  deleted_on_remote: SyncRunFile[];
  sweep_errors: Array<{ remote_path: string; error: string }>;
  // Pending file-op intents (Task 6: moveFile/renameFile/renameFolder/
  // deleteFile/deleteFileRemote) that the sweep's retry finished this run.
  repaired: SyncRunFile[];
  // Pending file-op intents that failed again this run and are still
  // waiting for a future sync run to retry.
  pending_repairs: Array<{ file_id: string; op: string; attempts: number; last_error: string | null }>;
  errors: SyncRunErrorFile[];
  skipped: SyncRunSkippedFile[];
};

// A background sync job (#273): "Synchronizovat vše" starts one of these
// (POST /sync/jobs) instead of blocking on a client-side loop over
// POST /nodes/:id/sync per node -- the job runs server-side with bounded
// concurrency and is polled (GET /sync/jobs/:id) for progress, so closing
// the overview modal or switching windows does not stop it. State is
// in-memory only (see sync-jobs.ts): it does not survive a sidecar/server
// restart, only a UI remount.
export type SyncJobNodeStatus = "pending" | "running" | "done" | "error";
export type SyncJobNode = {
  node_id: string;
  status: SyncJobNodeStatus;
  result?: SyncRunResponse;
  error?: string;
};
export type SyncJobSummary = {
  id: string;
  status: "running" | "done";
  started_at: string;
  finished_at: string | null;
  total: number;
  completed: number;
  errored: number;
  nodes: SyncJobNode[];
};

// Cross-mirror "what is not yet on a remote" aggregate, per node. `total`
// counts only classes a sync run actually clears (push + untracked);
// `decisions` counts classes that need a human (conflict + deleted_local)
// via the resolve endpoint, since a run leaves both untouched by design. A
// node is included when either is nonzero, so a decisions-only node is
// still visible in the overview instead of silently disappearing.
// remote_missing is informational only and counts toward neither.
// Incoming pull candidates are excluded entirely.
export type SyncPendingNode = {
  node_id: string;
  node_name: string;
  node_type: string;
  push: number;
  conflict: number;
  untracked: number;
  remote_missing: number;
  deleted_local: number;
  // Records whose remote copy is newer than this device's (#339): what the
  // remote watcher registers on central, read here as the signal outside
  // the node detail. A deliberate sync run does clear it, but the user did
  // not create this work -- counting it into `total` would make the
  // "unsynced local work" badge report someone else's edits -- so it counts
  // towards neither `total` nor `decisions`.
  pull: number;
  // Actionable: what a deliberate sync run can actually clear (push +
  // untracked). A run never resolves a conflict, so it is deliberately
  // excluded here -- see `decisions`.
  total: number;
  // Needs a human decision (conflict + deleted_local): a sync run leaves
  // both untouched by design, so counting them into `total` would make the
  // "unsynced" indicator permanently non-zero for a node with a conflict.
  // Resolved via POST /nodes/:id/files/:fileId/resolve.
  decisions: number;
};
export type SyncPendingResponse = {
  nodes: SyncPendingNode[]; // nodes with total > 0, decisions > 0 OR pull > 0, sorted by total desc
  total: number;            // sum of every node's total (actionable only)
  decisions: number;        // sum of every node's decisions
};

export type DetailEvent = {
  id: string;
  type: string;
  content: string;
  status: string;
  created_at: string;
  meta?: unknown;
  refs?: unknown;
  task_ref?: string | null;
};

export type LocalMirror = {
  local_path: string;
  registered_at: string;
} | null;

// GET /nodes/:id/mirror -- the device-local mirror for a node. Central mode
// serves node-detail from the central server, which has no device state, so
// local_mirror there is always null; the web reads this device-local endpoint
// (served by the sync agent) and overlays it onto the node.
export interface NodeMirrorResponse {
  node_id: string;
  local_mirror: LocalMirror;
}

export type DetailOwner = {
  id: string;
  name: string;
};

export type DetailResponsibilityAssignee = {
  id: string;
  name: string;
  type: string;
};

export type DetailResponsibility = {
  id: string;
  title: string;
  description: string | null;
  sort_order: number;
  assignees: DetailResponsibilityAssignee[];
};

export type DetailDataSource = {
  id: string;
  name: string;
  description: string | null;
  external_link: string | null;
};

export type DetailTool = {
  id: string;
  name: string;
  description: string | null;
  external_link: string | null;
};

// -- Node sharing (access control) endpoints ---------------------------
// GET/PUT /nodes/:id/access -- see apps/server/api/access.ts and
// apps/server/auth/node-access.ts for the resolution model (a node's own
// node_access rows override an inherited ancestor ACL; empty/absent ACL
// anywhere in the belongs_to chain means unrestricted).

export type NodeAccessEntry = {
  kind: "group" | "user";
  principal: string;
  // For "group": the display email stored on the node_access row itself.
  // For "user": the user's email, joined from the users table. Null only
  // in the (should-not-happen) case of a dangling user principal.
  display_email: string | null;
  // Only populated for "user" kind (joined from users table); null for
  // "group" entries -- groups have no separate display name field beyond
  // their email.
  display_name: string | null;
  // Only populated for "user" kind; null for "group".
  avatar_url: string | null;
};

export type NodeAccessResponse = {
  // False when the node (and its whole belongs_to ancestor chain) has no
  // ACL at all -- visible to every authenticated user.
  restricted: boolean;
  // True when the effective ACL was found on an ancestor rather than the
  // node itself.
  inherited: boolean;
  // The node id that actually owns the ACL rows (self when !inherited).
  // Null when unrestricted.
  source_node_id: string | null;
  source_node_name: string | null;
  entries: NodeAccessEntry[];
  // Restriction mode of the authoritative node (self when !inherited, the
  // ancestor's when inherited). Null when unrestricted -- the column only
  // has meaning for a node that actually has ACL rows. See
  // apps/server/auth/node-access.ts AccessMode and the "Rezim omezeni"
  // section of the sharing design spec.
  mode: "private" | "request" | null;
  // The node's OWN visibility mode, for the unified sharing selector.
  // Distinct from `restricted`, which reflects the effective (possibly
  // inherited) ACL and cannot distinguish team from private.
  visibility: "team" | "private" | "group";
};

// Access requests (POST /nodes/:id/access/request, GET /access/requests,
// GET /nodes/:id/access/requests, POST /access/requests/:id/approve|deny).
// One row per request; resolved rows are kept as history. Node + requester
// display data are joined server-side so the UI needs no extra fetches.
export type AccessRequestStatus = "pending" | "approved" | "denied";

export type AccessRequest = {
  id: string;
  node_id: string;
  node_name: string;
  node_type: NodeType | string;
  user_id: string;
  user_name: string;
  user_email: string;
  user_avatar_url: string | null;
  message: string | null;
  status: AccessRequestStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
};

// GET /nodes/:id/sessions -- node-detail sessions list (#192, "Naming &
// UI"). One row per persistent session (apps/server/domain/sessions.ts),
// enriched with what the row needs to render without a second round trip.
// "draft" (#374): a thread from the moment it opens, before it has a brief
// or a run -- created empty and never listed outside the open-thread view
// itself (GET /overview, the WS snapshot and GET /nodes/:id/sessions all
// exclude it). The first message promotes it to "running".
export type SessionState = "running" | "suspended" | "closed" | "archived" | "draft";

export type SessionSummary = {
  id: string;
  node_id: string | null;
  user_id: string;
  session_type: "interactive_task" | "interactive_chat" | "headless" | "env";
  cli: string | null;
  // Runner provider instance (apps/server/domain/runner/instances.ts) --
  // renamed from profile_id in the runner batch (migration 034); same
  // column, now a provider instance id rather than a desktop spawn-env
  // profile id.
  instance_id: string | null;
  // Historical: correlated to the desktop terminal that spawned this
  // session's CLI, back when the embedded terminal existed (#218). Nothing
  // writes a non-null value anymore since its removal (#345/#346); the
  // column stays for old rows until a later migration drops it.
  terminal_id: string | null;
  // The task as given (runner batch) -- the first user message on a fresh
  // run, null for a session predating it or with no task text.
  brief: string | null;
  // Runner adapter id (e.g. "claude") this session's task runs under.
  runner: string | null;
  // The host whose sidecar is (or last was) running the task: the latest
  // run's host, falling back to the session row's own for a session with no
  // run yet. Null for a hand-opened CLI session or one predating the runner
  // batch. Shown in the chat header and Relace rows (#428).
  host_id: string | null;
  // Display name of that host when something here can name it -- today only
  // the machine this process is (domain/runner/hosts.ts); null once the
  // `hosts` registry would be the one to answer, e.g. a teammate's device
  // read off the central server. The surfaces fall back to `host_id`.
  host_label: string | null;
  // Set while a `question` event is open (runner batch); cleared when it is
  // answered or the run ends. Drives the "Čeká na mě" status label.
  waiting_since: string | null;
  state: SessionState;
  name: string;
  name_is_custom: boolean;
  handoff_path: string | null;
  write_count: number;
  // #375: the thread's own model/reasoning-effort choice, so the header
  // renders it without a second fetch. null means unset (falls back to
  // the runner instance's defaults, then the runner's own default) --
  // never a resolved/effective value.
  model: string | null;
  effort: string | null;
  created_at: string;
  last_active_at: string;
  closed_at: string | null;
};

// GET /sessions/:id/resume-info -- drives the suspended row's "Nahodit:
// pokračování vs předání" choice (spec, "Lifecycle"/"Resume"): whether the
// underlying CLI conversation still exists (conversation-resume) versus
// falling back to the handoff (handoff-resume), and whether the handoff on
// disk has been edited since it was written at suspend.
export type SessionResumeInfo = {
  session_id: string;
  handoff_path: string | null;
  handoff_changed: boolean;
  // False when this device has no local mirror for the session's node, so
  // handoff_changed could not be evaluated (as opposed to evaluated and
  // found unchanged) -- see domain/session-handoff.ts's ResumeInfo.
  handoff_checkable: boolean;
  conversation_resumable: boolean;
  // #329: set when the handoff was written by the server, not the agent
  // (a dropped connection, idle GC, terminal exit, or the boot sweep) --
  // lets the Relace row say e.g. "pozastaveno serverem (nečinnost 30 min)".
  generated_by: "server" | null;
  // Mirrors domain/session-handoff.ts's own ServerHandoffReason (shared has
  // no domain imports, same precedent as RunEndReason below) -- #378 added
  // "run_ended" (any non-close run end) and "continue"; "suspend_timeout"
  // stays only so an old row's already-written reason marker still parses,
  // no runtime code produces it anymore.
  reason:
    | "disconnect"
    | "idle"
    | "terminal_exit"
    | "boot_sweep"
    | "suspend_timeout"
    | "host_lost"
    | "run_ended"
    | "continue"
    | null;
};

// GET /sessions/:id/scope (#427): the session's persisted read/write scope
// and the anchor node's name, as the record half holds them. Read by the
// sync agent's suspend fallback (domain/runner/suspend-fallback-central.ts),
// which has no local `session_scope` table to build the summary's
// write/read-set sections from; both sets are node ids, the write set a
// subset of the read set.
export type SessionScopeRecord = {
  session_id: string;
  node_name: string | null;
  write_set: string[];
  read_set: string[];
};

// Runner batch (docs/superpowers/specs/2026-09-12-runner-and-session-design.md):
// session_runs / session_events row shapes, defined here (rather than only in
// apps/server/domain/runner/store.ts, which re-exports them) so the web can
// type the REST responses without importing server domain code. RunEndReason
// duplicates domain/runner/types.ts's own union rather than importing it --
// same "shared has no domain imports" precedent as SessionState above.
export type RunEndReason = "completed" | "interrupted" | "suspended" | "error" | "limit" | "host_lost";

export type SessionRunRow = {
  id: string;
  session_id: string;
  runner: string;
  instance_id: string | null;
  host_id: string | null;
  agent_session_id: string | null;
  resumed_from_run_id: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: RunEndReason | null;
  usage: string | null;
};

export type SessionEventRow = {
  id: string;
  session_id: string;
  run_id: string | null;
  seq: number;
  kind: string;
  payload: string;
  created_at: string;
};

// GET /overview -- Přehled tab (phase 4, "Přehled (overview tab)" of the
// scope/sessions redesign spec). One aggregate, permission-filtered
// endpoint composing four deterministic sections. Every node reference is
// dropped server-side if the caller cannot see the node
// (filterVisibleNodeIds, apps/server/api/overview.ts); `access_requests`
// is additionally empty for callers below "manage" scope, matching
// GET /access/requests.

// A workspace-wide session row, unlike SessionSummary (node-detail list):
// enriched with the anchor node's name/type (there is no other node
// context on this screen) and without write_count (an extra per-row query
// this dashboard-scale list skips -- write_count remains available via
// GET /nodes/:id/sessions for the node-detail view).
export type OverviewSessionRow = {
  id: string;
  node_id: string | null;
  node_name: string | null;
  node_type: string | null;
  user_id: string;
  session_type: "interactive_task" | "interactive_chat" | "headless" | "env";
  cli: string | null;
  instance_id: string | null;
  brief: string | null;
  runner: string | null;
  waiting_since: string | null;
  state: SessionState;
  name: string;
  name_is_custom: boolean;
  handoff_path: string | null;
  created_at: string;
  last_active_at: string;
  closed_at: string | null;
};

export type OverviewDisconnectedJump = {
  session_id: string;
  session_name: string;
  node_id: string;
  node_name: string;
  node_type: string;
  reason: string | null;
  added_at: string;
};

export type OverviewAttentionNode = {
  id: string;
  type: string;
  name: string;
  lifecycle_state: string | null;
  // "on_track" | "at_risk" | "off_track" -- see HEALTH_STATES in popp.ts.
  health: string;
};

// See loadOverviewSyncIssues (domain/queries/overview.ts) for why this is a
// pending_file_ops proxy rather than a true sync-conflict record.
export type OverviewSyncIssue = {
  id: string;
  node_id: string;
  node_name: string;
  file_id: string;
  last_error: string;
  updated_at: string;
};

export type OverviewEvent = {
  id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  type: string;
  content: string;
  created_at: string;
};

export type OverviewSessionWrite = {
  session_id: string;
  session_name: string;
  node_id: string;
  node_name: string;
  added_at: string;
};

export type OverviewNewNode = {
  id: string;
  type: string;
  name: string;
  created_at: string;
  created_by_name: string;
};

export type OverviewPayload = {
  sessions: {
    running: OverviewSessionRow[];
    suspended: OverviewSessionRow[];
    disconnected_jumps: OverviewDisconnectedJump[];
  };
  attention: {
    nodes: OverviewAttentionNode[];
    access_requests: AccessRequest[];
    sync_issues: OverviewSyncIssue[];
  };
  activity: {
    events: OverviewEvent[];
    session_writes: OverviewSessionWrite[];
  };
  new_nodes: OverviewNewNode[];
};

// GET /auth/groups -- Google Workspace domain group directory, used by the
// sharing picker. 501 { error: "google_mode_only" } in env auth mode.
export type DirectoryGroup = {
  id: string;
  email: string;
  name: string;
};

// GET /auth/users -- account picker source for the sharing UI. Minimal
// projection (no global_scope/invited -- that's /auth/users/admin).
export type AccountUser = {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
};

// GET /auth/users/admin -- full account list for the Nastavení > Uživatelé
// admin tab: adds last_login_at, invited (no google_sub yet) and the
// resolved global_scope (via the identity adapter). null when the identity
// adapter couldn't resolve this row's access (e.g. an unresolvable invited
// email) -- the row still renders, just without a role.
export type UserAdmin = {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  last_login_at: string | null;
  invited: boolean;
  global_scope: GlobalScope | null;
};

export type NodeDetail = {
  id: string;
  type: NodeType | string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  created_at: string;
  updated_at: string;
  edges: DetailEdge[];
  files: DetailFile[];
  events: DetailEvent[];
  local_mirror: LocalMirror;
  meta?: unknown;
  owner: DetailOwner | null;
  responsibilities: DetailResponsibility[];
  data_sources: DetailDataSource[];
  tools: DetailTool[];
  goal: string | null;
  lifecycle_state: string | null;
  // "on_track" | "at_risk" | "off_track" -- see HEALTH_STATES in popp.ts.
  // Meaningful for type='project' only.
  health: string;
};

// GET /runners -- detected adapters and their availability (runner batch,
// docs/superpowers/specs/2026-09-12-runner-and-session-design.md).
export type RunnerInfo = {
  id: string;
  availability: {
    installed: boolean;
    version: string | null;
    logged_in: boolean;
    instances_supported: boolean;
  };
};

// GET /runners/:runner/models -- the model picker's list (#376). Mirrors
// domain/runner/types.ts's own RunnerModel, same "shared has no domain
// imports" precedent as RunEndReason above.
export type RunnerModel = {
  id: string;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  effortLevels: readonly string[];
};

// GET/POST/PATCH /runners/instances -- provider instances (today's desktop
// CLI spawn profiles, moved server-side). env values never appear here --
// env_keys only; the values live in runners.json and are read server-side
// only (domain/runner/instances.ts's getInstanceEnv).
export type RunnerInstanceSummary = {
  id: string;
  name: string;
  runner: string;
  env_keys: string[];
  org_defaults: string[];
  // #375: this instance's own model/effort defaults -- a thread that
  // doesn't override them itself falls back to these.
  defaults: { model?: string; effort?: string };
};
