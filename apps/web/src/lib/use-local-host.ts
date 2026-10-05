// This device's host id and label, as GET /hosts/local answers it (#578).
// Device-local: in a team workspace the sync agent answers, since the
// central server never loaded this device's identity and so builds every
// summary with the device's id and no label. hostDisplayName names the
// user's own threads from it. Null until the fetch resolves or if it
// fails -- the id is then shown, as before.
import { useEffect, useState } from "react";
import { jsonRequest } from "../api";
import type { LocalHostInfo } from "../../../server/shared/api-types";

export type { LocalHostInfo };

let cached: LocalHostInfo | null = null;
let inflight: Promise<LocalHostInfo | null> | null = null;

function loadLocalHost(): Promise<LocalHostInfo | null> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = jsonRequest<LocalHostInfo>("GET", "/hosts/local")
      .then((host) => {
        cached = host;
        return host;
      })
      .catch(() => {
        inflight = null;
        return null;
      });
  }
  return inflight;
}

export function useLocalHost(): LocalHostInfo | null {
  const [host, setHost] = useState<LocalHostInfo | null>(() => cached);
  useEffect(() => {
    let cancelled = false;
    void loadLocalHost().then((h) => {
      if (!cancelled && h) setHost(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return host;
}
