// Per-path tracker for background pushes that outlive the response that
// started them (central mode's POST /nodes/:id/files answers before its
// storeFileCentral upload lands, deliberately). Any later mutation of the
// same path must awaitPendingPush first, or the delayed adapter.put can
// land after the record is gone -- deleted, moved, renamed -- and resurrect
// it as an orphan.
//
// Both dispatchers share this one map: agent-router.ts's REST handlers and
// agent-transport.ts's MCP proxied mutations. Keyed by this device's own
// local absolute path.
const pendingPushes = new Map<string, Promise<void>>();

export function trackPendingPush(localPath: string, push: Promise<void>): void {
  pendingPushes.set(localPath, push);
}

// Call from the tracked promise's own .finally(): only clears the entry if
// it is still the SAME promise (a newer push for the same path may have
// already replaced it).
export function clearPendingPushIfCurrent(localPath: string, push: Promise<void>): void {
  if (pendingPushes.get(localPath) === push) pendingPushes.delete(localPath);
}

export async function awaitPendingPush(localPath: string): Promise<void> {
  const p = pendingPushes.get(localPath);
  if (p) await p;
}
