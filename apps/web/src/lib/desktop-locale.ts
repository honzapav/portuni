// Tells the desktop shell the UI language (`set_ui_locale`, #540): Rust keeps
// one app-wide language, following the focused window, for the native menu
// and the sign-in loopback pages. Sent after boot, on every language change
// and whenever this window gains focus. Fire and forget: a failure only logs.
// Loaded lazily from i18n.ts so the main chunk does not grow.

import type { i18n as I18n } from "i18next";
import { isTauri } from "./backend-url";
import { toRequestLocale } from "./locale";
import { invoke } from "./tauri-invoke";

export function startDesktopLocaleSync(i18n: I18n): void {
  if (!isTauri()) return;
  const send = () => {
    invoke("set_ui_locale", { locale: toRequestLocale(i18n.language) }).catch((e: unknown) => {
      console.error("[i18n] set_ui_locale failed:", e);
    });
  };
  send();
  i18n.on("languageChanged", send);
  window.addEventListener("focus", send);
}
