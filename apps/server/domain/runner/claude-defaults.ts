// What a Claude thread without its own model or effort runs on, and where
// that comes from -- the composer names both before the first run. The
// order is Claude Code's own (https://code.claude.com/docs/en/model-config,
// "Setting your model" and "Adjust effort level"), cut down to what a run
// started by this adapter sees: the instance's defaults (passed as `model`
// / `effort`, so the CLI takes them as an explicit choice), the instance's
// environment, the user settings file (the adapter loads `settingSources:
// ["user"]` only), the managed settings (the policy tier the CLI always
// reads: managed-settings.json, MDM, remote-cached) and the defaults the
// CLI holds itself. Managed settings win over the user settings file, key
// by key. The organization's default effort for a model is known only to
// the CLI: the adapter learns it from a run's own turns (accountEfforts),
// and before such a run the model's documented default stands in. A
// top-level effortLevel in the user settings file does not apply to Opus 5.5
// and Sonnet 5.5 (legacyEffortApplies); in managed settings it applies to
// every model.
//
// Environment variables are the run's: the instance's env with the
// settings files' `env` blocks written over it (the managed block over the
// user one), which is what the CLI does for a session the SDK starts
// (settings-reference, "How env values interact with your shell"); an
// empty value there unsets the variable. CLAUDE_CODE_EFFORT_LEVEL
// overrides --effort (env-vars, "Precedence"), so it wins over the
// instance's effort, and its value `auto` means the model's own default
// (which then also wins); --model overrides ANTHROPIC_MODEL, so the
// instance's model wins over the variable.

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
  // The managed (policy) tier, merged; null when none applies. The SDK
  // names no file for it, so a managed value carries no detail.
  managed?: { settings: ClaudeUserSettings } | null;
  // The effort a run of this account actually got for a model when
  // nothing set one, keyed by the full model id: the organization's
  // default where it has one, learned from the run (adapters/claude.ts).
  accountEfforts?: Readonly<Record<string, EffortLevel>>;
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
// Haiku has no effort.
export function claudeModelDefaultEffort(modelId: string): EffortLevel | null {
  if (!modelId.startsWith("claude-")) return null;
  if (/^claude-haiku-/.test(modelId)) return null;
  if (/^claude-(opus|sonnet)-5-5\b/.test(modelId)) return "medium";
  if (/^claude-opus-4-7\b/.test(modelId)) return "xhigh";
  return "high";
}

// A top-level effortLevel in the user settings file is the older form
// /effort wrote; per the same page it "doesn't count for Opus 5.5", which
// starts at its own default unless a level is set for it. Sonnet 5.5 is
// treated the same (its default is Opus 5.5's). An unknown model gives
// false: whether the key applies cannot be told. The same key in managed
// settings "applies to every model".
function legacyEffortApplies(modelId: string | null): boolean {
  if (!modelId?.startsWith("claude-")) return false;
  return !/^claude-(opus|sonnet)-5-5\b/.test(modelId);
}

type Source = { source: "env" | "settings" | "managed"; detail: string | null };

function envBlock(settings: ClaudeUserSettings | null | undefined): Record<string, unknown> {
  return settings?.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
}

// A variable as the run sees it, and where it comes from.
function envValue(name: string, input: ResolveClaudeDefaultsInput): { value: string | null } & Source {
  const managed = envBlock(input.managed?.settings);
  if (typeof managed[name] === "string") return { value: nonEmpty(managed[name]), source: "managed", detail: null };
  const user = envBlock(input.settings);
  if (typeof user[name] === "string") return { value: nonEmpty(user[name]), source: "settings", detail: input.settingsPath };
  return { value: nonEmpty(input.instanceEnv[name]), source: "env", detail: name };
}

// A settings key as the run sees it: the managed tier's value, else the
// user file's.
function settingValue<T>(
  input: ResolveClaudeDefaultsInput,
  read: (settings: ClaudeUserSettings) => T | null,
): ({ value: T } & Source) | null {
  const managed = input.managed ? read(input.managed.settings) : null;
  if (managed !== null) return { value: managed, source: "managed", detail: null };
  const user = input.settings ? read(input.settings) : null;
  if (user !== null) return { value: user, source: "settings", detail: input.settingsPath };
  return null;
}

function findModel(models: readonly RunnerModel[], id: string): RunnerModel | undefined {
  return models.find((m) => m.id === id) ?? models.find((m) => m.resolvedModel === id);
}

// The effort a run gets, and whether it is the default the CLI holds for
// the model (nothing set one, or CLAUDE_CODE_EFFORT_LEVEL=auto): only then
// does a run's actual effort tell the account's default.
function resolveEffort(
  input: ResolveClaudeDefaultsInput,
  modelValue: string | null,
): { effort: RunnerDefaults["effort"]; modelDefault: boolean } {
  const { models } = input;
  const effortModel = input.model ?? modelValue;
  const row = effortModel ? findModel(models, effortModel) : undefined;
  const fullId = row?.resolvedModel ?? effortModel;

  let own: RunnerDefaults["effort"];
  const observed = fullId ? input.accountEfforts?.[fullId] : undefined;
  if (row && !row.supportsEffort) own = { value: null, source: "model", detail: null };
  else if (observed) own = { value: observed, source: "organization", detail: null };
  else own = { value: fullId ? claudeModelDefaultEffort(fullId) : null, source: "model", detail: null };

  const envVar = envValue("CLAUDE_CODE_EFFORT_LEVEL", input);
  if (envVar.value === "auto") return { effort: { ...own, source: envVar.source, detail: envVar.detail }, modelDefault: true };
  const envEffort = effortLevel(envVar.value);
  if (envEffort) return { effort: { value: envEffort, source: envVar.source, detail: envVar.detail }, modelDefault: false };
  const instanceEffort = effortLevel(input.instanceDefaults?.effort);
  if (instanceEffort) return { effort: { value: instanceEffort, source: "instance", detail: null }, modelDefault: false };
  const perModel = settingValue(input, (s) => {
    const map = s.modelSettings && typeof s.modelSettings === "object" ? (s.modelSettings as Record<string, unknown>) : {};
    return (
      [effortModel, fullId]
        .filter((k): k is string => typeof k === "string")
        .map((k) => {
          const entry = map[k];
          return entry && typeof entry === "object" ? effortLevel((entry as { effortLevel?: unknown }).effortLevel) : null;
        })
        .find((e) => e !== null) ?? null
    );
  });
  if (perModel) return { effort: perModel, modelDefault: false };
  const managedTop = input.managed ? effortLevel(input.managed.settings.effortLevel) : null;
  if (managedTop) return { effort: { value: managedTop, source: "managed", detail: null }, modelDefault: false };
  const userTop = legacyEffortApplies(fullId) && input.settings ? effortLevel(input.settings.effortLevel) : null;
  if (userTop) return { effort: { value: userTop, source: "settings", detail: input.settingsPath }, modelDefault: false };
  return { effort: own, modelDefault: true };
}

