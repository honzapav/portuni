// Backoff for periodic work against the central server.
//
// The backfill sweep fans out across every mirror on this device (26 on a
// real machine) every 10 minutes, and CentralClient retries each request
// once. When central is simply not reachable -- which on a laptop is the
// normal case, not an incident: asleep, off wifi, DNS not resolving -- that
// round costs ~52 doomed connects and writes one multi-line stack trace per
// mirror into an append-only log. Days of that is what turned
// sidecar-<ws>.log into tens of megabytes and buried every real error in it.
//
// Two rules fix that, both here:
//   - a round that hits a NETWORK failure (not an HTTP status -- central
//     answering 4xx/5xx means it is up and the mirror-level error is real)
//     stops immediately instead of asking the remaining mirrors the same
//     question it already knows the answer to;
//   - the next round is delayed exponentially, so an overnight offline
//     stretch costs a handful of attempts rather than one every 10 minutes.
//
// Deliberately no health-probe endpoint: the first mirror's own call IS the
// probe. One less round trip, one less thing to keep in sync with central.

import { CentralHttpError } from "./client.js";

// A network-level failure (DNS, no route, refused, timeout) means "we could
// not reach central at all". A CentralHttpError means we did reach it and it
// answered -- that is a real per-mirror problem, never a reason to back off.
export function isUnreachableError(e: unknown): boolean {
  // CentralHttpError is the only error the client throws for an answered
  // request; anything else came from fetch/abort.
  return !(e instanceof CentralHttpError);
}

export const BASE_BACKOFF_MS = 10 * 60_000;
export const MAX_BACKOFF_MS = 60 * 60_000;

// 1 failure -> the normal interval, then doubling up to the cap. Pure so the
// schedule is unit-testable without timers.
export function backoffMsFor(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const grown = BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1);
  return Math.min(grown, MAX_BACKOFF_MS);
}

export interface BackoffState {
  consecutiveFailures: number;
  // When the next attempt becomes allowed (epoch ms). 0 = no restriction.
  nextAttemptAt: number;
}

export function initialBackoff(): BackoffState {
  return { consecutiveFailures: 0, nextAttemptAt: 0 };
}

export function shouldAttempt(state: BackoffState, now: number): boolean {
  return now >= state.nextAttemptAt;
}

export function recordUnreachable(state: BackoffState, now: number): BackoffState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    nextAttemptAt: now + backoffMsFor(consecutiveFailures),
  };
}

export function recordReachable(_state: BackoffState): BackoffState {
  return initialBackoff();
}
