// Shared per-path "is a background push still in flight" tracker (#277
// finding 8, extracted from the module-local map #266's create fix
// originally kept private to agent-router.ts).
//
// Central mode's POST /nodes/:id/files answers before its background
// storeFileCentral push actually lands (the whole point of #266 -- the
// response must not wait on the Drive upload). Any OTHER mutation that
// touches the same local path afterwards must wait for that push to
// finish first, or the delayed adapter.put can land AFTER the record is
// already gone (deleted, moved, renamed) and resurrect it as an orphan --
// undoing a confirmed mutation exactly the way #275 described for the
// local-delete-vs-remote-delete race, just on the create/push side
// instead of the delete side.
//
// agent-router.ts's REST handlers (delete/resolve/rename) already awaited
// this via a module-local map; the gap #277 finding 8 identified is that
// agent-transport.ts's MCP proxied-mutation dispatch (portuni_delete_file /
// portuni_move_file proxying their record step straight to central) had no
// visibility into it at all, so the exact same race was reachable through
// the MCP tool path even though the REST path already guarded against it.
// Moving the map here so both dispatchers share one source of truth closes
// that gap without duplicating the tracking logic.
//
// Keyed by this device's own local absolute path -- stable identity
// regardless of which entry point is tracking or awaiting the push.
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