function resolveModel(input: ResolveClaudeDefaultsInput): RunnerDefaults["model"] {
  const instanceModel = nonEmpty(input.instanceDefaults?.model);
  if (instanceModel) return { value: instanceModel, source: "instance", detail: null };
  const envModel = envValue("ANTHROPIC_MODEL", input);
  if (envModel.value) return { value: envModel.value, source: envModel.source, detail: envModel.detail };
  const settingsModel = settingValue(input, (s) => nonEmpty(s.model));
  if (settingsModel) return settingsModel;
  const envDefaultModel = envValue("ANTHROPIC_DEFAULT_MODEL", input);
  if (envDefaultModel.value) return { value: envDefaultModel.value, source: envDefaultModel.source, detail: envDefaultModel.detail };
  const row = input.models.find((m) => m.id === "default");
  return { value: row?.resolvedModel ?? null, source: "account", detail: null };
}

export function resolveClaudeDefaults(input: ResolveClaudeDefaultsInput): RunnerDefaults {
  const model = resolveModel(input);
  return { model, effort: resolveEffort(input, model.value).effort };
}

// Whether a run on `input` gets the effort the CLI holds for its model by
// itself -- the case in which the effort a turn reports is the account's
// default for that model.
function claudeEffortIsAccountDefault(input: ResolveClaudeDefaultsInput): boolean {
  return resolveEffort(input, resolveModel(input).value).modelDefault;
}

// A model id as settings key it (claude-<family>-<version>): no date,
// provider prefix or @version. Only on such an id can a run tell what
// the settings set for its model.
const CANONICAL_MODEL_ID = /^claude-[a-z]+(-\d{1,2})+$/;

function withoutContextSuffix(id: string): string {
  return id.replace(/\[[^\]]*\]$/, "");
}

// Keys that change a turn's level or model besides the effort ones: a cap
// ("anything above it ... a model default" is clamped), a main-thread
// agent (whose definition may carry an effort), ultracode (xhigh) and a
// fallback model (SDK Settings).
const EFFORT_CHANGING_KEYS = ["maxEffortLevel", "agent", "ultracode", "fallbackModel"] as const;

function setsAnything(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function perModelEffortKeys(settings: ClaudeUserSettings): string[] {
  const map = settings.modelSettings && typeof settings.modelSettings === "object" ? (settings.modelSettings as Record<string, unknown>) : {};
  return Object.entries(map)
    .filter(([, entry]) => {
      const e = entry && typeof entry === "object" ? (entry as { effortLevel?: unknown; maxEffortLevel?: unknown }) : null;
      return e !== null && (setsAnything(e.effortLevel) || setsAnything(e.maxEffortLevel));
    })
    .map(([key]) => key);
}

// Whether the effort a run reports for its turns can be kept as the
// account's (the organization's) default for the model its init message
// names. The CLI says only which level a turn got, never why (SDK
// HookInput.effort), so this errs towards not learning: a level kept
// wrongly outlives the setting that chose it, a level not kept leaves the
// documented default. Nothing may set the effort for any name the model
// goes by (the thread's, the init message's, the init message's without a
// context suffix); the CLI matches a modelSettings key "with its dated,
// [1m], Bedrock and Vertex spellings" (SDK Settings.modelSettings), so the
// init id must be a plain one and any per-model key that names it in part
// counts as set (an effortLevel or a maxEffortLevel); a cap, an agent,
// ultracode or a fallback model in any tier counts as set; and a top-level
// effortLevel in the user settings file counts as set except on Opus 5.5,
// the one model the docs exempt.
export function claudeEffortIsLearnable(input: ResolveClaudeDefaultsInput, threadModel: string | null, initModel: string): boolean {
  const id = withoutContextSuffix(initModel);
  if (!CANONICAL_MODEL_ID.test(id)) return false;
  if ([...new Set([threadModel, initModel, id])].some((model) => !claudeEffortIsAccountDefault({ ...input, model }))) return false;
  for (const settings of [input.managed?.settings, input.settings]) {
    if (!settings) continue;
    const raw = settings as Record<string, unknown>;
    if (EFFORT_CHANGING_KEYS.some((key) => setsAnything(raw[key]))) return false;
    const named = perModelEffortKeys(settings).some((k) => {
      const key = withoutContextSuffix(k);
      return key.includes(id) || id.includes(key);
    });
    if (named) return false;
  }
  if (effortLevel(input.settings?.effortLevel) !== null && id !== "claude-opus-5-5") return false;
  return true;
}
