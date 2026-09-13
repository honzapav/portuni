// Showtime decks in Portuni. A `.showtime` file is a zip Showtime renders;
// Portuni shows the `preview.html` Showtime packs into it (the server unzips
// that one entry for GET /nodes/:id/file, the desktop's portuni-html protocol
// does the same from disk) and, on the desktop, hands the bundle to the
// installed Showtime.app together with the node it belongs to.
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

// „Otevřít v Showtime": the desktop mints a one-time handoff code on the
// sidecar (with the token the host already holds, never through this
// webview) and opens the deck through the showtime://open deep link, so the
// agent Showtime starts beside the deck is a Portuni session on this node.
// Rejects with a message to show inline: the sidecar refused the handoff,
// the path is out of scope, or the installed Showtime has no deep link.
export async function openInShowtime(nodeId: string, path: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("open_in_showtime", { nodeId, path });
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
  }
}

// „Nová prezentace": the desktop mints a one-time handoff code on the sidecar
// and opens Showtime's New Deck screen through the showtime://new deep link
// with the node's wip/ directory, so the deck Showtime creates there is this
// node's and the agent beside it is a session on it. Rejects with a message
// to show inline: the node has no mirror here, the sidecar refused the
// handoff, or the installed Showtime has no `new` action.
export async function newInShowtime(nodeId: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("new_in_showtime", { nodeId });
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
  }
}
