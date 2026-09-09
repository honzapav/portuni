// Shared by every "the remote delete is confirmed, now remove this
// device's own copy" path: engine-mutations.ts's deleteFile, pending-ops.ts's
// runDelete retry, and the central-mode counterparts in agent-router.ts and
// agent-tools.ts.
//
// file_state.last_synced_hash is the only thing that lets a later sync run's
// tombstone cleanup (matchDeleteTombstones + cleanupDeletedRemote) recognize
// a leftover local file as this exact confirmed deletion rather than new
// content to adopt and push back. So file_state is cleared ONLY once local
// absence is confirmed -- the rm succeeded, or the path was already gone
// (rm's force:true treats ENOENT as success). On any other failure it stays,
// and the next sync's cleanup pass -- which runs unconditionally -- finishes
// the job; no separate retry queue is needed.

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
