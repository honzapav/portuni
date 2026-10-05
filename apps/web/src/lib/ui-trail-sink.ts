// Where the UI trail's failure flushes go (#573). In the desktop app the
// `log_ui_trail` command writes them through the host's logger (target
// `ui`) into sidecar.log, next to the host's and the sidecar's own lines;
// in the browser build (Vite dev) they go to console.error only.

import { isTauri } from "./backend-url";
import { invoke } from "./tauri-invoke";
import { setTrailFlusher, uiTrail } from "./ui-trail";

export function installTrailFlusher(): void {
  setTrailFlusher((lines) => {
    if (isTauri()) {
      // A failed write goes to the console only: reporting it as an error
      // would record (and flush) again.
      invoke("log_ui_trail", { lines }).catch((err: unknown) => {
        console.error("[ui-trail] writing to the log failed", err);
      });
      return;
    }
    console.error(`[ui-trail]\n${lines.join("\n")}`);
  });
}

// A `view` entry for the URL state the app just wrote with
// history.replaceState (view, node id, settings tab).
export function recordView(url: URL): void {
  uiTrail.record({ kind: "view", url: `${url.pathname}${url.search}` });
}
