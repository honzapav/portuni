// The window's shared resources (client traffic contract, rule 4): the
// runner lists are keyed so one window asks once per runner and instance,
// and a defaults answer (which may have probed the runner) re-reads that
// runner's models once -- per window, not per mounted chat.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRunnerResources,
  runnerDefaultsKey,
  runnerModelsKey,
  splitRunnerKey,
} from "../apps/web/src/lib/runner-resources.js";
import type { RunnerDefaultsInfo, RunnerModel } from "../apps/web/src/lib/runners.js";

describe("runner resource keys", () => {
  it("round-trip runner, instance and model, with a model that contains the separator", () => {
    assert.deepEqual(splitRunnerKey(runnerModelsKey("claude", null)), { runner: "claude", instanceId: null, model: null });
    assert.deepEqual(splitRunnerKey(runnerModelsKey("claude", "01INST")), { runner: "claude", instanceId: "01INST", model: null });
    assert.deepEqual(splitRunnerKey(runnerDefaultsKey("claude", null, "a|b")), { runner: "claude", instanceId: null, model: "a|b" });
  });
});

describe("createRunnerResources", () => {
  it("fetches models once per runner and instance, and once more after the first defaults answer", async () => {
    const modelCalls: string[] = [];
    const defaultsCalls: string[] = [];
    const { runnerModels, runnerDefaults } = createRunnerResources({
      fetchRunnerModels: (runner, instanceId) => {
        modelCalls.push(`${runner}|${instanceId ?? ""}`);
        return Promise.resolve([{ id: "m1" }] as RunnerModel[]);
      },
      fetchRunnerDefaults: (runner, instanceId, model) => {
        defaultsCalls.push(`${runner}|${instanceId ?? ""}|${model ?? ""}`);
        return Promise.resolve({ model: "m1" } as unknown as RunnerDefaultsInfo);
      },
    });
    const key = runnerModelsKey("claude", null);
    await runnerModels.get(key);
    await runnerModels.get(key);
    assert.deepEqual(modelCalls, ["claude|"]);
    const d = await runnerDefaults.get(runnerDefaultsKey("claude", null, null));
    assert.deepEqual(d, { defaults: { model: "m1" } });
    assert.equal(runnerModels.peek(key), null, "the defaults answer forgets the models it may have changed");
    await runnerModels.get(key);
    assert.deepEqual(modelCalls, ["claude|", "claude|"]);
    await runnerDefaults.get(runnerDefaultsKey("claude", null, null));
    assert.equal(defaultsCalls.length, 1);
  });

  it("a null defaults answer is stored, not reloaded forever", async () => {
    const { runnerDefaults } = createRunnerResources({
      fetchRunnerModels: () => Promise.resolve([]),
      fetchRunnerDefaults: () => Promise.resolve(null),
    });
    const key = runnerDefaultsKey("claude", null, null);
    await runnerDefaults.get(key);
    assert.deepEqual(runnerDefaults.peek(key), { defaults: null });
  });
});
