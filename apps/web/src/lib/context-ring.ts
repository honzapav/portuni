// The context ring (docs/superpowers/specs/2026-09-21-task-surface-v2-design.md,
// "The context ring"): pure derivation of what the header renders from
// the session summary's counters or the latest context_usage event.
// Dependency-free so test/context-ring.test.ts covers the thresholds.

import type { ChatEvent } from "./session-chat";

// From this fraction on the ring takes the warning colour and
// "Pokračovat v nové session" becomes the filled button.
export const CONTEXT_WARN_FRACTION = 0.8;

export type ContextRingState = {
  used: number;
  max: number | null;
  fraction: number | null;
  warn: boolean;
  label: string;
};

export type ContextUsageSnapshot = {
  used: number;
  max: number | null;
  input: number;
  cached: number;
  output: number;
};

// Compact token count with a Czech decimal: 950, 12,3 k, 200 k.
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const text = k >= 100 ? String(Math.round(k)) : (Math.round(k * 10) / 10).toString().replace(".", ",");
  return `${text} k`;
}

const finite = (n: number | null | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;

// null = no ring at all (a draft, a session that never reported usage, a
// summary built somewhere the counters are not set at all).
export function contextRingState(
  usedInput: number | null | undefined,
  maxInput: number | null | undefined,
): ContextRingState | null {
  const used = finite(usedInput);
  const max = finite(maxInput);
  if (used === null) return null;
  if (max === null || max <= 0) {
    return { used, max: null, fraction: null, warn: false, label: `${formatTokens(used)} tokenů` };
  }
  const fraction = used / max;
  const percent = Math.round(fraction * 100);
  return {
    used,
    max,
    fraction,
    warn: fraction >= CONTEXT_WARN_FRACTION,
    label: percent < 1 ? "<1 %" : `${percent} %`,
  };
}

// The newest context_usage event in the transcript, or null.
export function latestContextUsage(events: readonly ChatEvent[]): ContextUsageSnapshot | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event;
    if (e.kind === "context_usage") {
      return {
        used: e.payload.used_tokens,
        max: e.payload.max_tokens,
        input: e.payload.input_tokens,
        cached: e.payload.cached_tokens,
        output: e.payload.output_tokens,
      };
    }
  }
  return null;
}
