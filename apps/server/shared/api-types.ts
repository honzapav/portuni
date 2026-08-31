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

export type SyncStatusResponse = {
  files: SyncStatusFile[];
  untracked: UntrackedFile[];
};

// Result of triggering a node-wide sync. The endpoint runs storeFile for
// every push candidate and pullFile for every pull candidate; conflicts
// and other classes are reported but not auto-resolved (Portuni never
// auto-merges).
export type SyncRunFile = {
  file_id: string;
  filename: string;
};

export type SyncRunErrorFile = SyncRunFile & { error: string };

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

// Cross-mirror "what is not yet on a remote" aggregate, per node. `total`
// (and node inclusion) counts only classes a sync run actually clears:
// push + conflict + untracked. remote_missing and deleted_local are carried
// as informational counts — a sync run neither pushes nor pulls them (they
// need a human decision via the resolve endpoint), so they are surfaced in
// the node's file list instead of driving the footer badge / quit guard.
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
  total: number;
};
export type SyncPendingResponse = {
  nodes: SyncPendingNode[]; // only nodes with total > 0, sorted by total desc
  total: number;            // sum of every node's total
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
};
