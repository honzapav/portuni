import type { GraphPayload, NodeDetail } from "./types";

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
  patch: { name?: string; description?: string | null },
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
