// The runner lists as window-level resources (client traffic contract,
// rule 4): every mounted chat and the Settings tab used to ask for the
// runners, the instances, the models and the defaults on their own mount.
// Models and defaults are keyed by runner and instance (and the thread's
// own model for the defaults); the first defaults answer, which may have
// probed the runner, forgets that runner's models once so they are read
// again -- once per window, not per chat. The factory takes its fetchers
// so test/web-resources.test.ts can pin this without a server.

import { createKeyedResource, type KeyedResource } from "./resource";
import type { RunnerDefaultsInfo, RunnerModel } from "./runners";

const SEP = "|";

export function runnerModelsKey(runner: string, instanceId: string | null): string {
  return `${runner}${SEP}${instanceId ?? ""}${SEP}`;
}

export function runnerDefaultsKey(runner: string, instanceId: string | null, model: string | null): string {
  return `${runner}${SEP}${instanceId ?? ""}${SEP}${model ?? ""}`;
}

// The model is the rest of the key, so a model name may itself carry the
// separator.
export function splitRunnerKey(key: string): { runner: string; instanceId: string | null; model: string | null } {
  const first = key.indexOf(SEP);
  const second = key.indexOf(SEP, first + 1);
  const runner = key.slice(0, first);
  const instance = key.slice(first + 1, second);
  const model = key.slice(second + 1);
  return { runner, instanceId: instance === "" ? null : instance, model: model === "" ? null : model };
}

export type RunnerDefaultsValue = { defaults: RunnerDefaultsInfo | null };

export function createRunnerResources(deps: {
  fetchRunnerModels: (runner: string, instanceId: string | null) => Promise<RunnerModel[]>;
  fetchRunnerDefaults: (
    runner: string,
    instanceId: string | null,
    model: string | null,
  ) => Promise<RunnerDefaultsInfo | null>;
}): { runnerModels: KeyedResource<string, RunnerModel[]>; runnerDefaults: KeyedResource<string, RunnerDefaultsValue> } {
  const runnerModels = createKeyedResource<string, RunnerModel[]>((key) => {
    const { runner, instanceId } = splitRunnerKey(key);
    return deps.fetchRunnerModels(runner, instanceId);
  });
  const runnerDefaults = createKeyedResource<string, RunnerDefaultsValue>(async (key) => {
    const { runner, instanceId, model } = splitRunnerKey(key);
    const defaults = await deps.fetchRunnerDefaults(runner, instanceId, model);
    runnerModels.invalidate(runnerModelsKey(runner, instanceId));
    return { defaults };
  });
  return { runnerModels, runnerDefaults };
}
