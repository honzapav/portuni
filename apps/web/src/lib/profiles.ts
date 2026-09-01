// CLI spawn profiles client bindings — thin wrappers around the Tauri
// `list_profiles` / `create_profile` / `update_profile` / `delete_profile` /
// `set_default_profile_for_org` commands (apps/desktop src/lib.rs). No-ops
// (or empty results) outside Tauri, same convention as lib/workspaces.ts —
// a plain browser build has no config.json to read.
//
// Spec: "Spawn UX" -- profiles (docs/superpowers/specs/
// 2026-08-31-scope-sessions-redesign-design.md). Zero registered profiles
// keeps the feature invisible everywhere else in the UI.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./backend-url";

export interface ProfileInfo {
  id: string;
  label: string;
  env: Record<string, string>;
  command: string | null;
}

export interface ProfilesData {
  profiles: ProfileInfo[];
  // organization node id -> profile id
  default_by_org: Record<string, string>;
}

const EMPTY_PROFILES: ProfilesData = { profiles: [], default_by_org: {} };

export async function listProfiles(): Promise<ProfilesData> {
  if (!isTauri()) return EMPTY_PROFILES;
  return invoke<ProfilesData>("list_profiles");
}

export interface CreateProfileArgs {
  id: string;
  label: string;
  env: Record<string, string>;
  command?: string;
}

export async function createProfile(args: CreateProfileArgs): Promise<void> {
  await invoke("create_profile", { args });
}

export interface UpdateProfileArgs {
  id: string;
  label: string;
  env: Record<string, string>;
  command?: string;
}

export async function updateProfile(args: UpdateProfileArgs): Promise<void> {
  await invoke("update_profile", { args });
}

export async function deleteProfile(id: string): Promise<void> {
  await invoke("delete_profile", { id });
}

export async function setDefaultProfileForOrg(
  orgId: string,
  profileId: string | null,
): Promise<void> {
  await invoke("set_default_profile_for_org", { orgId, profileId });
}

// Dispatched by every successful profile mutation so any open picker (the
// per-spawn dropdown) can refresh without a full page reload -- same
// convention as portuni:workspaces-changed.
export function notifyProfilesChanged(): void {
  window.dispatchEvent(new CustomEvent("portuni:profiles-changed"));
}
