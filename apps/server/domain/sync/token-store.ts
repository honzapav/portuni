import type { DeviceToken } from "./types.js";

export interface TokenStore {
  read(remoteName: string): Promise<DeviceToken | null>;
  write(remoteName: string, tokens: DeviceToken): Promise<void>;
  delete(remoteName: string): Promise<void>;
}

type TokenStoreKind = "file" | "keychain" | "varlock";

async function createTokenStore(): Promise<TokenStore> {
  const kind = (process.env.PORTUNI_TOKEN_STORE as TokenStoreKind | undefined) ?? "file";
  switch (kind) {
    case "file": return (await import("./token-store-file.js")).createFileTokenStore();
    case "keychain": return (await import("./token-store-keychain.js")).createKeychainTokenStore();
    case "varlock": return (await import("./token-store-varlock.js")).createVarlockTokenStore();
    default: throw new Error(`Unknown PORTUNI_TOKEN_STORE: ${kind}`);
  }
}

let cached: TokenStore | null = null;
export async function getTokenStore(): Promise<TokenStore> {
  if (!cached) cached = await createTokenStore();
  return cached;
}
export function resetTokenStoreForTests(): void { cached = null; }
