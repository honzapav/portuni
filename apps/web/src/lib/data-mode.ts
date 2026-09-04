// Data mode (local vs central), split out of central.ts so it can be imported
// from non-React code.
//
// api.ts needs isCentralMode, and central.ts imports React for the
// useDataMode hook. Importing central.ts from api.ts therefore dragged React
// into every module that touches the API client -- including the server-side
// test files that import apps/web/src/lib/* through tsx, where React is not
// resolvable (it lives in apps/web/node_modules, and the root test runner has
// no reason to have it). This module stays React-free.

import { isTauri } from "./backend-url";

// Shape returned by the get_data_mode Tauri command.
export type DataMode = {
  mode: "local" | "central";
  server_url: string | null;
};

// Invoke get_data_mode; non-Tauri environments always return local mode.
export async function getDataMode(): Promise<DataMode> {
  if (!isTauri()) return { mode: "local", server_url: null };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DataMode>("get_data_mode");
}

// Module-level cache so all callers share one fetch per app lifetime.
// Resets on HMR in dev (module reload), which is fine.
let dataModeCache: DataMode | null = null;
let dataModePending: Promise<DataMode> | null = null;

export async function getDataModeCached(): Promise<DataMode> {
  if (dataModeCache) return dataModeCache;
  if (!dataModePending) {
    // On rejection, clear the pending slot so a later caller retries instead
    // of every future call resolving to the same cached rejection (e.g.
    // "config awaiting workspace migration" thrown before the migration
    // gate has run).
    dataModePending = getDataMode().then(
      (m) => {
        dataModeCache = m;
        return m;
      },
      (e) => {
        dataModePending = null;
        throw e;
      },
    );
  }
  return dataModePending;
}

// Cached, non-hook predicate for module-level code that needs the mode but
// cannot use the hook (api.ts). Shares the same one-fetch-per-lifetime cache,
// so this is an IPC call only on the very first use. A rejection (config
// awaiting workspace migration, non-Tauri host) reads as local mode -- the
// same optimistic default useDataMode leaves the UI in.
export async function isCentralMode(): Promise<boolean> {
  try {
    return (await getDataModeCached()).mode === "central";
  } catch {
    return false;
  }
}
