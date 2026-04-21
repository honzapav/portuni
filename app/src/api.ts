import type {
  GraphPayload,
  NodeDetail,
  DetailResponsibility,
  DetailDataSource,
  DetailTool,
} from "./types";

// Actor shape returned by GET /actors. Mirrors the DB row; separate from
// NodeDetail's assignee shape (which is narrower — just id/name/type).
export type Actor = {
  id: string;
  org_id: string;
  type: "person" | "automation";
  name: string;
  description: string | null;
  is_placeholder: number;
  user_id: string | null;
  notes: string | null;
  external_id: string | null;
};

const BASE = "/api";

export async function fetchGraph(): Promise<GraphPayload> {
  const res = await fetch(`${BASE}/graph`);
  if (!res.ok) throw new Error(`graph: ${res.status}`);
  return res.json();
}

export async function fetchNode(id: string): Promise<NodeDetail> {
  const res = await fetch(`${BASE}/nodes/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`node: ${res.status}`);
  return res.json();
}

async function jsonRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path}: ${res.status} ${text}`);
  }
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
  },
): Promise<NodeDetail> {
  return jsonRequest<NodeDetail>(
    "PATCH",
    `/nodes/${encodeURIComponent(id)}`,
    patch,
  );
}

export function createNode(input: {
  type: string;
  name: string;
  description?: string;
}): Promise<NodeDetail> {
  return jsonRequest<NodeDetail>("POST", "/nodes", input);
}

export function archiveNode(id: string): Promise<{ archived: string }> {
  return jsonRequest<{ archived: string }>(
    "DELETE",
    `/nodes/${encodeURIComponent(id)}`,
  );
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
  org_id?: string;
  type?: "person" | "automation";
  is_placeholder?: boolean;
}): Promise<Actor[]> {
  const qs = new URLSearchParams();
  if (params?.org_id) qs.set("org_id", params.org_id);
  if (params?.type) qs.set("type", params.type);
  if (params?.is_placeholder !== undefined) {
    qs.set("is_placeholder", params.is_placeholder ? "1" : "0");
  }
  const res = await fetch(`${BASE}/actors?${qs}`);
  if (!res.ok) throw new Error(`actors: ${res.status}`);
  return res.json();
}

export function createActor(input: {
  org_id: string;
  type: "person" | "automation";
  name: string;
  description?: string;
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
    description?: string | null;
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

export function removeTool(id: string): Promise<{ deleted: string }> {
  return jsonRequest<{ deleted: string }>(
    "DELETE",
    `/tools/${encodeURIComponent(id)}`,
  );
}
