import { useEffect, useState } from "react";
import type { ConnectionError, ConnectionStatus, SessionsClient } from "./sessions-client";
import { liveChannelDown, msUntilLiveChannelDown } from "./live-channel";

export interface LiveChannel {
  status: ConnectionStatus;
  error: ConnectionError;
  // Out of `open` longer than the grace period (lib/live-channel.ts).
  down: boolean;
}

// The live channel's status for a view (#590): the chat and the footer show
// a channel that stays down, with its reason, instead of loading forever.
export function useLiveChannel(client: SessionsClient): LiveChannel {
  const [state, setState] = useState(() => client.connectionState());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setState(client.connectionState());
    return client.onConnectionStatus(() => setState(client.connectionState()));
  }, [client]);

  // One timer to the moment the grace period runs out, so `down` flips
  // without a clock ticking while the channel is fine.
  useEffect(() => {
    const wait = msUntilLiveChannelDown(state, Date.now());
    if (wait === null) return;
    const id = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(id);
  }, [state]);

  return { status: state.status, error: state.error, down: liveChannelDown(state, now) };
}
