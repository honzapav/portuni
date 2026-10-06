// What a Claude thread without its own model or effort runs on, and where
// that comes from (domain/runner/claude-defaults.ts, the adapter's
// defaults()): the composer names both before the first run.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { claudeModelDefaultEffort, resolveClaudeDefaults } from "../apps/server/domain/runner/claude-defaults.js";
import { createClaudeAdapter } from "../apps/server/domain/runner/adapters/claude.js";
import type { RunnerModel } from "../apps/server/domain/runner/types.js";

const MODELS: RunnerModel[] = [
  {
    id: "default",
    displayName: "Default (recommended)",
    description: "Opus 5.5",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    resolvedModel: "claude-opus-5-5",
  },
  { id: "sonnet", displayName: "Sonnet", description: "", supportsEffort: true, effortLevels: ["low", "high"], resolvedModel: "claude-sonnet-5" },
  { id: "haiku", displayName: "Haiku", description: "", supportsEffort: false, effortLevels: [], resolvedModel: "claude-haiku-4-5" },
];

const base = {
  model: null,
  instanceEnv: {},
  instanceDefaults: null,
  settings: null,
  settingsPath: "/home/u/.claude/settings.json",
  models: MODELS,
};

describe("resolveClaudeDefaults", () => {
  it("with nothing set: the account's default model from the runner's list and that model's own effort", () => {
    assert.deepEqual(resolveClaudeDefaults(base), {
      model: { value: "claude-opus-5-5", source: "account", detail: null },
      effort: { value: "medium", source: "model", detail: null },
    });
  });

  it("a model in the settings file wins over the account's, and names the file", () => {
    const d = resolveClaudeDefaults({ ...base, settings: { model: "sonnet" } });
    assert.deepEqual(d.model, { value: "sonnet", source: "settings", detail: "/home/u/.claude/settings.json" });
    assert.deepEqual(d.effort, { value: "high", source: "model", detail: null });
  });

  it("ANTHROPIC_MODEL wins over the settings file; the instance's own default wins over both", () => {
    const env = { ANTHROPIC_MODEL: "haiku" };
    assert.deepEqual(resolveClaudeDefaults({ ...base, instanceEnv: env, settings: { model: "sonnet" } }).model, {
      value: "haiku",
      source: "env",
      detail: "ANTHROPIC_MODEL",
    });
    assert.deepEqual(
      resolveClaudeDefaults({ ...base, instanceEnv: env, instanceDefaults: { model: "opus" }, settings: { model: "sonnet" } }).model,
      { value: "opus", source: "instance", detail: null },
    );
  });

  it("an effort set in the settings file is the default, the model's own entry before the top-level key", () => {
    const settings = { effortLevel: "low", modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" } } };
    assert.deepEqual(resolveClaudeDefaults({ ...base, settings }).effort, {
      value: "xhigh",
      source: "settings",
      detail: "/home/u/.claude/settings.json",
    });
    assert.deepEqual(resolveClaudeDefaults({ ...base, model: "sonnet", settings }).effort, {
      value: "low",
      source: "settings",
      detail: "/home/u/.claude/settings.json",
    });
  });

  it("CLAUDE_CODE_EFFORT_LEVEL wins over the settings file; the instance's effort over both", () => {
    const settings = { effortLevel: "low" };
    const env = { CLAUDE_CODE_EFFORT_LEVEL: "max" };
    assert.deepEqual(resolveClaudeDefaults({ ...base, instanceEnv: env, settings }).effort, {
      value: "max",
      source: "env",
      detail: "CLAUDE_CODE_EFFORT_LEVEL",
    });
    assert.deepEqual(resolveClaudeDefaults({ ...base, instanceEnv: env, instanceDefaults: { effort: "high" }, settings }).effort, {
      value: "high",
      source: "instance",
      detail: null,
    });
  });

  it("the effort default follows the thread's own model; a model without effort has none", () => {
    assert.deepEqual(resolveClaudeDefaults({ ...base, model: "sonnet" }).effort, { value: "high", source: "model", detail: null });
    assert.deepEqual(resolveClaudeDefaults({ ...base, model: "haiku" }).effort, { value: null, source: "model", detail: null });
  });

  it("without the runner's list the account's default is unknown, never guessed", () => {
    assert.deepEqual(resolveClaudeDefaults({ ...base, models: [] }), {
      model: { value: null, source: "account", detail: null },
      effort: { value: null, source: "model", detail: null },
    });
  });

  it("a top-level effortLevel in the user settings does not count for Opus 5.5 and Sonnet 5.5; it still does for older models", () => {
    const settings = { effortLevel: "high" };
    assert.deepEqual(resolveClaudeDefaults({ ...base, settings }).effort, { value: "medium", source: "model", detail: null });
    assert.deepEqual(resolveClaudeDefaults({ ...base, model: "claude-sonnet-5-5", settings }).effort, {
      value: "medium",
      source: "model",
      detail: null,
    });
    assert.deepEqual(resolveClaudeDefaults({ ...base, model: "sonnet", settings }).effort, {
      value: "high",
      source: "settings",
      detail: "/home/u/.claude/settings.json",
    });
    // The level saved for the model itself still applies to Opus 5.5.
    const perModel = { effortLevel: "high", modelSettings: { "claude-opus-5-5": { effortLevel: "low" } } };
    assert.deepEqual(resolveClaudeDefaults({ ...base, settings: perModel }).effort.value, "low");
  });

  it("with the model unknown, the top-level effortLevel is not claimed", () => {
    assert.deepEqual(resolveClaudeDefaults({ ...base, models: [], settings: { effortLevel: "high" } }).effort, {
      value: null,
      source: "model",
      detail: null,
    });
  });

  it("values of the wrong shape count as unset", () => {
    const d = resolveClaudeDefaults({ ...base, instanceEnv: { CLAUDE_CODE_EFFORT_LEVEL: "unset" }, settings: { model: 3, effortLevel: "huge" } });
    assert.deepEqual(d.model.source, "account");
    assert.deepEqual(d.effort, { value: "medium", source: "model", detail: null });
  });
});

describe("claudeModelDefaultEffort", () => {
  it("follows Claude Code's documented defaults; an alias gives null", () => {
    assert.equal(claudeModelDefaultEffort("claude-opus-5-5"), "medium");
    assert.equal(claudeModelDefaultEffort("claude-sonnet-5-5"), "medium");
    assert.equal(claudeModelDefaultEffort("claude-opus-4-7"), "xhigh");
    assert.equal(claudeModelDefaultEffort("claude-sonnet-5"), "high");
    assert.equal(claudeModelDefaultEffort("opus"), null);
  });
});

describe("Claude adapter defaults()", () => {
  function probeQuery(models: () => ReturnType<Query["supportedModels"]>) {
    const calls: Options[] = [];
    let closed = 0;
    const query = ((params: { prompt: unknown; options?: Options }) => {
      calls.push(params.options ?? {});
      return { supportedModels: models, close: () => void closed++ } as unknown as Query;
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    return { query, calls, closed: () => closed };
  }

  it("asks the runner for its list once before any run, with the instance's env, and closes the probe", async () => {
    const fake = probeQuery(async () => [
      { value: "default", displayName: "Default (recommended)", description: "Opus 5.5", resolvedModel: "claude-opus-5-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
    ]);
    const reads: string[] = [];
    const adapter = createClaudeAdapter({
      query: fake.query,
      resolveExecutable: async () => "/bin/claude",
      readSettings: async (path) => {
        reads.push(path);
        return { effortLevel: "high" };
      },
    });
    const input = { model: null, instanceEnv: { CLAUDE_CONFIG_DIR: "/cfg/work" }, instanceDefaults: null };
    const first = await adapter.defaults?.(input);
    assert.deepEqual(first, {
      model: { value: "claude-opus-5-5", source: "account", detail: null },
      effort: { value: "medium", source: "model", detail: null },
    });
    assert.deepEqual(reads, ["/cfg/work/settings.json"]);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].env?.CLAUDE_CONFIG_DIR, "/cfg/work");
    // No settings file and no hooks: reading the defaults never runs a
    // SessionStart (or any other) hook of the user's.
    assert.deepEqual(fake.calls[0].settingSources, []);
    assert.deepEqual(fake.calls[0].settings, { disableAllHooks: true });
    assert.equal(fake.closed(), 1);
    await adapter.defaults?.(input);
    assert.equal(fake.calls.length, 1, "the list is cached after the first answer");
    assert.equal((await adapter.models()).find((m) => m.id === "default")?.resolvedModel, "claude-opus-5-5");
  });

  it("a probe that fails answers without the account's default and is tried again next time", async () => {
    const fake = probeQuery(async () => {
      throw new Error("not logged in");
    });
    const adapter = createClaudeAdapter({ query: fake.query, resolveExecutable: async () => null, readSettings: async () => null });
    const input = { model: null, instanceEnv: {}, instanceDefaults: null };
    assert.deepEqual((await adapter.defaults?.(input))?.model, { value: null, source: "account", detail: null });
    await adapter.defaults?.(input);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.closed(), 2);
  });

  it("each account (CLAUDE_CONFIG_DIR) gets its own probe and its own default model", async () => {
    const byDir: Record<string, string> = { "/accountA": "claude-opus-5-5", "/accountB": "claude-sonnet-5" };
    const calls: Options[] = [];
    const query = ((params: { prompt: unknown; options?: Options }) => {
      calls.push(params.options ?? {});
      const resolvedModel = byDir[params.options?.env?.CLAUDE_CONFIG_DIR ?? ""];
      return {
        supportedModels: async () => [
          { value: "default", displayName: "Default", description: "", resolvedModel, supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
        ],
        close: () => undefined,
      } as unknown as Query;
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const adapter = createClaudeAdapter({ query, resolveExecutable: async () => null, readSettings: async () => null });
    const a = await adapter.defaults?.({ model: null, instanceEnv: { CLAUDE_CONFIG_DIR: "/accountA" }, instanceDefaults: null });
    const b = await adapter.defaults?.({ model: null, instanceEnv: { CLAUDE_CONFIG_DIR: "/accountB" }, instanceDefaults: null });
    assert.deepEqual(a?.model.value, "claude-opus-5-5");
    assert.deepEqual(a?.effort.value, "medium");
    assert.deepEqual(b?.model.value, "claude-sonnet-5");
    assert.deepEqual(b?.effort.value, "high");
    assert.equal(calls.length, 2);
    await adapter.defaults?.({ model: null, instanceEnv: { CLAUDE_CONFIG_DIR: "/accountA" }, instanceDefaults: null });
    assert.equal(calls.length, 2, "each account's list is cached");
  });

  it("a probe whose start throws, or whose executable lookup fails, is tried again next time", async () => {
    let calls = 0;
    const query = (() => {
      calls++;
      throw new Error("spawn failed");
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
    const adapter = createClaudeAdapter({ query, resolveExecutable: async () => null, readSettings: async () => null });
    const input = { model: null, instanceEnv: {}, instanceDefaults: null };
    assert.deepEqual((await adapter.defaults?.(input))?.model, { value: null, source: "account", detail: null });
    assert.deepEqual((await adapter.defaults?.(input))?.model, { value: null, source: "account", detail: null });
    assert.equal(calls, 2);

    let lookups = 0;
    const fake = probeQuery(async () => []);
    const noExecutable = createClaudeAdapter({
      query: fake.query,
      resolveExecutable: async () => {
        lookups++;
        throw new Error("lookup failed");
      },
      readSettings: async () => null,
    });
    assert.equal((await noExecutable.defaults?.(input))?.model.value, null);
    assert.equal((await noExecutable.defaults?.(input))?.model.value, null);
    assert.equal(lookups, 2);
    assert.equal(fake.calls.length, 0);
  });

  it("a probe that does not answer in time is closed and answered without it", async () => {
    const fake = probeQuery(() => new Promise(() => undefined));
    const adapter = createClaudeAdapter({
      query: fake.query,
      resolveExecutable: async () => null,
      readSettings: async () => null,
      modelsProbeTimeoutMs: 10,
    });
    const d = await adapter.defaults?.({ model: null, instanceEnv: {}, instanceDefaults: null });
    assert.equal(d?.model.value, null);
    assert.equal(fake.closed(), 1);
  });
});
