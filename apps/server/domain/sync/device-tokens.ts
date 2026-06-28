import type { DeviceTokens } from "./types.js";
import { getTokenStore } from "./token-store.js";

export async function readDeviceTokens(remoteNames: string[]): Promise<DeviceTokens> {
  const store = await getTokenStore();
  const out: DeviceTokens = {};
  for (const n of remoteNames) {
    const t = await store.read(n);
    if (t) out[n] = t;
  }
  return out;
}
