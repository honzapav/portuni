import type { TFunction } from "i18next";
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
// and keep claiming "2 conflicts" after the user has resolved both -- the
// pill next to them already says zero. So a sticky line reports only what
// the RUN did and what it could not finish; the live counts stay with the
// pills that actually track them.
export function summarizeSyncRun(result: SyncRunResponse, t: TFunction<"files">): SyncRunOutcome {
  const hasError =
    result.errors.length > 0 ||
    result.sweep_errors.length > 0 ||
    result.pending_repairs.length > 0;

  // Each part is a whole phrase of its own, a count with its plural forms;
  // the parts are a list of separate facts, not pieces of one sentence.
  const parts: string[] = [];
  const count = (n: number, render: (count: number) => string) => {
    if (n > 0) parts.push(render(n));
  };
  count(result.pushed.length, (n) => t(($) => $.sync_run.pushed, { ns: "files", count: n }));
  count(result.pulled.length, (n) => t(($) => $.sync_run.pulled, { ns: "files", count: n }));
  count(result.adopted.length, (n) => t(($) => $.sync_run.adopted, { ns: "files", count: n }));
  count(result.adopted_remote.length, (n) =>
    t(($) => $.sync_run.adopted_remote, { ns: "files", count: n }),
  );
  // Live state: only on a line that is about to fade anyway.
  if (!hasError) {
    count(result.conflicts.length, (n) => t(($) => $.sync_run.conflicts, { ns: "files", count: n }));
    count(result.deleted_local.length, (n) =>
      t(($) => $.sync_run.deleted_local, { ns: "files", count: n }),
    );
  }
  count(result.deleted_remote.length, (n) =>
    t(($) => $.sync_run.deleted_remote, { ns: "files", count: n }),
  );
  count(result.deleted_on_remote.length, (n) =>
    t(($) => $.sync_run.deleted_on_remote, { ns: "files", count: n }),
  );
  count(result.repaired.length, (n) => t(($) => $.sync_run.repaired, { ns: "files", count: n }));
  count(result.pending_repairs.length, (n) =>
    t(($) => $.sync_run.pending_repairs, { ns: "files", count: n }),
  );
  count(result.sweep_errors.length, (n) =>
    t(($) => $.sync_run.sweep_errors, { ns: "files", count: n }),
  );
  count(result.errors.length, (n) => t(($) => $.sync_run.errors, { ns: "files", count: n }));

  // Full per-item detail for the title tooltip: the line above is counts
  // only, and the sync-run errors that have no row of their own (sweep
  // errors are keyed by remote path) would otherwise be lost.
  const detail = [
    ...result.errors.map((e) => `${e.filename}: ${e.error}`),
    ...result.pending_repairs.map((p) => `${p.op} (${p.attempts}x): ${p.last_error ?? "?"}`),
    ...result.sweep_errors.map((e) => `${e.remote_path}: ${e.error}`),
  ];
  if (parts.length === 0) {
    return { text: t(($) => $.sync_run.all_synced, { ns: "files" }), hasError: false, detail: null };
  }
  return { text: parts.join(" · "), hasError, detail: detail.length > 0 ? detail.join("\n") : null };
}
