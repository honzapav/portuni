// Provider instances registry (spec: "instances.ts"). Today's desktop CLI
// spawn profiles (apps/desktop/src/workspace.rs's ProfileConfig, six Tauri
// commands) move here: runs are started by the server now, so the registry
// has to be reachable from it. The desktop side is untouched until phase 4
// removes it.
//
// Persisted in <dataDir>/runners.json (PORTUNI_DATA_DIR; the standalone
// server, which has no PORTUNI_DATA_DIR, keeps it next to the DB -- same
// default as TURSO_URL's file:./portuni.db, i.e. process.cwd()). Same
// rules as the desktop registry: secret-shaped keys and PORTUNI_* keys are
// refused outright, `~` expands to $HOME (at read time, not on disk), and
// env values never come back from listInstances -- only env_keys.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { isPortuniEnvKey, isSecretShapedEnvKey } from "../../shared/runner-env.js";

export interface StoredInstance {
  id: string;
  name: string;
  runner: string;
  env: Record<string, string>;
  // Organization node ids this instance is the default for. Membership is
  // exclusive across instances -- setOrgDefault removes an org from every
  // other instance's list before adding it here.
  org_defaults: string[];
}

interface InstancesFile {
  instances: StoredInstance[];
}

export interface PublicInstance {
  id: string;
  name: string;
  runner: string;
  env_keys: string[];
  org_defaults: string[];
}

export interface CreateInstanceInput {
  name: string;
  runner: string;
  env?: Record<string, string>;
}

export interface UpdateInstanceInput {
  name?: string;
  runner?: string;
  env?: Record<string, string>;
}

// Key rules live in shared/runner-env.ts (the web form echoes them).
export class InstanceEnvKeyRefusedError extends Error {
  readonly code = "INSTANCE_ENV_KEY_REFUSED" as const;
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`Klíč prostředí '${key}' byl odmítnut: ${reason}`);
    this.name = "InstanceEnvKeyRefusedError";
  }
}

function assertValidEnvKeys(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (isSecretShapedEnvKey(key)) {
      throw new InstanceEnvKeyRefusedError(
        key,
        "vypadá jako secret (*_TOKEN/*_KEY/*_SECRET/*PASSWORD*) – ulož jej do OS klíčenky, ne do registru instancí",
      );
    }
    if (isPortuniEnvKey(key)) {
      throw new InstanceEnvKeyRefusedError(key, "PORTUNI_* proměnné nelze nastavit z registru instancí");
    }
  }
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function resolveDataDir(): string {
  const explicit = process.env.PORTUNI_DATA_DIR;
  return explicit && explicit.trim() !== "" ? explicit : process.cwd();
}

function instancesFilePath(dataDir: string | undefined): string {
  return join(dataDir ?? resolveDataDir(), "runners.json");
}

async function loadInstancesFile(dataDir: string | undefined): Promise<InstancesFile> {
  const path = instancesFilePath(dataDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { instances: [] };
    throw err;
  }
  if (raw.trim() === "") return { instances: [] };
  const parsed = JSON.parse(raw) as Partial<InstancesFile>;
  return { instances: parsed.instances ?? [] };
}

// Atomic write: temp file in the same directory, then rename over -- same
// pattern as apps/desktop/src/workspace.rs's save().
async function saveInstancesFile(file: InstancesFile, dataDir: string | undefined): Promise<void> {
  const dir = dataDir ?? resolveDataDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, "runners.json");
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
  await rename(tmp, path);
}

function toPublicInstance(row: StoredInstance): PublicInstance {
  return { id: row.id, name: row.name, runner: row.runner, env_keys: Object.keys(row.env), org_defaults: row.org_defaults };
}

export async function listInstances(dataDir?: string): Promise<PublicInstance[]> {
  const file = await loadInstancesFile(dataDir);
  return file.instances.map(toPublicInstance);
}

// Server-side only: never exposed over REST. The adapter's env composition
// reads this to build a run's environment.
export async function getInstanceEnv(id: string, dataDir?: string): Promise<Record<string, string> | null> {
  const file = await loadInstancesFile(dataDir);
  const row = file.instances.find((i) => i.id === id);
  if (!row) return null;
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.env)) {
    expanded[key] = expandTilde(value);
  }
  return expanded;
}

export async function createInstance(input: CreateInstanceInput, dataDir?: string): Promise<PublicInstance> {
  const name = input.name.trim();
  if (name === "") throw new Error("createInstance: name is required");
  const runner = input.runner.trim();
  if (runner === "") throw new Error("createInstance: runner is required");
  const env = input.env ?? {};
  assertValidEnvKeys(env);

  const file = await loadInstancesFile(dataDir);
  const id = ulid();
  const row: StoredInstance = { id, name, runner, env, org_defaults: [] };
  file.instances.push(row);
  await saveInstancesFile(file, dataDir);
  return toPublicInstance(row);
}

// An empty submitted value for a key that already exists means "leave
// unchanged" (the webview never receives values back to resubmit them
// verbatim); a key omitted from `submitted` entirely is dropped. Mirrors
// apps/desktop/src/lib.rs's merge_profile_env_update.
function mergeEnvUpdate(stored: Record<string, string>, submitted: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(submitted)) {
    merged[key] = value === "" && key in stored ? stored[key] : value;
  }
  return merged;
}

export async function updateInstance(
  id: string,
  input: UpdateInstanceInput,
  dataDir?: string,
): Promise<PublicInstance> {
  const file = await loadInstancesFile(dataDir);
  const row = file.instances.find((i) => i.id === id);
  if (!row) throw new Error(`updateInstance: unknown instance '${id}'`);

  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed === "") throw new Error("updateInstance: name is required");
    row.name = trimmed;
  }
  if (input.runner !== undefined) {
    const trimmed = input.runner.trim();
    if (trimmed === "") throw new Error("updateInstance: runner is required");
    row.runner = trimmed;
  }
  if (input.env !== undefined) {
    assertValidEnvKeys(input.env);
    row.env = mergeEnvUpdate(row.env, input.env);
  }

  await saveInstancesFile(file, dataDir);
  return toPublicInstance(row);
}

export async function deleteInstance(id: string, dataDir?: string): Promise<void> {
  const file = await loadInstancesFile(dataDir);
  const idx = file.instances.findIndex((i) => i.id === id);
  if (idx === -1) throw new Error(`deleteInstance: unknown instance '${id}'`);
  file.instances.splice(idx, 1);
  await saveInstancesFile(file, dataDir);
}

// instanceId: null clears orgId's default (no instance is the default for
// it); otherwise orgId is removed from every OTHER instance's org_defaults
// first, so at most one instance is ever the default for a given org.
export async function setOrgDefault(orgId: string, instanceId: string | null, dataDir?: string): Promise<void> {
  const file = await loadInstancesFile(dataDir);
  if (instanceId !== null && !file.instances.some((i) => i.id === instanceId)) {
    throw new Error(`setOrgDefault: unknown instance '${instanceId}'`);
  }
  for (const row of file.instances) {
    row.org_defaults = row.org_defaults.filter((o) => o !== orgId);
  }
  if (instanceId !== null) {
    const row = file.instances.find((i) => i.id === instanceId);
    if (row) row.org_defaults.push(orgId);
  }
  await saveInstancesFile(file, dataDir);
}
