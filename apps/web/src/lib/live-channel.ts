// When the live channel counts as down for the UI (#590). A channel that is
// not open is normal for a moment -- the first connect at start-up, a
// reconnect after the sidecar restarts -- so the chat and the footer say so
// only once it has stayed out of `open` for LIVE_CHANNEL_GRACE_MS. Pure,
// tested from test/sessions-client.test.ts.

import type { ConnectionStatus } from "./sessions-client.js";

const LIVE_CHANNEL_GRACE_MS = 3_000;

export function liveChannelDown(
  state: { status: ConnectionStatus; since: number },
  now: number,
  graceMs: number = LIVE_CHANNEL_GRACE_MS,
): boolean {
  return state.status !== "open" && now - state.since >= graceMs;
}

// How long until a channel that is not open counts as down; null when it is
// open (nothing to wait for).
export function msUntilLiveChannelDown(
  state: { status: ConnectionStatus; since: number },
  now: number,
  graceMs: number = LIVE_CHANNEL_GRACE_MS,
): number | null {
  if (state.status === "open") return null;
  return Math.max(0, state.since + graceMs - now);
}
