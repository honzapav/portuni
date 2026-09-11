import type { SyncClass } from "../types.js";

// What the Synchronizovat button is allowed to do, counted from the same badge
// map the rows render from, so the button can never disagree with them.
//
// `remote_missing` is the subtle one. It counts toward neither `pending` nor
// `conflicts` -- a run used to neither push nor pull it, so putting it in
// either made an indicator that could never clear. But a central-mode run now
// opens with a reconcile pass (resolveUnknownRemotes) whose entire job is
// these records: a missing remote hash means UNKNOWN, and the pass is the only
// thing that ever asks. Leaving it out of the ENABLE condition therefore
// disabled the one button that could fix them -- the node read "Vše
// synchronizováno" while three files had never had their remote state
// established, and there was no way to start a run at all.
//
// So it stays out of the counts that drive labels and badges (an object that
// is genuinely gone must not produce a permanent red pill) and goes into
// `canRun` only.
export interface SyncBarState {
  pending: number;
  conflicts: number;
  deletedLocal: number;
  remoteMissing: number;
  // Nothing for a run to do AND nothing for a human to decide.
  noWork: boolean;
  // Something a run would act on or at least verify.
  canRun: boolean;
}

export function syncBarState(
  classes: Iterable<SyncClass>,
  statusLoaded: boolean,
): SyncBarState {
  let pending = 0;
  let conflicts = 0;
  let deletedLocal = 0;
  let remoteMissing = 0;
  for (const c of classes) {
    if (c === "push" || c === "pull") pending++;
    else if (c === "deleted_local") deletedLocal++;
    else if (c === "conflict") conflicts++;
    else if (c === "remote_missing") remoteMissing++;
  }
  const idle = pending === 0 && conflicts === 0 && remoteMissing === 0;
  return {
    pending,
    conflicts,
    deletedLocal,
    remoteMissing,
    noWork: statusLoaded && idle,
    canRun: !statusLoaded || !idle,
  };
}
