// One coalesced fetch of a node's thread list (docs/superpowers/specs/
// 2026-11-05-client-traffic-contract.md, rule 1), shared by the Práce
// sidebar's refresh in App.tsx and the Relace tab's stub trigger: a caller
// while a fetch is in flight sets a trailing flag instead of racing a
// second request, so a burst of frames on one node costs at most two
// round trips and the last one always wins. The rows land in the store
// (fetchNodePersistentSessions puts them); nothing here decides what is
// shown.

import { fetchNodePersistentSessions } from "../api";

type Flight = { promise: Promise<void>; trailing: boolean };

const inFlight = new Map<string, Flight>();

const defaultFetcher = (nodeId: string): Promise<void> =>
  fetchNodePersistentSessions(nodeId, false).then(() => undefined);

export function refreshNodeSessions(
  nodeId: string,
  fetcher: (nodeId: string) => Promise<void> = defaultFetcher,
): Promise<void> {
  const current = inFlight.get(nodeId);
  if (current) {
    current.trailing = true;
    return current.promise;
  }
  const flight: Flight = { trailing: false, promise: Promise.resolve() };
  flight.promise = fetcher(nodeId).finally(() => {
    inFlight.delete(nodeId);
    // The trailing fetch is its own flight; its outcome is nobody's to await.
    if (flight.trailing) refreshNodeSessions(nodeId, fetcher).catch(() => undefined);
  });
  inFlight.set(nodeId, flight);
  return flight.promise;
}

export function resetNodeSessionsRefreshForTesting(): void {
  inFlight.clear();
}
