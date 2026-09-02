// Showtime decks in Portuni. A `.showtime` file is a zip Showtime renders;
// Portuni shows the `preview.html` Showtime packs into it (the server unzips
// that one entry for GET /nodes/:id/file, the desktop's portuni-html protocol
// does the same from disk) and, on the desktop, hands the bundle to the
// installed Showtime.app.
import { isTauri } from "./backend-url";

export function isShowtimePath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(".showtime");
}

// Whether Showtime.app is installed on this machine. One `stat` in Rust,
// asked once per session -- the answer does not change while the app runs,
// and the button that depends on it is drawn on every preview.
let installed: Promise<boolean> | null = null;

export function showtimeInstalled(): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  if (!installed) {
    installed = import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("showtime_installed"))
      .catch((e) => {
        console.error("[showtime] showtime_installed failed:", e);
        return false;
      });
  }
  return installed;
}
