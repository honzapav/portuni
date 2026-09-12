// REST wrappers for the runner registry (GET /runners) and provider
// instances (GET/POST/PATCH/DELETE /runners/instances, PUT .../org-default)
// -- apps/server/domain/runner/{registry,instances}.ts (#319). Unlike
// lib/profiles.ts (Tauri invoke, desktop-only), this goes over the REST
// jsonRequest/api_request plumbing like the rest of api.ts, since the
// registry now lives on the sidecar, reachable the same way from any
// client -- not just the desktop shell.

import { jsonRequest } from "../api";

export interface RunnerAvailability {
  installed: boolean;
  version: string | null;
  logged_in: boolean;
  instances_supported: boolean;
}

export interface RunnerInfo {
  id: string;
  availability: RunnerAvailability;
}

export interface RunnerInstanceSummary {
  id: string;
  name: string;
  runner: string;
  env_keys: string[];
  org_defaults: string[];
}

export async function listRunners(): Promise<RunnerInfo[]> {
  const res = await jsonRequest<{ runners: RunnerInfo[] }>("GET", "/runners");
  return res.runners;
}

export async function listRunnerInstances(): Promise<RunnerInstanceSummary[]> {
  const res = await jsonRequest<{ instances: RunnerInstanceSummary[] }>("GET", "/runners/instances");
  return res.instances;
}

export function createRunnerInstance(input: {
  name: string;
  runner: string;
  env?: Record<string, string>;
}): Promise<RunnerInstanceSummary> {
  return jsonRequest<RunnerInstanceSummary>("POST", "/runners/instances", input);
}

export function updateRunnerInstance(
  id: string,
  patch: { name?: string; runner?: string; env?: Record<string, string> },
): Promise<RunnerInstanceSummary> {
  return jsonRequest<RunnerInstanceSummary>("PATCH", `/runners/instances/${encodeURIComponent(id)}`, patch);
}

export function deleteRunnerInstance(id: string): Promise<{ deleted: true }> {
  return jsonRequest<{ deleted: true }>("DELETE", `/runners/instances/${encodeURIComponent(id)}`);
}

export function setRunnerInstanceOrgDefault(id: string, orgId: string): Promise<{ ok: true }> {
  return jsonRequest<{ ok: true }>("PUT", `/runners/instances/${encodeURIComponent(id)}/org-default`, {
    org_id: orgId,
  });
}

// --- Pure form helpers (test/runners-form-helpers.test.ts) -----------------
//
// Mirrors apps/server/domain/runner/instances.ts's isSecretShapedEnvKey and
// PORTUNI_* refusal so the form can reject an obviously-bad key before the
// round trip that would come back as INSTANCE_ENV_KEY_REFUSED -- the server
// stays the actual enforcement point; this is only a friendlier, immediate
// echo of the same rule.

export function isSecretShapedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return upper.endsWith("_TOKEN") || upper.endsWith("_KEY") || upper.endsWith("_SECRET") || upper.includes("PASSWORD");
}

export function isPortuniEnvKey(key: string): boolean {
  return key.toUpperCase().startsWith("PORTUNI_");
}

// Returns a human message for the first refused key found, or null when
// every key is fine to submit.
export function validateEnvKeys(env: Record<string, string>): string | null {
  for (const key of Object.keys(env)) {
    if (isSecretShapedEnvKey(key)) {
      return `'${key}' vypadá jako secret (*_TOKEN/*_KEY/*_SECRET/*PASSWORD*) — ulož ho do OS klíčenky, ne sem.`;
    }
    if (isPortuniEnvKey(key)) {
      return `'${key}': proměnné PORTUNI_* nelze nastavit z registru instancí.`;
    }
  }
  return null;
}

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// list/getRunnerInstances never sends env VALUES back -- editing an
// existing instance pre-fills each known key with an empty value instead.
// The server (updateInstance's mergeEnvUpdate) treats an empty value for a
// key that already exists as "leave unchanged"; typing a new value there is
// what actually changes it. Mirrors apps/web/src/components/
// ProfilesSection.tsx's envKeysToText exactly.
export function envKeysToText(keys: readonly string[]): string {
  return keys.map((k) => `${k}=`).join("\n");
}
