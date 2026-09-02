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
  // Key names only -- env VALUES never leave the Rust process (#207: "no
  // secret in webview JS, ever" applies here too, since this registry has
  // no way to enforce that a value someone pastes in isn't one). Editing an
  // existing profile is therefore a partial update: update_profile treats
  // an empty submitted value for a key that already exists as "leave
  // unchanged" (see ProfilesSection.tsx).
  env_keys: string[];
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

// Narrow, purpose-built exception to "profile env values never reach the
// webview" (#207): the one legitimate consumer of a value is the resume-info
// check (DetailPane.sessions.tsx, #204), which needs CLAUDE_CONFIG_DIR --
// a plain directory path, never secret-shaped -- to ask the sidecar about
// conversation-resumability at the right transcript location. Returns null
// outside Tauri, for an unknown profile, or when the profile sets no
// CLAUDE_CONFIG_DIR.
export async function getProfileConfigDir(id: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("profile_config_dir", { id });
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
