// Retrying a read whose transport failed (#632). At startup the window can
// send its first requests in the moment between the sidecar announcing its
// port and actually answering: the call then never reaches a server and
// rejects with no HTTP status (a "network-error" in the UI trail). A read
// that failed that way is safe to send again, so it is, with a short
// backoff, until the backend answers or the budget runs out.
//
// What is retried: only idempotent methods (GET, HEAD), and only when the
// attempt rejected without a response -- a fetch TypeError in a browser, a
// reqwest failure from the Rust proxy (UNKNOWN_DETAIL) or a backend that is
// not ready yet. Any HTTP answer, 4xx and 5xx included, is the server's
// word and goes back to the caller unchanged. A write is never repeated: it
// may have reached the server before the connection dropped.
//
// Pure (sleep injected) so it is tested from the server's node:test runner
// in test/transport-retry.test.ts.

import { DesktopError } from "./tauri-invoke";

// About 8 s in total, longer than the gap observed between a sidecar's port
// announcement and its first answered request.
export const TRANSPORT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000];

const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);

// Desktop error codes that stand for "the request never got an answer".
// Anything else the Rust host rejects with (unknown workspace, sync agent
// down...) is a definite state, not a race, and is not retried.
const TRANSPORT_DESKTOP_CODES = new Set(["UNKNOWN_DETAIL", "DESKTOP_BACKEND_NOT_READY"]);

export function isTransportFailure(err: unknown): boolean {
  if (err instanceof DesktopError) return TRANSPORT_DESKTOP_CODES.has(err.code);
  // A browser fetch rejects with a TypeError; an Error from an older shell
  // or the proxy has no code either. Both mean no response arrived.
  return true;
}

export type TransportRetryOptions = {
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Run `attempt`; when it rejects with a transport failure and `method` is
// idempotent, wait and run it again, once per entry of `delays`. The last
// failure is rethrown.
export async function withTransportRetry<T>(
  method: string,
  attempt: () => Promise<T>,
  opts: TransportRetryOptions = {},
): Promise<T> {
  const delays = RETRYABLE_METHODS.has(method.toUpperCase()) ? (opts.delays ?? TRANSPORT_RETRY_DELAYS_MS) : [];
  const sleep = opts.sleep ?? defaultSleep;
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= delays.length || !isTransportFailure(err)) throw err;
      await sleep(delays[i]);
    }
  }
}
