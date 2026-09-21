// Composer row 2 (docs/superpowers/specs/2026-09-21-task-surface-v2-design.md,
// "The composer"): the runner/instance choice a draft makes before its
// first message. Pure so test/runner-picker.test.ts covers the grouping
// and the labels without React.

const SEP = "\u0000";

export type RunnerPickerOption = {
  value: string;
  runner: string;
  instanceId: string | null;
  label: string;
  // The draft's own initial choice, i.e. what the organisation's default
  // resolved to at creation.
  isDefault: boolean;
};
export type RunnerPickerGroup = { runner: string; label: string; options: RunnerPickerOption[] };

// One Select value for the pair: the runner id, a NUL, the instance id
// (empty for the runner's own default instance).
export function encodeRunnerChoice(runner: string, instanceId: string | null): string {
  return `${runner}${SEP}${instanceId ?? ""}`;
}

export function decodeRunnerChoice(value: string): { runner: string; instanceId: string | null } {
  const idx = value.indexOf(SEP);
  if (idx < 0) return { runner: value, instanceId: null };
  const instanceId = value.slice(idx + 1);
  return { runner: value.slice(0, idx), instanceId: instanceId === "" ? null : instanceId };
}

// One group per runner, its own default instance first, then every
// configured instance of it.
export function runnerPickerGroups(
  runners: readonly { id: string; label?: string }[],
  instances: readonly { id: string; name: string; runner: string }[],
  defaultChoice: { runner: string | null; instanceId: string | null },
): RunnerPickerGroup[] {
  return runners.map((r) => {
    const isDefault = (instanceId: string | null) =>
      defaultChoice.runner === r.id && defaultChoice.instanceId === instanceId;
    const own: RunnerPickerOption = {
      value: encodeRunnerChoice(r.id, null),
      runner: r.id,
      instanceId: null,
      label: "výchozí instance",
      isDefault: isDefault(null),
    };
    const rest = instances
      .filter((i) => i.runner === r.id)
      .map((i) => ({
        value: encodeRunnerChoice(r.id, i.id),
        runner: r.id,
        instanceId: i.id,
        label: i.name,
        isDefault: isDefault(i.id),
      }));
    return { runner: r.id, label: r.label ?? r.id, options: [own, ...rest] };
  });
}

// The fixed choice on a promoted thread, or the reason there is no picker.
export function runnerChoiceLabel(
  session: { runner: string | null; instance_id: string | null },
  instances: readonly { id: string; name: string }[],
): string {
  if (!session.runner) return "Žádný runner není přihlášený";
  const name = session.instance_id
    ? (instances.find((i) => i.id === session.instance_id)?.name ?? session.instance_id)
    : null;
  return name ? `${session.runner} · ${name}` : session.runner;
}
