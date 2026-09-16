// REST wrappers for the runner registry (GET /runners) and provider
// instances (GET/POST/PATCH/DELETE /runners/instances, PUT .../org-default)
// -- apps/server/domain/runner/{registry,instances}.ts (#319). Unlike
// lib/profiles.ts (Tauri invoke, desktop-only), this goes over the REST
// jsonRequest/api_request plumbing like the rest of api.ts, since the
// registry now lives on the sidecar, reachable the same way from any
// client -- not just the desktop shell.

import { jsonRequest } from "../api";
import type { RunnerInfo, RunnerInstanceSummary, RunnerModel } from "../../../server/shared/api-types";
import { isPortuniEnvKey, isSecretShapedEnvKey } from "../../../server/shared/runner-env";

export type { RunnerInfo, RunnerInstanceSummary, RunnerModel };
export { isPortuniEnvKey, isSecretShapedEnvKey };

export async function listRunners(): Promise<RunnerInfo[]> {
  const res = await jsonRequest<{ runners: RunnerInfo[] }>("GET", "/runners");
  return res.runners;
}

// #376: the model picker's list -- GET /runners/:runner/models. Before any
// task has run under this runner in this process, the server answers the
// documented aliases (plus free text is the caller's own job to allow).
export async function fetchRunnerModels(runner: string): Promise<RunnerModel[]> {
  const res = await jsonRequest<{ models: RunnerModel[] }>("GET", `/runners/${encodeURIComponent(runner)}/models`);
  return res.models;
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

export function clearRunnerOrgDefault(orgId: string): Promise<{ ok: true }> {
  return jsonRequest<{ ok: true }>("DELETE", `/runners/org-defaults/${encodeURIComponent(orgId)}`);
}

// --- Pure form helpers (test/runners-form-helpers.test.ts) -----------------
//
// The key rules come from apps/server/shared/runner-env.ts, the same module
// the server enforces with (INSTANCE_ENV_KEY_REFUSED) -- this is only a
// friendlier, immediate echo before the round trip.

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
// what actually changes it; the form lists the existing keys as
// "(nastaveno)" next to the textarea.
export function envKeysToText(keys: readonly string[]): string {
  return keys.map((k) => `${k}=`).join("\n");
}
