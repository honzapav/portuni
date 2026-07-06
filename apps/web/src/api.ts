import type {
  GraphPayload,
  NodeDetail,
  NodeMirrorResponse,
  DetailResponsibility,
  DetailDataSource,
  DetailTool,
  SyncStatusResponse,
  SyncRunResponse,
  SyncPendingResponse,
  DetailFile,
  FileContentResponse,
  NodeAccessResponse,
  NodeAccessEntryInput,
  DirectoryGroup,
  AccountUser,
  UserAdmin,
} from "./types";
import { apiFetch } from "./lib/backend-url";

// User shape returned by GET /users. Used by the Actors page to pick a
// user_id when creating/editing a real (non-placeholder) person actor.
export type User = {
  id: string;
  email: string;
  name: string;
};

// GET /users was raised to the "manage" scope (node-sharing owner picker).
// Read-scope callers (e.g. ActorModal's user_id dropdown) can't save an
// owner anyway, so a 403 here degrades silently to an empty list instead
// of surfacing an error banner.
export async function fetchUsers(): Promise<User[]> {
  const res = await apiFetch("/users");
  if (res.status === 403) return [];
  if (!res.ok) throw new Error(`users: ${res.status}`);
  return res.json();
}

// Actor shape returned by GET /actors. Mirrors the DB row; separate from
// NodeDetail's assignee shape (which is narrower – just id/name/type).
// Actors are global (cross-organizational) – no org_id field. No
// description field either – what an actor does is defined by their
// responsibilities on specific nodes, not a generic role blurb.
export type Actor = {
  id: string;
  type: "person" | "automation";
  name: string;
  is_placeholder: number;
  user_id: string | null;
  notes: string | null;
  external_id: string | null;
};

export async function fetchGraph(): Promise<GraphPayload> {
  const res = await apiFetch("/graph");
  if (!res.ok) throw new Error(`graph: ${res.status}`);
  return res.json();
}

