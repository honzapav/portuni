// The caller's own identity, as GET /me answers it, read from the
// window's one meResource (lib/resources.ts): App (create-node gate, the
// account's language), SettingsPage (tab tiers), AccountSection (profile)
// and the sharing UI (DetailPane's AccessSection) all read the same
// answer. Defaults to "nobody, no manage" until the fetch resolves or if
// it fails, so nothing is ever offered optimistically.
import type { MeResponse } from "../api";
import { meResource } from "./resources";
import { useResourceState } from "./use-resource";

export interface Me {
  me: MeResponse | null;
  meId: string | null;
  canManage: boolean;
  // The global scope tier, or null until known.
  globalScope: string | null;
  // The answer arrived, or the fetch failed (the tiers then read as
  // "read"): a tab gated on a tier waits for this before bouncing.
  scopeKnown: boolean;
}

export function invalidateMe(): void {
  meResource.invalidate();
}

// Test-only: forget the cached answer between tests.
export function resetMeForTesting(): void {
  meResource.resetForTesting();
}

export function useMe(): Me {
  const { value, error } = useResourceState(meResource);
  const globalScope = value?.global_scope ?? null;
  return {
    me: value,
    meId: value?.id ?? null,
    canManage: globalScope === "manage" || globalScope === "admin",
    globalScope,
    scopeKnown: value !== null || error !== null,
  };
}
