import type {
  GraphPayload,
  NodeDetail,
  DetailResponsibility,
  DetailDataSource,
  DetailTool,
  SyncStatusResponse,
  SyncRunResponse,
  SyncPendingResponse,
  DetailFile,
  FileContentResponse,
} from "./types";
import { apiFetch } from "./lib/backend-url";

// User shape returned by GET /users. Used by the Actors page to pick a
// user_id when creating/editing a real (non-placeholder) person actor.
export type User = {
  id: string;
  email: string;
  name: string;
};

export async function fetchUsers(): Promise<User[]> {
  const res = await apiFetch("/users");
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

// Thrown when the backend returns 501 local_only — the operation is not
// available in central mode. Components can catch this specific type to
// show the friendly modal instead of a generic error toast.
export class LocalOnlyError extends Error {
  constructor() {
    super("Dostupné jen v lokálním režimu (fáze B).");
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
