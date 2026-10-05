// REST endpoints for the runner registry and provider instances (#319,
// docs/superpowers/specs/2026-09-12-runner-and-session-design.md):
//
//   GET    /runners                          read   -> detected adapters + availability
//   GET    /runners/:runner/models            read   -> the picker's list (#376)
//   GET    /runners/:runner/defaults          read   -> default model/effort and their source
//   GET    /runners/instances                read   -> provider instances (no env values)
//   POST   /runners/instances                write  -> create an instance
//   PATCH  /runners/instances/:id            write  -> update (partial; empty env value = unchanged)
//   DELETE /runners/instances/:id            admin  -> delete
//   PUT    /runners/instances/:id/org-default write -> set this instance as an org's default
//   DELETE /runners/org-defaults/:orgId      write -> clear an org's default
//   GET    /hosts/local                      read   -> this device's host id and label (#578)
//
// No ownership model here (unlike sessions): the registry is one shared,
// device-wide file, same as the desktop's old config.json profiles
// registry. Device-wide also means device-LOCAL: in agent mode the desktop
// routes every /runners* call to the sidecar (lib.rs's is_device_local_path,
// agent-router.ts), never to central.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { parseJsonBody, respondApiError, respondError, respondJson } from "../http/middleware.js";
import { detectAll, getAdapter } from "../domain/runner/registry.js";
import { EFFORT_LEVELS } from "../domain/runner/types.js";
import { localHostInfo } from "../domain/runner/hosts.js";
import {
  InstanceDefaultsKeyRefusedError,
  InstanceEnvKeyRefusedError,
  createInstance,
  deleteInstance,
  getInstanceDefaults,
  getInstanceEnv,
  listInstances,
  setOrgDefault,
  updateInstance,
} from "../domain/runner/instances.js";
import type { LocalHostInfo, RunnerDefaults, RunnerInfo, RunnerInstanceSummary } from "../shared/api-types.js";

function respondInstanceError(res: ServerResponse, ctx: string, err: unknown): void {
  if (err instanceof InstanceEnvKeyRefusedError || err instanceof InstanceDefaultsKeyRefusedError) {
    respondApiError(res, 400, err.code, err.message, err.params);
    return;
  }
  respondError(res, ctx, err);
}

export async function handleListRunners(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const runners: RunnerInfo[] = await detectAll();
    respondJson(res, 200, { runners });
  } catch (err) {
    respondError(res, `${req.method} /runners`, err);
  }
}

// GET /hosts/local (#578): the host the runners here run on. Device-local
// like the registry: in a team workspace the central server never loaded
// this device's identity, so the summaries it answers carry the device's id
// and no label; the web names its own threads from this answer.
export function handleGetLocalHost(res: ServerResponse): void {
  const body: LocalHostInfo = localHostInfo();
  respondJson(res, 200, body);
}

// #376: the model picker's list -- device-local like every other /runners*
// route (lib.rs's is_device_local_path already matches on the /runners/
// prefix). 404 for an unregistered runner id, same tier as the instance
// routes below (no ownership model, read scope).
export async function handleListRunnerModels(
  req: IncomingMessage,
  res: ServerResponse,
  runnerId: string,
): Promise<void> {
  try {
    const adapter = getAdapter(runnerId);
    if (!adapter) {
      respondApiError(res, 404, "UNKNOWN_RUNNER", `unknown runner '${runnerId}'`, { runner: runnerId });
      return;
    }
    const models = await adapter.models();
    respondJson(res, 200, { models });
  } catch (err) {
    respondError(res, `${req.method} /runners/${runnerId}/models`, err);
  }
}

