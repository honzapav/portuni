// Shared by every "delete confirmed on the remote, now clean up this
// device's own copy" path (engine-mutations.ts's deleteFile, pending-ops.ts's
// runDelete retry, and the central-mode counterparts in agent-router.ts /
// agent-tools.ts) -- #275.
//
// file_state.last_synced_hash is the ONLY thing that lets a later sync
// run's tombstone cleanup (matchDeleteTombstones + cleanupDeletedRemote,
// engine.ts / engine-central.ts) recognize a leftover local file as "this
// exact confirmed deletion" rather than brand-new content to adopt and push
// back. Every one of the four callers used to remove the local file
// best-effort (rm force:true, swallowing any error) and then unconditionally
// delete file_state regardless of whether the rm actually succeeded -- a
// permission error, a transient fs failure, or (for the retry path) simply
// never having attempted the rm at all left the local copy on disk with its
// identity proof gone. The very next sync's discovery scan then read it as
// untracked new content, adopted it, and pushed it back -- silently undoing
// a confirmed deletion.
//
// This is the fix: only clear file_state once local absence is actually
// confirmed (the rm succeeded, or the path was already gone -- rm's own
// force:true already treats ENOENT as success, not an error). On any other
// failure, file_state stays intact and the leftover copy is picked up by
// the next deliberate sync's tombstone cleanup automatically -- no separate
// retry queue needed, since that cleanup pass already runs unconditionally
// on every sync run.

import { deleteFileState } from "./local-db.js";

export async function removeLocalCopyAndState(
  localPath: string | null,
  fileId: string,
): Promise<{ localRemoved: boolean }> {
  let localRemoved = true;
  if (localPath) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(localPath, { force: true });
    } catch {
      localRemoved = false;
    }
  }
  if (localRemoved) {
    await deleteFileState(fileId).catch(() => undefined);
  }
  return { localRemoved };
}
