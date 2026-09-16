// REST endpoints for the runner registry and provider instances (#319,
// docs/superpowers/specs/2026-09-12-runner-and-session-design.md):
//
//   GET    /runners                          read   -> detected adapters + availability
//   GET    /runners/instances                read   -> provider instances (no env values)
//   POST   /runners/instances                write  -> create an instance
//   PATCH  /runners/instances/:id            write  -> update (partial; empty env value = unchanged)
//   DELETE /runners/instances/:id            admin  -> delete
//   PUT    /runners/instances/:id/org-default write -> set this instance as an org's default
//   DELETE /runners/org-defaults/:orgId      write -> clear an org's default
//
// No ownership model here (unlike sessions): the registry is one shared,
// device-wide file, same as the desktop's old config.json profiles
// registry. Device-wide also means device-LOCAL: in agent mode the desktop
// routes every /runners* call to the sidecar (lib.rs's is_local_only_path,
// agent-router.ts), never to central.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { parseJsonBody, respondError, respondJson } from "../http/middleware.js";
import { detectAll } from "../domain/runner/registry.js";
import { EFFORT_LEVELS } from "../domain/runner/types.js";
import {
  InstanceDefaultsKeyRefusedError,
  InstanceEnvKeyRefusedError,
  createInstance,
  deleteInstance,
  listInstances,
  setOrgDefault,
  updateInstance,
} from "../domain/runner/instances.js";
import type { RunnerInfo, RunnerInstanceSummary } from "../shared/api-types.js";

function respondInstanceError(res: ServerResponse, ctx: string, err: unknown): void {
  if (err instanceof InstanceEnvKeyRefusedError || err instanceof InstanceDefaultsKeyRefusedError) {
    respondJson(res, 400, { error: err.message, code: err.code });
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
    if (!(await findInstance(instanceId))) {
      respondJson(res, 404, { error: "instance not found" });
      return;
    }
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
    if (!(await findInstance(instanceId))) {
      respondJson(res, 404, { error: "instance not found" });
      return;
    }
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
    if (!(await findInstance(instanceId))) {
      respondJson(res, 404, { error: "instance not found" });
      return;
    }
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
