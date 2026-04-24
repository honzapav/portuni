import type { Client } from "@libsql/client";
import type { FileAdapter } from "./types.js";
import { getRemote } from "./routing.js";
import { createOpenDALAdapter } from "./opendal-adapter.js";
import { readDeviceTokens } from "./device-tokens.js";

const cache = new Map<string, FileAdapter>();

export async function getAdapter(db: Client, remoteName: string): Promise<FileAdapter> {
  const hit = cache.get(remoteName);
  if (hit) return hit;
  const remote = await getRemote(db, remoteName);
  if (!remote) throw new Error(`Unknown remote: ${remoteName}`);
  const tokens = await readDeviceTokens([remoteName]);
  // Plan 3 will add: if remote.type === "gdrive", return createDriveAdapter(remote, tokens).
  const adapter = createOpenDALAdapter(remote, tokens);
  cache.set(remoteName, adapter);
  return adapter;
}

export function invalidateAdapter(name: string): void {
  cache.delete(name);
}

export function resetAdapterCacheForTests(): void {
  cache.clear();
}
