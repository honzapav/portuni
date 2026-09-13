// Adapter registry (spec: "registry.ts"). Module-level state, same shape as
// domain/sync/sync-jobs.ts's in-memory job map -- one process-wide registry,
// no DI container. Nothing registers an adapter in production yet (the
// Claude adapter is a later issue); tests register the fake one.

import type { RunnerAdapter, RunnerAvailability } from "./types.js";

const DETECT_CACHE_MS = 60_000;

const adapters = new Map<string, RunnerAdapter>();
const detectCache = new Map<string, { availability: RunnerAvailability; at: number }>();

// Re-registering an id (e.g. a test constructing a fresh fake adapter under
// the same id as an earlier test) drops any cached detection for it --
// otherwise detectAll could serve a stale result from the adapter instance
// that used to own this id.
export function registerAdapter(adapter: RunnerAdapter): void {
  adapters.set(adapter.id, adapter);
  detectCache.delete(adapter.id);
}

export function getAdapter(id: string): RunnerAdapter | null {
  return adapters.get(id) ?? null;
}

export function listAdapters(): RunnerAdapter[] {
  return [...adapters.values()];
}

export interface RunnerDetection {
  id: string;
  availability: RunnerAvailability;
}

export async function detectAll(now: number = Date.now()): Promise<RunnerDetection[]> {
  const results: RunnerDetection[] = [];
  for (const adapter of adapters.values()) {
    const cached = detectCache.get(adapter.id);
    if (cached && now - cached.at < DETECT_CACHE_MS) {
      results.push({ id: adapter.id, availability: cached.availability });
      continue;
    }
    const availability = await adapter.detect();
    detectCache.set(adapter.id, { availability, at: now });
    results.push({ id: adapter.id, availability });
  }
  return results;
}

// Test-only: clears every registered adapter and its cache so a suite can
// start from a known-empty registry instead of accumulating adapters
// registered by earlier tests in the same file.
export function clearRegistryForTests(): void {
  adapters.clear();
  detectCache.clear();
}