// GET /runners/:runner/defaults?instance=<id>&model=<id>: what a thread on
// that instance runs on when it names no model or effort of its own, with
// the source of each value -- the composer shows it before the first run.
// `model` is the thread's own model (the effort default depends on it).
// Device-local like the rest of /runners*: the instance env and the
// runner's settings file are this device's. A runner without the method
// answers `defaults: null`.
export async function handleGetRunnerDefaults(
  req: IncomingMessage,
  res: ServerResponse,
  runnerId: string,
  url: URL,
): Promise<void> {
  try {
    const adapter = getAdapter(runnerId);
    if (!adapter) {
      respondApiError(res, 404, "UNKNOWN_RUNNER", `unknown runner '${runnerId}'`, { runner: runnerId });
      return;
    }
    if (!adapter.defaults) {
      respondJson(res, 200, { defaults: null });
      return;
    }
    const instanceId = url.searchParams.get("instance") || null;
    const model = url.searchParams.get("model") || null;
    const instanceEnv = instanceId ? ((await getInstanceEnv(instanceId)) ?? {}) : {};
    const instanceDefaults = instanceId ? await getInstanceDefaults(instanceId) : null;
    const defaults: RunnerDefaults = await adapter.defaults({ model, instanceEnv, instanceDefaults });
    respondJson(res, 200, { defaults });
  } catch (err) {
    respondError(res, `${req.method} /runners/${runnerId}/defaults`, err);
  }
}

export async function handleListRunnerInstances(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const instances: RunnerInstanceSummary[] = await listInstances();
    respondJson(res, 200, { instances });
  } catch (err) {
    respondError(res, `${req.method} /runners/instances`, err);
  }
}

const EnvMap = z.record(z.string(), z.string());
const InstanceDefaults = z.object({
  model: z.string().optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});

const CreateInstanceBody = z.object({
  name: z.string().trim().min(1).max(200),
  runner: z.string().trim().min(1),
  env: EnvMap.optional(),
  defaults: InstanceDefaults.optional(),
});

export async function handleCreateRunnerInstance(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await parseJsonBody(req, res, CreateInstanceBody);
    if (!body) return;
    const created = await createInstance({
      name: body.name,
      runner: body.runner,
      env: body.env,
      defaults: body.defaults,
    });
    respondJson(res, 201, created);
  } catch (err) {
    respondInstanceError(res, `${req.method} /runners/instances`, err);
  }
}

async function findInstance(id: string): Promise<RunnerInstanceSummary | null> {
  const instances = await listInstances();
  return instances.find((i) => i.id === id) ?? null;
}

// False, with the 404 already sent, when no instance has this id.
async function requireInstance(res: ServerResponse, instanceId: string): Promise<boolean> {
  if (await findInstance(instanceId)) return true;
  respondApiError(res, 404, "INSTANCE_NOT_FOUND", "instance not found", { instanceId });
  return false;
}

const UpdateInstanceBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  runner: z.string().trim().min(1).optional(),
  env: EnvMap.optional(),
  defaults: InstanceDefaults.optional(),
});

export async function handleUpdateRunnerInstance(
  req: IncomingMessage,
  res: ServerResponse,
  instanceId: string,
): Promise<void> {
  try {
    if (!(await requireInstance(res, instanceId))) return;
    const body = await parseJsonBody(req, res, UpdateInstanceBody);
    if (!body) return;
    const updated = await updateInstance(instanceId, body);
    respondJson(res, 200, updated);
  } catch (err) {
    respondInstanceError(res, `${req.method} /runners/instances/${instanceId}`, err);
  }
}

export async function handleDeleteRunnerInstance(
  req: IncomingMessage,
  res: ServerResponse,
  instanceId: string,
): Promise<void> {
  try {
    if (!(await requireInstance(res, instanceId))) return;
    await deleteInstance(instanceId);
    respondJson(res, 200, { deleted: true });
  } catch (err) {
    respondError(res, `${req.method} /runners/instances/${instanceId}`, err);
  }
}

const OrgDefaultBody = z.object({
  org_id: z.string().trim().min(1),
});

export async function handleSetRunnerInstanceOrgDefault(
  req: IncomingMessage,
  res: ServerResponse,
  instanceId: string,
): Promise<void> {
  try {
    if (!(await requireInstance(res, instanceId))) return;
    const body = await parseJsonBody(req, res, OrgDefaultBody);
    if (!body) return;
    await setOrgDefault(body.org_id, instanceId);
    respondJson(res, 200, { ok: true });
  } catch (err) {
    respondError(res, `${req.method} /runners/instances/${instanceId}/org-default`, err);
  }
}

export async function handleClearRunnerOrgDefault(
  req: IncomingMessage,
  res: ServerResponse,
  orgId: string,
): Promise<void> {
  try {
    await setOrgDefault(orgId, null);
    respondJson(res, 200, { ok: true });
  } catch (err) {
    respondError(res, `${req.method} /runners/org-defaults/${orgId}`, err);
  }
}
