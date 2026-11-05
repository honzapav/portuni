// Which nodes' thread lists App.tsx refetches over REST
// (docs/superpowers/specs/2026-11-05-client-traffic-contract.md, rules 1
// and 3). The store holds every thread the window knows; a REST list is
// asked for only where it is missing something: a node that has just been
// opened, or a node whose live frame names a session the store holds as a
// stub (a frame carries state, waiting and name, not runner, cli or
// timestamps -- see session-store.ts's stubFromFrame). Closing a node and a
// frame about a thread already complete cost nothing. Pure, so
// test/web-session-refresh-policy.test.ts pins the request count per action.

export function nodesAddedToOpenSet(prev: readonly string[], next: readonly string[]): string[] {
  const seen = new Set(prev);
  return next.filter((id) => !seen.has(id));
}

export function nodesToRefetchForFrames(
  frames: readonly { session_id: string; node_id: string | null }[],
  openNodeIds: readonly string[],
  isComplete: (sessionId: string) => boolean,
): string[] {
  const open = new Set(openNodeIds);
  const out: string[] = [];
  for (const frame of frames) {
    if (!frame.node_id || !open.has(frame.node_id) || out.includes(frame.node_id)) continue;
    if (isComplete(frame.session_id)) continue;
    out.push(frame.node_id);
  }
  return out;
}
