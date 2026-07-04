// Multi-workspace client bindings — thin wrappers around the Tauri
// `list_workspaces` / `create_workspace` / `set_active_workspace` /
// `set_workspace_enabled` / `delete_workspace` commands (apps/desktop
// src/lib.rs). No-ops (or empty results) outside Tauri — a plain browser
// build has no workspace concept.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./backend-url";

export interface WorkspaceInfo {
  id: string;
  label: string;
  data_mode: "local" | "central";
  enabled: boolean;
  mcp_port: number | null;
  active: boolean;
  running: boolean;
  // True when this workspace's central sync agent is deferred (not logged
  // in yet) rather than simply stopped -- see BackendPorts' sentinel port 0
  // in apps/desktop/src/lib.rs.
  deferred: boolean;
  mcp_server_name: string;
  workspace_root: string;
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  if (!isTauri()) return [];
  return invoke<WorkspaceInfo[]>("list_workspaces");
}

export async function switchWorkspace(id: string): Promise<void> {
  await invoke("set_active_workspace", { id });
  // Full reload: every cached module-level state (data mode, backend port,
  // graph queries) belongs to the previous workspace.
  window.location.reload();
}

export interface CreateWorkspaceArgs {
  id: string;
  label?: string;
  data_mode: "local" | "central";
  turso_url?: string;
  server_url?: string;
  google_client_id?: string;
  google_client_secret?: string;
  workspace_root: string;
}

export async function createWorkspace(args: CreateWorkspaceArgs): Promise<void> {
  await invoke("create_workspace", { args });
}

export async function setWorkspaceEnabled(id: string, enabled: boolean): Promise<void> {
  await invoke("set_workspace_enabled", { id, enabled });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await invoke("delete_workspace", { id });
}

export async function restartWorkspace(id: string): Promise<void> {
  await invoke("restart_sidecar", { id });
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32);
}