export async function fetchNode(id: string): Promise<NodeDetail> {
  const res = await apiFetch(`/nodes/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`node: ${res.status}`);
  const node: NodeDetail = await res.json();
  // Central mode serves node-detail with local_mirror:null (the central server
  // has no device state). Overlay it from the device here, in the single fetch
  // point, so EVERY consumer -- graph view, workspace ("Práce") view, the 5s
  // detail poll -- gets the real path without each having to remember to
  // hydrate. Local mode already carries local_mirror, so this only fires for a
  // genuinely unmirrored node, where the endpoint returns null (or 404 in local
  // mode) and we leave it as-is. Orgs never have a mirror.
  if (!node.local_mirror && node.type !== "organization") {
    try {
      const { local_mirror } = await fetchNodeMirror(id);
      if (local_mirror) return { ...node, local_mirror };
    } catch {
      /* mirror endpoint absent (local mode) or errored -- leave null */
    }
  }
  return node;
}

// Device-local mirror for a node. Central-mode node-detail carries
// local_mirror:null (the central server has no device state); the web reads
// this from the local sync agent and overlays it. Served by the agent router
// in central mode; in local mode node-detail already carries the mirror so
// callers only reach for this when local_mirror is absent.
export async function fetchNodeMirror(id: string): Promise<NodeMirrorResponse> {
  const res = await apiFetch(`/nodes/${encodeURIComponent(id)}/mirror`);
  if (!res.ok) throw new Error(`mirror: ${res.status}`);
  return res.json();
}

export async function fetchNodeSyncStatus(
  id: string,
): Promise<SyncStatusResponse> {
  const res = await apiFetch(`/nodes/${encodeURIComponent(id)}/sync-status`);
  await throwForStatus(res, "sync-status");
  return res.json();
}

export async function fetchSyncPending(): Promise<SyncPendingResponse> {
  const res = await apiFetch(`/sync/pending`);
  await throwForStatus(res, "sync-pending");
  return res.json();
}

// Browser-openable folder URL for a node on its routed remote. Returns
// { url: null, ... } when the node has no remote, the backend doesn't
// support web URLs (s3, sftp, ...), or the folder hasn't been synced yet.
export type FolderUrlResponse = {
  url: string | null;
  remote_name?: string;
  reason?: string;
};

export async function fetchNodeFolderUrl(
  id: string,
): Promise<FolderUrlResponse> {
  const res = await apiFetch(`/nodes/${encodeURIComponent(id)}/folder-url`);
  await throwForStatus(res, "folder-url");
  return res.json();
}

export async function fetchNodeFileUrl(
  id: string,
  fileId: string,
): Promise<FolderUrlResponse> {
  const res = await apiFetch(
    `/nodes/${encodeURIComponent(id)}/file-url?file_id=${encodeURIComponent(fileId)}`,
  );
  await throwForStatus(res, "file-url");
  return res.json();
}

export async function runNodeSync(id: string): Promise<SyncRunResponse> {
  return jsonRequest<SyncRunResponse>(
    "POST",
    `/nodes/${encodeURIComponent(id)}/sync`,
  );
}

// Create a working folder for the node and register it in sync.db.
// Idempotent — calling for an already-mirrored node returns the existing
// path with `created: false`. Returned `local_path` is what the agent
// launcher will `cd` into.
export type CreateMirrorResponse = {
  node_id: string;
  local_path: string;
  created: boolean;
  remote_url: string | null;
};

export function createNodeMirror(id: string): Promise<CreateMirrorResponse> {
  return jsonRequest<CreateMirrorResponse>(
    "POST",
    `/nodes/${encodeURIComponent(id)}/mirror`,
  );
}

// Seatbelt disk-scope profile for spawning an agent terminal inside the
// node's mirror: home mirror read+write, the rest of PORTUNI_ROOT denied
// by the kernel. Files of other in-scope nodes are reachable via staged
// read-only copies under .portuni-scope/. Fetched right before pty_spawn;
// the terminal launch is fail-closed on errors so an agent never starts
// without the boundary by accident.
export type SandboxProfileResponse = {
  profile: string;
  portuni_root: string;
  home_mirror: string;
};

export function fetchSandboxProfile(id: string): Promise<SandboxProfileResponse> {
  return jsonRequest<SandboxProfileResponse>(
    "GET",
    `/nodes/${encodeURIComponent(id)}/sandbox-profile`,
  );
}

// Create a node via REST. Type and name are required; organization_id is
// required for non-organization types (the server enforces this and
// returns 400 otherwise — kept here for clarity at the call site).
export function createNode(input: {
  type: string;
  name: string;
  description?: string;
  organization_id?: string;
}): Promise<NodeDetail> {
  return jsonRequest<NodeDetail>("POST", "/nodes", input);
}

// Thrown when a device-local affordance (sync status, folder/file URL) is
// requested but the local sync agent isn't running yet -- in central mode that
// means you're not signed in. The backend returns 501 local_only. Components
// can catch this specific type to show a friendly hint instead of a toast.
export class LocalOnlyError extends Error {
  constructor() {
    super("Synchronizační agent neběží – přihlas se v Nastavení → Účet.");
    this.name = "LocalOnlyError";
  }
}

// Parses a Response and throws LocalOnlyError for 501 local_only or a
// generic Error for other non-ok statuses.
async function throwForStatus(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  if (res.status === 501) {
    let isLocalOnly = false;
    try {
      const j = (await res.clone().json()) as { error?: string };
      if (j.error === "local_only") isLocalOnly = true;
    } catch {
      /* body not JSON — fall through */
    }
    if (isLocalOnly) throw new LocalOnlyError();
  }
  const text = await res.text().catch(() => "");
  throw new Error(`${label}: ${res.status} ${text}`);
}

async function jsonRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await apiFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  await throwForStatus(res, `${method} ${path}`);
  return res.json();
}

export function updateNode(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    goal?: string | null;
    lifecycle_state?: string | null;
    owner_id?: string | null;
    visibility?: string;
  },
): Promise<NodeDetail> {
  return jsonRequest<NodeDetail>(
    "PATCH",
    `/nodes/${encodeURIComponent(id)}`,
    patch,
  );
}

export function archiveNode(id: string): Promise<{ archived: string }> {
  return jsonRequest<{ archived: string }>(
    "DELETE",
    `/nodes/${encodeURIComponent(id)}`,
  );
}

// Move a non-organization node to a different organization. Atomic
// rebind of the belongs_to edge -- see moveNodeToOrganization() in
// src/tools/edges.ts for why disconnect+connect cannot satisfy the
// org-invariant triggers and why an UPDATE legally bypasses both.
export function moveNode(
  id: string,
  newOrgId: string,
): Promise<{ moved: boolean; from_org_id: string; to_org_id: string; node: NodeDetail }> {
  return jsonRequest("POST", `/nodes/${encodeURIComponent(id)}/move`, {
    new_org_id: newOrgId,
  });
}

export function createEdge(input: {
  source_id: string;
  target_id: string;
  relation: string;
}): Promise<{ id: string }> {
  return jsonRequest<{ id: string }>("POST", "/edges", input);
}

export function deleteEdge(id: string): Promise<{ deleted: string }> {
  return jsonRequest<{ deleted: string }>(
    "DELETE",
    `/edges/${encodeURIComponent(id)}`,
  );
}

export function createEvent(input: {
  node_id: string;
  type: string;
  content: string;
}): Promise<{ id: string }> {
  return jsonRequest<{ id: string }>("POST", "/events", input);
}

export function updateEvent(
  id: string,
  patch: { content?: string; type?: string; status?: string; created_at?: string },
): Promise<unknown> {
  return jsonRequest("PATCH", `/events/${encodeURIComponent(id)}`, patch);
}

export function archiveEvent(id: string): Promise<{ archived: string }> {
  return jsonRequest<{ archived: string }>(
    "DELETE",
    `/events/${encodeURIComponent(id)}`,
  );
}

// Persist cytoscape node positions to the backend. Called after the
// initial layout settles and after every dragfree event. Fire and forget
// -- positions are soft state, losing one write is not catastrophic, so
// we don't surface errors to the user.
export function savePositions(
  updates: Array<{ id: string; x: number; y: number }>,
): Promise<{ updated: number }> {
  if (updates.length === 0) {
    return Promise.resolve({ updated: 0 });
  }
  return jsonRequest<{ updated: number }>("POST", "/positions", { updates });
}

// -- Actors --------------------------------------------------------------

export async function fetchActors(params?: {
  type?: "person" | "automation";
  is_placeholder?: boolean;
}): Promise<Actor[]> {
  const qs = new URLSearchParams();
  if (params?.type) qs.set("type", params.type);
  if (params?.is_placeholder !== undefined) {
    qs.set("is_placeholder", params.is_placeholder ? "1" : "0");
  }
  const res = await apiFetch(`/actors?${qs}`);
  if (!res.ok) throw new Error(`actors: ${res.status}`);
  return res.json();
}

export function createActor(input: {
  type: "person" | "automation";
  name: string;
  is_placeholder?: boolean;
  user_id?: string;
  notes?: string;
  external_id?: string;
}): Promise<Actor> {
  return jsonRequest<Actor>("POST", "/actors", input);
}

export function updateActor(
  id: string,
  patch: {
    name?: string;
    is_placeholder?: boolean;
    user_id?: string | null;
    notes?: string | null;
  },
): Promise<Actor> {
  return jsonRequest<Actor>("PATCH", `/actors/${encodeURIComponent(id)}`, patch);
}

export function archiveActor(id: string): Promise<{ archived: string }> {
  return jsonRequest<{ archived: string }>(
    "DELETE",
    `/actors/${encodeURIComponent(id)}`,
  );
}

// -- Responsibilities ---------------------------------------------------

export function createResponsibility(input: {
  node_id: string;
  title: string;
  description?: string;
  sort_order?: number;
  assignees?: string[];
}): Promise<DetailResponsibility> {
  return jsonRequest<DetailResponsibility>("POST", "/responsibilities", input);
}

export function updateResponsibility(
  id: string,
  patch: { title?: string; description?: string | null; sort_order?: number },
): Promise<DetailResponsibility> {
  return jsonRequest<DetailResponsibility>(
    "PATCH",
    `/responsibilities/${encodeURIComponent(id)}`,
    patch,
  );
}

export function deleteResponsibility(id: string): Promise<{ deleted: string }> {
  return jsonRequest<{ deleted: string }>(
    "DELETE",
    `/responsibilities/${encodeURIComponent(id)}`,
  );
}

export function assignResponsibility(
  responsibilityId: string,
  actorId: string,
): Promise<{ ok: true }> {
  return jsonRequest<{ ok: true }>(
    "POST",
    `/responsibilities/${encodeURIComponent(responsibilityId)}/assignments`,
    { actor_id: actorId },
  );
}

export function unassignResponsibility(
  responsibilityId: string,
  actorId: string,
): Promise<{ ok: true }> {
  return jsonRequest<{ ok: true }>(
    "DELETE",
    `/responsibilities/${encodeURIComponent(responsibilityId)}/assignments/${encodeURIComponent(actorId)}`,
  );
}

// -- Data sources -------------------------------------------------------

export function addDataSource(input: {
  node_id: string;
  name: string;
  description?: string;
  external_link?: string;
}): Promise<DetailDataSource> {
  return jsonRequest<DetailDataSource>("POST", "/data-sources", input);
}

export function updateDataSource(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    external_link?: string | null;
  },
): Promise<DetailDataSource> {
  return jsonRequest<DetailDataSource>(
    "PATCH",
    `/data-sources/${encodeURIComponent(id)}`,
    patch,
  );
}

export function removeDataSource(id: string): Promise<{ deleted: string }> {
  return jsonRequest<{ deleted: string }>(
    "DELETE",
    `/data-sources/${encodeURIComponent(id)}`,
  );
}

// -- Tools --------------------------------------------------------------

export function addTool(input: {
  node_id: string;
  name: string;
  description?: string;
  external_link?: string;
}): Promise<DetailTool> {
  return jsonRequest<DetailTool>("POST", "/tools", input);
}

export function updateTool(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    external_link?: string | null;
  },
): Promise<DetailTool> {
  return jsonRequest<DetailTool>(
    "PATCH",
    `/tools/${encodeURIComponent(id)}`,
    patch,
  );
}

export function removeTool(id: string): Promise<{ deleted: string }> {
  return jsonRequest<{ deleted: string }>(
    "DELETE",
    `/tools/${encodeURIComponent(id)}`,
  );
}

// -- File content + lifecycle ------------------------------------------

// Thrown by saveFileContent when the on-disk file changed since it was
// opened. Carries the current on-disk version so the UI can offer
// keep-mine (resend with force) / reload-theirs (re-fetch).
export class FileConflictError extends Error {
  constructor(readonly currentVersion: string) {
    super("file changed on disk since it was opened");
    this.name = "FileConflictError";
  }
}

export async function fetchFileContent(
  nodeId: string,
  relPath: string,
): Promise<FileContentResponse> {
  const res = await apiFetch(
    `/nodes/${encodeURIComponent(nodeId)}/file?path=${encodeURIComponent(relPath)}`,
  );
  await throwForStatus(res, "file content");
  return res.json();
}

export async function saveFileContent(
  nodeId: string,
  relPath: string,
  body: { content: string; baseVersion?: string; force?: boolean },
): Promise<{ version: string }> {
  const res = await apiFetch(
    `/nodes/${encodeURIComponent(nodeId)}/file?path=${encodeURIComponent(relPath)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (res.status === 501) {
    let isLocalOnly = false;
    try {
      const j = (await res.clone().json()) as { error?: string };
      if (j.error === "local_only") isLocalOnly = true;
    } catch {
      /* not JSON */
    }
    if (isLocalOnly) throw new LocalOnlyError();
  }
  if (res.status === 409) {
    // Both CONFLICT (stale base version) and NO_MIRROR map to 409 on the
    // backend. Only the former is an editor conflict the user can resolve
    // with keep-mine / reload-theirs; treat everything else as a plain error.
    const j = (await res.json().catch(() => ({}))) as {
      code?: string;
      currentVersion?: string;
      error?: string;
    };
    if (j.code === "CONFLICT" && j.currentVersion)
      throw new FileConflictError(j.currentVersion);
    throw new Error(j.error ?? `save: 409`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`save: ${res.status} ${text}`);
  }
  return res.json();
}

export function createFile(
  nodeId: string,
  input: { filename: string; section?: string; subpath?: string | null; content?: string },
): Promise<DetailFile> {
  return jsonRequest<DetailFile>(
    "POST",
    `/nodes/${encodeURIComponent(nodeId)}/files`,
    input,
  );
}

export function renameFile(
  nodeId: string,
  fileId: string,
  newFilename: string,
): Promise<unknown> {
  return jsonRequest(
    "POST",
    `/nodes/${encodeURIComponent(nodeId)}/files/${encodeURIComponent(fileId)}/rename`,
    { new_filename: newFilename },
  );
}

export function deleteFile(nodeId: string, fileId: string): Promise<unknown> {
  return jsonRequest(
    "DELETE",
    `/nodes/${encodeURIComponent(nodeId)}/files/${encodeURIComponent(fileId)}?confirmed=true`,
  );
}

// -- Sharing (node access) ----------------------------------------------

export async function fetchNodeAccess(id: string): Promise<NodeAccessResponse> {
  const res = await apiFetch(`/nodes/${encodeURIComponent(id)}/access`);
  await throwForStatus(res, "node-access");
  return res.json();
}

export function putNodeAccess(
  id: string,
  entries: NodeAccessEntryInput[],
  mode?: "private" | "request",
  visibility?: "team" | "private" | "group",
): Promise<NodeAccessResponse> {
  return jsonRequest<NodeAccessResponse>(
    "PUT",
    `/nodes/${encodeURIComponent(id)}/access`,
    { entries, mode, visibility },
  );
}

// Thrown by searchGroups when the backend is running in env auth mode,
// which has no Google Workspace directory to query (GET /auth/groups
// responds 501 { error: "google_mode_only" }). Callers should fall back to
// a users-only picker instead of showing an error banner.
export class GoogleModeOnlyError extends Error {
  constructor() {
    super("Skupiny nejsou dostupné mimo Google režim.");
    this.name = "GoogleModeOnlyError";
  }
}

export async function searchGroups(query: string): Promise<DirectoryGroup[]> {
  const res = await apiFetch(`/auth/groups?query=${encodeURIComponent(query)}`);
  if (res.status === 501) {
    let isGoogleModeOnly = false;
    try {
      const j = (await res.clone().json()) as { error?: string };
      if (j.error === "google_mode_only") isGoogleModeOnly = true;
    } catch {
      /* body not JSON -- fall through to the generic error below */
    }
    if (isGoogleModeOnly) throw new GoogleModeOnlyError();
  }
  await throwForStatus(res, "groups");
  const body = (await res.json()) as { groups: DirectoryGroup[] };
  return body.groups;
}

export async function fetchAccountUsers(): Promise<AccountUser[]> {
  const res = await apiFetch("/auth/users");
  await throwForStatus(res, "account-users");
  const body = (await res.json()) as { users: AccountUser[] };
  return body.users;
}

// Only the field the sharing UI needs (canManage = global_scope 'manage' |
// 'admin'). /me returns more (email, name, groups, via) but nothing else
// here consumes it yet.
export async function fetchMe(): Promise<{ global_scope: string }> {
  const res = await apiFetch("/me");
  await throwForStatus(res, "me");
  return res.json();
}

// GET /auth/users/admin (admin-only): full account list for the Nastavení >
// Uživatelé tab -- last_login_at, invited flag and resolved global_scope.
export async function fetchUsersAdmin(): Promise<UserAdmin[]> {
  const res = await apiFetch("/auth/users/admin");
  await throwForStatus(res, "users-admin");
  const body = (await res.json()) as { users: UserAdmin[] };
  return body.users;
}

// Thrown by inviteUser when the email is already registered (paired or
// previously invited) -- the server maps this to 409.
export class UserExistsError extends Error {
  constructor(email: string) {
    super(`Uživatel ${email} už existuje.`);
    this.name = "UserExistsError";
  }
}

// Thrown by inviteUser when the server rejects the email as malformed (400,
// zod's z.string().email() failing validation). The client already checks
// the format before POSTing, but this still covers races and any other
// 400 the endpoint might return -- surfaces the same Czech message instead
// of raw zod issue text.
export class InvalidEmailError extends Error {
  constructor() {
    super("Zadej platný e-mail.");
    this.name = "InvalidEmailError";
  }
}

// POST /auth/users/invite (admin-only): creates a placeholder user row so it
// can be granted access before the invitee's first login.
export async function inviteUser(
  email: string,
): Promise<{ id: string; email: string; name: string }> {
  const res = await apiFetch("/auth/users/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (res.status === 409) {
    throw new UserExistsError(email);
  }
  if (res.status === 400) {
    throw new InvalidEmailError();
  }
  await throwForStatus(res, "invite-user");
  return res.json();
}
