// The window-wide 429 cooldown (docs/superpowers/specs/
// 2026-11-05-client-traffic-contract.md, rule 5).
//
// The central server limits requests per bearer token (240 a minute by
// default) and answers RATE_LIMITED with `params.retryAfterSeconds`. A
// request it refused is not counted, but every poll that keeps asking
// competes for the capacity the moment it frees up, and each refusal paints
// an error somewhere on screen. So apiFetch notes every 429 here and the
// background pollers (lib/poll-policy.ts) skip their ticks until the
// cooldown is over. A request the user makes on purpose still goes out --
// it would get the same 429, and the error it shows is the honest answer.
//
// One cooldown for the whole window: the webview cannot tell whether a
// path went to the sidecar or to central, and the two limits are the same
// kind of answer either way.

const DEFAULT_COOLDOWN_S = 30;

let until = 0;

// Records a 429. `retryAfterSeconds` is what the server sent; a missing or
// non-positive value falls back to DEFAULT_COOLDOWN_S. A cooldown that is
// already longer stays.
export function noteRateLimited(retryAfterSeconds: number | null | undefined, now = Date.now()): void {
  const seconds =
    typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : DEFAULT_COOLDOWN_S;
  until = Math.max(until, now + seconds * 1000);
}

// Ms epoch until which background polls hold off; 0 when none.
export function rateLimitedUntil(): number {
  return until;
}

export function isRateLimited(now = Date.now()): boolean {
  return now < until;
}

// `params.retryAfterSeconds` from an error body (shared/error-codes.ts
// RATE_LIMITED), when it is a finite number of at least one second.
export function retryAfterFromBody(bodyText: string): number | null {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const params = (parsed as { params?: unknown }).params;
    if (!params || typeof params !== "object") return null;
    const value = (params as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    return typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : null;
  } catch {
    return null;
  }
}

export function resetRateLimitCooldownForTesting(): void {
  until = 0;
}
