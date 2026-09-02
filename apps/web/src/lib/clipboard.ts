// Copy text to the clipboard. In the Tauri webview navigator.clipboard
// rejects with NotAllowedError whenever WebKit withholds user activation
// (tauri:// origin, click into an unfocused window), so the desktop build
// goes through the native `copy_text` command (apps/desktop/src/lib.rs).
// Browser builds use navigator.clipboard. Rejects when neither path works;
// callers decide how to surface that.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./backend-url";

export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke("copy_text", { text });
      return;
    } catch (err) {
      console.error("copy_text command failed, falling back to navigator.clipboard", err);
    }
  }
  await navigator.clipboard.writeText(text);
}
