import type { SyncRunResponse } from "../types.js";

export interface SyncRunOutcome {
  text: string;
  hasError: boolean;
  detail: string | null;
}

// One line describing ONE sync run, shown next to the Synchronizovat button.
//
// A clean outcome fades after a few seconds. One that reports a failure stays
// until something changes, so what went wrong is not gone from the screen
// after five seconds (#267).
//
// That split is why the line must not carry live state. `conflicts` and
// `deleted_local` have their own pills next to the button, kept current by
// the status map; repeating them here was fine only while the line always
// faded. On a sticky line they freeze at the numbers the run happened to see
// and keep claiming "2 konflikty" after the user has resolved both -- the
// pill next to them already says zero. So a sticky line reports only what
// the RUN did and what it could not finish; the live counts stay with the
// pills that actually track them.
export function summarizeSyncRun(result: SyncRunResponse): SyncRunOutcome {
  const hasError =
    result.errors.length > 0 ||
    result.sweep_errors.length > 0 ||
    result.pending_repairs.length > 0;

  const parts: string[] = [];
  if (result.pushed.length > 0) parts.push(`Push ${result.pushed.length}`);
  if (result.pulled.length > 0) parts.push(`Pull ${result.pulled.length}`);
  if (result.adopted.length > 0) parts.push(`Zaregistrováno ${result.adopted.length}`);
  if (result.adopted_remote.length > 0) {
    parts.push(`Nové z remote ${result.adopted_remote.length}`);
  }
  // Live state: only on a line that is about to fade anyway.
  if (!hasError) {
    if (result.conflicts.length > 0) {
      parts.push(`${result.conflicts.length} konflikt${result.conflicts.length === 1 ? "" : "y"}`);
    }
    if (result.deleted_local.length > 0) {
      parts.push(`smazáno lokálně ${result.deleted_local.length}`);
    }
  }
  if (result.deleted_remote.length > 0) parts.push(`uklizeno ${result.deleted_remote.length}`);
  if (result.deleted_on_remote.length > 0) {
    parts.push(`smazáno na remote ${result.deleted_on_remote.length}`);
  }
  if (result.repaired.length > 0) parts.push(`opraveno ${result.repaired.length}`);
  if (result.pending_repairs.length > 0) {
    parts.push(`nedokončeno ${result.pending_repairs.length}`);
  }
  if (result.sweep_errors.length > 0) {
    parts.push(`kontrola remote selhala (${result.sweep_errors.length})`);
  }
  if (result.errors.length > 0) parts.push(`chyby ${result.errors.length}`);

  // Full per-item detail for the title tooltip: the line above is counts
  // only, and the sync-run errors that have no row of their own (sweep
  // errors are keyed by remote path) would otherwise be lost.
  const detail = [
    ...result.errors.map((e) => `${e.filename}: ${e.error}`),
    ...result.pending_repairs.map((p) => `${p.op} (${p.attempts}x): ${p.last_error ?? "?"}`),
    ...result.sweep_errors.map((e) => `${e.remote_path}: ${e.error}`),
  ];
  if (parts.length === 0) return { text: "Vše synchronizováno", hasError: false, detail: null };
  return { text: parts.join(" · "), hasError, detail: detail.length > 0 ? detail.join("\n") : null };
}
