// What a Claude thread without its own model or effort runs on, and where
// that comes from -- the composer names both before the first run. The
// order is Claude Code's own (https://code.claude.com/docs/en/model-config,
// "Setting your model" and "Adjust effort level"), cut down to what a run
// started by this adapter sees: the instance's defaults (passed as `model`
// / `effort`, so the CLI takes them as an explicit choice), the instance's
// environment, the user settings file (the adapter loads `settingSources:
// ["user"]` only) and the defaults the CLI holds itself. An organisation's
// default effort and managed settings are not read; the CLI's own list is
// the only view of the account. A top-level effortLevel in that file does
// not apply to Opus 5.5 and Sonnet 5.5 (legacyEffortApplies).
//
// Environment variables are the run's: the instance's env with the
// settings file's `env` block written over it, which is what the CLI does
// for a session the SDK starts (settings-reference, "How env values
// interact with your shell"); an empty value there unsets the variable.
// CLAUDE_CODE_EFFORT_LEVEL overrides --effort (env-vars, "Precedence"), so
// it wins over the instance's effort; --model overrides ANTHROPIC_MODEL, so
// the instance's model wins over the variable.

import { EFFORT_LEVELS, type EffortLevel, type RunnerDefaults, type RunnerDefaultsInput, type RunnerModel } from "./types.js";

// The keys of a Claude Code settings file this reads; anything else in the
// file is ignored, and a value of the wrong type counts as unset.
export interface ClaudeUserSettings {
  model?: unknown;
  effortLevel?: unknown;
  modelSettings?: unknown;
  env?: unknown;
}

export interface ResolveClaudeDefaultsInput extends RunnerDefaultsInput {
  settings: ClaudeUserSettings | null;
  settingsPath: string;
  // The runner's own list; its "default" row names the account's default
  // model. Empty when the runner has not answered.
  models: readonly RunnerModel[];
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function effortLevel(value: unknown): EffortLevel | null {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value) ? (value as EffortLevel) : null;
}

// The model's own default effort, from the same doc page: "high on every
// model that supports effort, except that Opus 5.5 and Sonnet 5.5 default
// to medium, Opus 4.7 defaults to xhigh". Only a full model id is matched;
// an alias the runner did not resolve gives null rather than a guess.
export function claudeModelDefaultEffort(modelId: string): EffortLevel | null {
  if (!modelId.startsWith("claude-")) return null;
  if (/^claude-(opus|sonnet)-5-5\b/.test(modelId)) return "medium";
  if (/^claude-opus-4-7\b/.test(modelId)) return "xhigh";
  return "high";
}

// A top-level effortLevel in the user settings file is the older form
// /effort wrote; per the same page it "doesn't count for Opus 5.5", which
// starts at its own default unless a level is set for it. Sonnet 5.5 is
// treated the same (its default is Opus 5.5's). An unknown model gives
// false: whether the key applies cannot be told.
function legacyEffortApplies(modelId: string | null): boolean {
  if (!modelId?.startsWith("claude-")) return false;
  return !/^claude-(opus|sonnet)-5-5\b/.test(modelId);
}

type EnvSource = { source: "env"; detail: string } | { source: "settings"; detail: string };

// A variable as the run sees it, and where it comes from.
function envValue(
  name: string,
  instanceEnv: Readonly<Record<string, string>>,
  settings: ClaudeUserSettings | null,
  settingsPath: string,
): { value: string | null } & EnvSource {
  const block = settings?.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
  if (typeof block[name] === "string") return { value: nonEmpty(block[name]), source: "settings", detail: settingsPath };
  return { value: nonEmpty(instanceEnv[name]), source: "env", detail: name };
}

function findModel(models: readonly RunnerModel[], id: string): RunnerModel | undefined {
  return models.find((m) => m.id === id) ?? models.find((m) => m.resolvedModel === id);
}

export function resolveClaudeDefaults(input: ResolveClaudeDefaultsInput): RunnerDefaults {
  const { instanceEnv: env, settings, settingsPath, models } = input;

  let model: RunnerDefaults["model"];
  const instanceModel = nonEmpty(input.instanceDefaults?.model);
  const envModel = envValue("ANTHROPIC_MODEL", env, settings, settingsPath);
  const settingsModel = nonEmpty(settings?.model);
  const envDefaultModel = envValue("ANTHROPIC_DEFAULT_MODEL", env, settings, settingsPath);
  if (instanceModel) model = { value: instanceModel, source: "instance", detail: null };
  else if (envModel.value) model = { value: envModel.value, source: envModel.source, detail: envModel.detail };
  else if (settingsModel) model = { value: settingsModel, source: "settings", detail: settingsPath };
  else if (envDefaultModel.value) model = { value: envDefaultModel.value, source: envDefaultModel.source, detail: envDefaultModel.detail };
  else {
    const row = models.find((m) => m.id === "default");
    model = { value: row?.resolvedModel ?? null, source: "account", detail: null };
  }

  const effortModel = input.model ?? model.value;
  const row = effortModel ? findModel(models, effortModel) : undefined;
  const fullId = row?.resolvedModel ?? effortModel;

  let effort: RunnerDefaults["effort"];
  const instanceEffort = effortLevel(input.instanceDefaults?.effort);
  const envEffortVar = envValue("CLAUDE_CODE_EFFORT_LEVEL", env, settings, settingsPath);
  const envEffort = effortLevel(envEffortVar.value);
  const perModel =
    settings?.modelSettings && typeof settings.modelSettings === "object"
      ? (settings.modelSettings as Record<string, unknown>)
      : {};
  const perModelEffort = [effortModel, fullId]
    .filter((k): k is string => typeof k === "string")
    .map((k) => {
      const entry = perModel[k];
      return entry && typeof entry === "object" ? effortLevel((entry as { effortLevel?: unknown }).effortLevel) : null;
    })
    .find((e) => e !== null);
  const settingsEffort = legacyEffortApplies(fullId) ? effortLevel(settings?.effortLevel) : null;
  if (envEffort) effort = { value: envEffort, source: envEffortVar.source, detail: envEffortVar.detail };
  else if (instanceEffort) effort = { value: instanceEffort, source: "instance", detail: null };
  else if (perModelEffort) effort = { value: perModelEffort, source: "settings", detail: settingsPath };
  else if (settingsEffort) effort = { value: settingsEffort, source: "settings", detail: settingsPath };
  else if (row && !row.supportsEffort) effort = { value: null, source: "model", detail: null };
  else effort = { value: fullId ? claudeModelDefaultEffort(fullId) : null, source: "model", detail: null };

  return { model, effort };
}
